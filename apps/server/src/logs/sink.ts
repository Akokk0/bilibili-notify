import type { LogChannel } from "../ws/log-channel.js";
import type { LogEntry } from "../ws/types.js";
import type { LogStore } from "./store.js";

/**
 * The single log fan-out point installed via `serviceCtx.setLogHook`.
 *
 * Contract: tee the SAME entry two ways —
 *   1. the in-memory ring → WS `log` channel (live tail, ALL levels)
 *   2. the on-disk LogStore (archive, floor-gated inside `ingest`)
 *
 * 不在这里打码:entry 到这一步已经在日志调用入口(`wrapLogger`)打过码,
 * stdout / 环形缓冲 / 归档三处出口共用那一份。「secret 进 → 三处都打码」的守卫在
 * runtime/__tests__/service-context-redaction.test.ts。
 */
export function createLogSink(deps: {
	ring: LogChannel;
	store: LogStore;
}): (entry: LogEntry) => void {
	return (entry: LogEntry) => {
		deps.ring.push(entry);
		deps.store.ingest(entry);
	};
}
