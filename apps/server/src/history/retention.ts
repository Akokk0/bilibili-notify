import type { Disposable, Logger, ServiceContext } from "@bilibili-notify/internal";
import type { ConfigStore } from "../config/store.js";
import { deleteDayFile, listDayFiles } from "./store.js";

/**
 * Daily retention pass — drops history jsonl files older than
 * `globals.app.historyRetentionDays`. Driven by the standalone runtime's
 * ServiceContext interval; reads the live retention horizon from ConfigStore
 * each tick so config changes apply on the next pass without restart.
 */
export interface RetentionRunnerOptions {
	serviceCtx: ServiceContext;
	store: ConfigStore;
	logger: Logger;
	/** Tick interval (ms). Defaults to 6 hours. */
	intervalMs?: number;
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
}
