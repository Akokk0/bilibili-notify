import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Disposable, ImageRef, Logger, ServiceContext } from "@bilibili-notify/internal";
import { atomicWriteJson } from "@bilibili-notify/storage";
import type { ConfigStore } from "../config/store.js";
import { logText } from "../i18n/index.js";
import type { ImageStore } from "../images/image-store.js";
import { dataPath } from "../runtime/roots.js";
import { dropRepushDay, listRepushDays } from "./repush-store.js";
import { collectImageRefs, listDayFiles } from "./store.js";

/**
 * 推送历史的保留(ADR-0022 决策 9):**文字不设上限,图与重推原件按天数清**。日文件一份都不删;
 * 到期的那几天,清掉那几天的重推原件目录 —— 图在图库里,**不由这里删**:历史行只在保留期内算图库的引用方
 * ({@link listHistoryImageRefs}),水位线一推过去,那几天的行就不再留住它们的图,同一轮末尾的图库清扫按引用把
 * 没人引用的收走。
 *
 * 「清到哪一天」记成一条**水位线** `history/retention.json` 的 `clearedThrough`(UTC 日、含当天,只往前走):
 *
 * - 日文件永远在,不记的话每一轮都得把所有到期的日文件重新解析一遍,一年比一年慢;
 * - 面板上「图已清理」按它判。按行龄和当前天数现算的话,天数一调大,已经清掉的行就会说自己还有图;
 * - 历史这一家引用方只读水位线之后的日文件。
 *
 * 重推原件(ADR-0017)跟着同一条水位线走,纯文字的原件也一样,不另开旋钮:「能不能补」只看原件在不在,
 * 和「图已清理」永远对得上。
 */

/** 水位线文件,住在 `history/` 底下:历史仓自己的账,跟着历史一起搬。 */
const RETENTION_MARK_FILE = "retention.json";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const retentionMarkPath = (dataRoot: string): string =>
	join(dataPath(dataRoot, "history"), RETENTION_MARK_FILE);

/**
 * 图与重推原件清到哪一天(UTC 日、含当天)。还没清过、或者那份文件读不懂,回 `undefined` ——
 * 读不懂的当成没清过,下一轮清扫会照到期日重清一遍并写回好的。
 */
export async function readClearedThrough(dataRoot: string): Promise<string | undefined> {
	let text: string;
	try {
		text = await readFile(retentionMarkPath(dataRoot), "utf8");
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

/**
 * 推送历史这一家图库引用方此刻活着的引用(图库登记用,`runtime/bootstrap.ts`):**保留期内**的日文件 ——
 * 水位线之后的 —— 里所有消息的 `image` 与行的 `avatarSnapshot`,本体行与补丁行都数。过了水位线的行不算:
 * 否则水位线白推,图永远清不掉。水位线不在或读不懂当成没清过(全算,宁多勿少)。读不动日文件就抛,
 * 图库清扫这一轮一张不删。
 */
export async function listHistoryImageRefs(dataRoot: string): Promise<ImageRef[]> {
	const mark = await readClearedThrough(dataRoot);
	const root = dataPath(dataRoot, "history");
	const out: ImageRef[] = [];
	for (const file of (await listDayFiles(dataRoot)).sort()) {
		if (mark !== undefined && file.slice(0, 10) <= mark) continue;
		out.push(...(await collectImageRefs(join(root, file))));
	}
	return out;
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
}

export interface HistorySweepReport {
	/** 清完以后的水位线;一天都没清过就没有。 */
	clearedThrough?: string;
	/** 这一轮清掉重推原件的那几天。 */
	snapshotDays: string[];
}

/**
 * 清一轮:水位线之后、到期日及以前的那几天,删掉重推原件的日目录,再把水位线推到到期日。**不碰图** ——
 * 水位线推过去以后,那几天的行不再是图库的引用方,图由紧接着的图库清扫收走。
 * 到期日不超过水位线(天数调大了、或者这一天已经清过)就什么都不做。
 *
 * 某一天清不动只记一条 warn、不拦别的日子,水位线照推:停在那一天不动的话,一份坏目录就能让整个保留期失效。
 */
export async function sweepHistoryRetention(
	opts: HistorySweepOptions,
): Promise<HistorySweepReport> {
	const target = lastExpiredDay(opts.now, opts.retentionDays);
	const mark = await readClearedThrough(opts.dataRoot);
	if (mark !== undefined && target <= mark) {
		return { clearedThrough: mark, snapshotDays: [] };
	}

	const snapshotDays: string[] = [];
	for (const day of (await listRepushDays(opts.dataRoot)).sort()) {
		if (day > target) continue;
		try {
			await dropRepushDay(opts.dataRoot, day);
			snapshotDays.push(day);
		} catch (err) {
			opts.logger.warn(logText("log.history.dropSnapshotsFailed"), { day, error: err });
		}
	}

	await atomicWriteJson(retentionMarkPath(opts.dataRoot), { clearedThrough: target });
	return { clearedThrough: target, snapshotDays };
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
	/**
	 * 图库:每一轮推完水位线紧接着清它(ADR-0022 决策 9 下 10-04「⑳ 开片」的 🔗)。先后是有讲究的 ——
	 * 过期的行不再算引用方,它们的图才清得掉;两个定时器各跑各的话,这个先后就靠碰运气。
	 */
	images: Pick<ImageStore, "sweep">;
	logger: Logger;
	/** Tick interval (ms). Defaults to 6 hours. */
	intervalMs?: number;
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
				opts.logger.warn(logText("log.history.retentionFailed"), { stage: "interval", error: err });
			}),
		);
	}, interval);
	// Run once on boot so we don't carry over stale state for hours.
	opts.serviceCtx.track(
		runOnce(opts).catch((err) => {
			opts.logger.warn(logText("log.history.retentionFailed"), { stage: "startup", error: err });
		}),
	);
	return handle;
}

async function runOnce(opts: RetentionRunnerOptions): Promise<void> {
	const now = opts.now?.() ?? new Date();
	try {
		const report = await sweepHistoryRetention({
			dataRoot: opts.dataRoot,
			retentionDays: opts.store.getGlobals().history.retentionDays,
			now,
			logger: opts.logger,
		});
		if (report.snapshotDays.length > 0) {
			opts.logger.info(logText("log.history.snapshotsCleared"), {
				days: report.snapshotDays.length,
				clearedThrough: report.clearedThrough,
			});
		}
	} finally {
		// 历史那半出了错图库也照清:图库里不止历史的图,聊天附件、头像不该等历史修好。
		await sweepImages(opts, now);
	}
}

/** 清图库一轮。清不动只记 warn —— 下一轮再来,别把历史那半的结果盖掉。 */
async function sweepImages(opts: RetentionRunnerOptions, now: Date): Promise<void> {
	try {
		const { removed } = await opts.images.sweep({ now });
		if (removed.length > 0) {
			opts.logger.info(logText("log.history.imagesRemoved"), { count: removed.length });
		}
	} catch (err) {
		opts.logger.warn(logText("log.history.imageSweepFailed"), { error: err });
	}
}
