import type { Disposable, Logger, ServiceContext } from "@bilibili-notify/internal";
import type { ConfigStore } from "../config/store.js";
import { createRepushStore, listRepushDays, type RepushStore } from "./repush-store.js";
import { deleteDayFile, listDayFiles } from "./store.js";

/**
 * Daily retention pass — drops history jsonl files older than
 * `globals.app.historyRetentionDays`. Driven by the standalone runtime's
 * ServiceContext interval; reads the live retention horizon from ConfigStore
 * each tick so config changes apply on the next pass without restart.
 *
 * 重推原件(ADR-0017)跟着**同一个 cutoff** 走,不另开旋钮 ——「历史还在 = 还能重推」
 * 是最省解释的心智,而原件比历史活得久也没有意义:行都不在了,按钮无从长出来,留下的
 * 只是盘上一份谁都读不到的推送内容。两处各扫各的:原件的日目录不依赖日文件还在不在。
 */
export interface RetentionRunnerOptions {
	serviceCtx: ServiceContext;
	store: ConfigStore;
	logger: Logger;
	/** Tick interval (ms). Defaults to 6 hours. */
	intervalMs?: number;
	/**
	 * 重推原件。**缺省自己建一个** —— 它没有内部状态,`dataDir` 这儿本来就有,
	 * 于是「起 retention 时记得把 repush 传进来」这根会漏的线根本不存在。
	 * 注入口只留给测试。
	 */
	repush?: RepushStore;
}

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function startHistoryRetention(opts: RetentionRunnerOptions): Disposable {
	const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
	const handle = opts.serviceCtx.setInterval(() => {
		void runOnce(opts).catch((err) => {
			opts.logger.warn(`[history] retention pass failed: ${String(err)}`);
		});
	}, interval);
	// Run once on boot so we don't carry over stale state for hours.
	void runOnce(opts).catch((err) => {
		opts.logger.warn(`[history] initial retention pass failed: ${String(err)}`);
	});
	return handle;
}

async function runOnce(opts: RetentionRunnerOptions): Promise<void> {
	const days = opts.store.getGlobals().app.historyRetentionDays;
	if (!days || days <= 0) return;
	const cutoff = new Date();
	cutoff.setUTCDate(cutoff.getUTCDate() - days);
	const cutoffStr = cutoff.toISOString().slice(0, 10);
	const files = await listDayFiles(opts.store.bootstrap.dataDir);
	let deleted = 0;
	for (const f of files) {
		const date = f.slice(0, 10);
		if (date < cutoffStr) {
			try {
				await deleteDayFile(opts.store.bootstrap.dataDir, f);
				deleted++;
			} catch (err) {
				opts.logger.warn(`[history] failed to delete ${f}: ${String(err)}`);
			}
		}
	}
	if (deleted > 0) {
		opts.logger.info(`[history] retention dropped ${deleted} day file(s) older than ${cutoffStr}`);
	}
	const repush =
		opts.repush ??
		createRepushStore({ dataDir: opts.store.bootstrap.dataDir, logger: opts.logger });
	let draftDays = 0;
	for (const day of await listRepushDays(opts.store.bootstrap.dataDir)) {
		if (day >= cutoffStr) continue;
		try {
			await repush.dropDay(day);
			draftDays++;
		} catch (err) {
			opts.logger.warn(`[history] failed to drop repush drafts for ${day}: ${String(err)}`);
		}
	}
	if (draftDays > 0) {
		opts.logger.info(`[history] retention dropped repush drafts for ${draftDays} day(s)`);
	}
}
