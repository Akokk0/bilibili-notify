import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Disposable, Logger, ServiceContext } from "@bilibili-notify/internal";
import { atomicWriteJson } from "@bilibili-notify/storage";
import type { ConfigStore } from "../config/store.js";
import { dataPath } from "../runtime/roots.js";
import { createRepushStore, listRepushDays, type RepushStore } from "./repush-store.js";
import { deleteDayImages, listDayFiles } from "./store.js";

/**
 * 推送历史的保留(ADR-0022 决策 9):**文字不设上限,图与重推原件按天数清**。日文件一份都不删;
 * 到期的那几天,清掉它们引用的图和那几天的重推原件目录。
 *
 * 「清到哪一天」记成一条**水位线** `history/retention.json` 的 `clearedThrough`(UTC 日、含当天,只往前走):
 *
 * - 日文件永远在,不记的话每一轮都得把所有到期的日文件重新解析一遍,一年比一年慢;
 * - 面板上「图已清理」按它判。按行龄和当前天数现算的话,天数一调大,已经清掉的行就会说自己还有图。
 *
 * 重推原件(ADR-0017)跟着同一条水位线走,纯文字的原件也一样,不另开旋钮:「能不能补」只看原件在不在,
 * 和「图已清理」永远对得上。
 */

/** 水位线文件,住在 `history/` 底下:历史仓自己的账,跟着历史一起搬。 */
const RETENTION_MARK_FILE = "retention.json";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const markPath = (dataRoot: string): string =>
	join(dataPath(dataRoot, "history"), RETENTION_MARK_FILE);

/**
 * 图与重推原件清到哪一天(UTC 日、含当天)。还没清过、或者那份文件读不懂,回 `undefined` ——
 * 读不懂的当成没清过,下一轮清扫会照到期日重清一遍并写回好的。
 */
export async function readClearedThrough(dataRoot: string): Promise<string | undefined> {
	let text: string;
	try {
		text = await readFile(markPath(dataRoot), "utf8");
	} catch {
		return undefined;
	}
	try {
		const day = (JSON.parse(text) as { clearedThrough?: unknown } | null)?.clearedThrough;
		return typeof day === "string" && DAY.test(day) ? day : undefined;
	} catch {
		return undefined;
	}
}

/** 这一刻、保留 `retentionDays` 天时,最后一个到期的 UTC 日:截止日(往回数 `retentionDays` 天)的前一天。 */
function lastExpiredDay(now: Date, retentionDays: number): string {
	const day = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - retentionDays - 1),
	);
	return day.toISOString().slice(0, 10);
}

export interface HistorySweepOptions {
	/** 数据根:历史日文件、图、重推原件与水位线都在它底下。 */
	dataRoot: string;
	/** 图与重推原件留几天。 */
	retentionDays: number;
	/** 按哪一刻算到期。 */
	now: Date;
	logger: Logger;
	/** 重推原件。缺省自己建一个(它没有内部状态);注入口只留给测试。 */
	repush?: RepushStore;
}

export interface HistorySweepReport {
	/** 清完以后的水位线;一天都没清过就没有。 */
	clearedThrough?: string;
	/** 这一轮清了几天的图。 */
	imageDays: number;
	/** 这一轮清了几天的重推原件。 */
	snapshotDays: number;
}

/**
 * 清一轮:水位线之后、到期日及以前的那几天,删掉日文件引用的图与重推原件的日目录,再把水位线推到到期日。
 * 到期日不超过水位线(天数调大了、或者这一天已经清过)就什么都不做。
 *
 * 某一天清不动只记一条 warn、不拦别的日子,水位线照推:那一天剩下的图成了没人引用的孤儿,由图库的
 * 按引用清扫收走(⑳)。停在那一天不动的话,一份坏文件就能让整个保留期失效。
 */
export async function sweepHistoryRetention(
	opts: HistorySweepOptions,
): Promise<HistorySweepReport> {
	const target = lastExpiredDay(opts.now, opts.retentionDays);
	const mark = await readClearedThrough(opts.dataRoot);
	if (mark !== undefined && target <= mark) {
		return { clearedThrough: mark, imageDays: 0, snapshotDays: 0 };
	}

	let imageDays = 0;
	for (const file of (await listDayFiles(opts.dataRoot)).sort()) {
		const day = file.slice(0, 10);
		if (day > target || (mark !== undefined && day <= mark)) continue;
		try {
			await deleteDayImages(opts.dataRoot, file);
			imageDays += 1;
		} catch (err) {
			opts.logger.warn(`[history] failed to clear images of ${day}: ${String(err)}`);
		}
	}

	const repush = opts.repush ?? createRepushStore({ dataRoot: opts.dataRoot, logger: opts.logger });
	let snapshotDays = 0;
	for (const day of await listRepushDays(opts.dataRoot)) {
		if (day > target) continue;
		try {
			await repush.dropDay(day);
			snapshotDays += 1;
		} catch (err) {
			opts.logger.warn(`[history] failed to drop repush snapshots of ${day}: ${String(err)}`);
		}
	}

	await atomicWriteJson(markPath(opts.dataRoot), { clearedThrough: target });
	return { clearedThrough: target, imageDays, snapshotDays };
}

/**
 * 定时清扫。由服务端运行时的 ServiceContext 定时器驱动;每一轮都从 ConfigStore 现读保留天数,
 * 改了设置下一轮就生效,不用重启。
 */
export interface RetentionRunnerOptions {
	serviceCtx: ServiceContext;
	store: ConfigStore;
	/** 数据根:历史日文件与重推原件都在它底下。 */
	dataRoot: string;
	logger: Logger;
	/** Tick interval (ms). Defaults to 6 hours. */
	intervalMs?: number;
	/**
	 * 重推原件。**缺省自己建一个** —— 它没有内部状态,`dataRoot` 这儿本来就有,
	 * 于是「起 retention 时记得把 repush 传进来」这根会漏的线根本不存在。
	 * 注入口只留给测试。
	 */
	repush?: RepushStore;
	/** 此刻。缺省读系统时钟;注入口只留给测试。 */
	now?: () => Date;
}

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function startHistoryRetention(opts: RetentionRunnerOptions): Disposable {
	const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
	// 清理是删盘上的文件:登记进 track,关停等它删完再让各写道关门(关门之后不许再动数据目录)。
	const handle = opts.serviceCtx.setInterval(() => {
		opts.serviceCtx.track(
			runOnce(opts).catch((err) => {
				opts.logger.warn(`[history] retention pass failed: ${String(err)}`);
			}),
		);
	}, interval);
	// Run once on boot so we don't carry over stale state for hours.
	opts.serviceCtx.track(
		runOnce(opts).catch((err) => {
			opts.logger.warn(`[history] initial retention pass failed: ${String(err)}`);
		}),
	);
	return handle;
}

async function runOnce(opts: RetentionRunnerOptions): Promise<void> {
	const days = opts.store.getGlobals().app.historyRetentionDays;
	if (!days || days <= 0) return;
	const report = await sweepHistoryRetention({
		dataRoot: opts.dataRoot,
		retentionDays: days,
		now: opts.now?.() ?? new Date(),
		logger: opts.logger,
		repush: opts.repush,
	});
	if (report.imageDays > 0 || report.snapshotDays > 0) {
		opts.logger.info(
			`[history] retention cleared images of ${report.imageDays} day(s) and repush snapshots of ${report.snapshotDays} day(s) through ${report.clearedThrough}`,
		);
	}
}
