import type { LogEntry } from "./types.js";

/**
 * Small in-memory ring buffer for `log` channel entries.
 *
 * Stage 2.3 keeps the contract simple: every `logger.<level>(...)` call from
 * `NodeServiceContext` lands here via `push(entry)`. We expose:
 *  - `subscribe(handler)` for the WS layer to receive new entries live
 *  - `latest()` for the WS layer to optionally hydrate a freshly-subscribed
 *    client with a recent backlog (NOT wired into `state` hydration; the
 *    backlog is opt-in per channel and stage 3 dashboards will request it
 *    explicitly via REST when needed)
 *
 * The buffer is intentionally small (default 200 entries) — this is a
 * recent-warnings tap, not a log archive.
 */

export interface LogChannel {
	push(entry: LogEntry): void;
	subscribe(handler: (entry: LogEntry) => void): () => void;
	latest(): readonly LogEntry[];
}

export interface LogChannelOptions {
	bufferSize?: number;
}

export function createLogChannel(opts: LogChannelOptions = {}): LogChannel {
	const cap = Math.max(1, opts.bufferSize ?? 200);
	const ring: LogEntry[] = [];
	const subs = new Set<(entry: LogEntry) => void>();

	return {
		push(entry) {
			ring.push(entry);
			if (ring.length > cap) ring.shift();
			for (const h of [...subs]) {
				try {
					h(entry);
				} catch {
					// One subscriber must never break delivery to others.
				}
			}
		},
		subscribe(handler) {
			subs.add(handler);
			return () => {
				subs.delete(handler);
			};
		},
		latest() {
			return ring.slice();
		},
	};
}
