import type { LogChannel } from "../ws/log-channel.js";
import type { LogEntry } from "../ws/types.js";
import { redactLogEntry } from "./redact.js";
import type { LogStore } from "./store.js";

/**
 * The single log fan-out point installed via `serviceCtx.setLogHook`.
 *
 * Contract (grilled spec, decision 6): scrub ONCE, then tee the SAME redacted
 * entry two ways —
 *   1. the in-memory ring → WS `log` channel (live tail, ALL levels)
 *   2. the on-disk LogStore (archive, floor-gated inside `ingest`)
 *
 * Redacting here (not in each sink) guarantees both halves are clean and that
 * cleartext never exists past this boundary. Extracted as a pure factory so
 * the security guard can assert "secret in → masked in BOTH sinks".
 */
export function createLogSink(deps: {
	ring: LogChannel;
	store: LogStore;
	redact?: (e: LogEntry) => LogEntry;
}): (entry: LogEntry) => void {
	const redact = deps.redact ?? redactLogEntry;
	return (entry: LogEntry) => {
		const safe = redact(entry);
		deps.ring.push(safe);
		deps.store.ingest(safe);
	};
}
