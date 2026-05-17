import type { Disposable, Logger, ServiceContext } from "@bilibili-notify/internal";
import type { ConfigStore } from "../config/store.js";
import { deleteLogDayFile, listLogDayFiles } from "./store.js";

/**
 * Daily retention pass — drops log jsonl files older than
 * `globals.app.logRetentionDays`. Same shape as `startHistoryRetention`:
 * a ServiceContext interval reading the live horizon from ConfigStore each
 * tick, so a config change applies on the next pass without a restart.
 */
export interface LogRetentionRunnerOptions {
	serviceCtx: ServiceContext;
	store: ConfigStore;
	logger: Logger;
	/** Tick interval (ms). Defaults to 6 hours. */
	intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function startLogRetention(opts: LogRetentionRunnerOptions): Disposable {
	const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
	const handle = opts.serviceCtx.setInterval(() => {
		void runOnce(opts).catch((err) => {
			opts.logger.warn(`[log] retention pass failed: ${String(err)}`);
		});
	}, interval);
	void runOnce(opts).catch((err) => {
		opts.logger.warn(`[log] initial retention pass failed: ${String(err)}`);
	});
	return handle;
}

async function runOnce(opts: LogRetentionRunnerOptions): Promise<void> {
	const days = opts.store.getGlobals().app.logRetentionDays;
	if (!days || days <= 0) return;
	const cutoff = new Date();
	cutoff.setUTCDate(cutoff.getUTCDate() - days);
	const cutoffStr = cutoff.toISOString().slice(0, 10);
	const files = await listLogDayFiles(opts.store.bootstrap.dataDir);
	let deleted = 0;
	for (const f of files) {
		const date = f.slice(0, 10);
		if (date < cutoffStr) {
			try {
				await deleteLogDayFile(opts.store.bootstrap.dataDir, f);
				deleted++;
			} catch (err) {
				opts.logger.warn(`[log] failed to delete ${f}: ${String(err)}`);
			}
		}
	}
	if (deleted > 0) {
		opts.logger.info(`[log] retention dropped ${deleted} day file(s) older than ${cutoffStr}`);
	}
}
