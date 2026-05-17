import { createReadStream } from "node:fs";
import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Logger, ServiceContext } from "@bilibili-notify/internal";
import { z } from "zod";
import { LOG_LEVEL_RANK, LOG_LEVELS, type LogEntry, type LogLevel } from "../ws/types.js";

/**
 * jsonl-by-day log archive — the on-disk half of the Logs tab.
 *
 * Mirrors {@link HistoryStore}/{@link FansStore} layout: one append-only file
 * per day at `<dataDir>/logs/<YYYY-MM-DD>.jsonl`. Unlike those two, ingest is
 * BUFFERED — at a low `logArchiveFloor` (debug) entries can arrive dozens/sec
 * and a per-entry `await appendFile` would serialise I/O onto the business hot
 * path. Entries accumulate in memory and flush on a ~1s timer or when the
 * batch hits {@link MAX_BATCH}; a final flush runs on serviceCtx dispose /
 * SIGINT so a graceful shutdown never drops the tail.
 *
 * Floor gating is read live each ingest via `getFloor()` (same "no restart,
 * reconcile by reading the live value" contract as history retention) — no
 * config-changed subscription needed.
 *
 * Entries arrive ALREADY redacted (see logs/sink.ts) — this store never sees
 * cleartext secrets and performs no scrubbing itself.
 */

export const LOG_FLUSH_INTERVAL_MS = 1_000;
export const MAX_BATCH = 100;
const QUERY_CAP = 500;

/** Archived line shape. `args` kept as opaque JSON (already redacted). */
export const LogArchiveEntrySchema = z.object({
	ts: z.string(),
	level: z.enum(LOG_LEVELS),
	name: z.string().optional(),
	msg: z.string(),
	args: z.array(z.unknown()).optional(),
});
export type LogArchiveEntry = z.infer<typeof LogArchiveEntrySchema>;

export interface LogQuery {
	/** Restrict to a single `YYYY-MM-DD` day file (date picker). Omit = recent days, newest-first. */
	day?: string;
	/** Max rows, capped at 500 (mirrors history). */
	limit?: number;
}

export interface LogStore {
	/** Floor-gate + enqueue one entry. Non-blocking. */
	ingest(entry: LogEntry): void;
	/** Flush the in-memory buffer to disk now. Called by the timer + on dispose. */
	flush(): Promise<void>;
	/** Newest-first page across day files (or a single day). */
	query(opts: LogQuery): Promise<LogArchiveEntry[]>;
	/** Absolute path of a day's jsonl (for the raw-download route). */
	dayFilePath(day: string): string;
}

export interface CreateLogStoreOptions {
	dataDir: string;
	serviceCtx: ServiceContext;
	logger: Logger;
	/** Live archive floor (globals.app.logArchiveFloor). Read per ingest. */
	getFloor: () => LogLevel;
}

const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

export function createLogStore(opts: CreateLogStoreOptions): LogStore {
	const root = join(opts.dataDir, "logs");
	let ensured = false;
	let buffer: LogArchiveEntry[] = [];
	let flushing = false;

	async function ensureRoot(): Promise<void> {
		if (ensured) return;
		await mkdir(root, { recursive: true });
		ensured = true;
	}

	function dayOf(tsIso: string): string {
		// YYYY-MM-DDTHH:MM:SS.sssZ → YYYY-MM-DD; fall back to today on garbage ts.
		const d = tsIso.slice(0, 10);
		return DAY_FILE_RE.test(`${d}.jsonl`) ? d : new Date().toISOString().slice(0, 10);
	}

	function dayFilePath(day: string): string {
		return join(root, `${day}.jsonl`);
	}

	/** Stable single-line serialization that never throws (circular/huge args). */
	function lineFor(entry: LogArchiveEntry): string {
		try {
			return `${JSON.stringify(entry)}\n`;
		} catch {
			return `${JSON.stringify({ ...entry, args: ["[unserializable]"] })}\n`;
		}
	}

	async function flush(): Promise<void> {
		if (flushing || buffer.length === 0) return;
		flushing = true;
		const batch = buffer;
		buffer = [];
		try {
			await ensureRoot();
			// Group by day file so a flush spanning UTC midnight still lands right.
			const byDay = new Map<string, string[]>();
			for (const e of batch) {
				const day = dayOf(e.ts);
				const lines = byDay.get(day) ?? [];
				lines.push(lineFor(e));
				byDay.set(day, lines);
			}
			for (const [day, lines] of byDay) {
				try {
					await appendFile(dayFilePath(day), lines.join(""), "utf8");
				} catch (err) {
					// Best-effort: a failed flush drops that batch (logs are
					// non-critical). Warn so the operator notices disk problems.
					opts.logger.warn(`[log-store] flush ${day} failed: ${String(err)}`);
				}
			}
		} finally {
			flushing = false;
		}
	}

	function ingest(entry: LogEntry): void {
		if (LOG_LEVEL_RANK[entry.level] < LOG_LEVEL_RANK[opts.getFloor()]) return;
		const archived: LogArchiveEntry = {
			ts: entry.ts,
			level: entry.level,
			msg: entry.msg,
		};
		if (entry.name) archived.name = entry.name;
		if (entry.args.length > 0) archived.args = entry.args;
		buffer.push(archived);
		if (buffer.length >= MAX_BATCH) {
			void flush();
		}
	}

	async function readDayFile(path: string): Promise<LogArchiveEntry[]> {
		const out: LogArchiveEntry[] = [];
		try {
			const stream = createReadStream(path, { encoding: "utf8" });
			const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
			for await (const line of rl) {
				if (!line.trim()) continue;
				try {
					const parsed = LogArchiveEntrySchema.safeParse(JSON.parse(line));
					if (parsed.success) out.push(parsed.data);
				} catch {
					// skip malformed line
				}
			}
		} catch {
			// missing file = no rows for that day
		}
		return out;
	}

	async function query(q: LogQuery): Promise<LogArchiveEntry[]> {
		await ensureRoot();
		const limit = Math.min(Math.max(1, q.limit ?? 200), QUERY_CAP);
		// Pending-but-not-yet-flushed entries must be visible to the snapshot,
		// otherwise a page open right after a burst shows a hole the WS tail
		// already moved past. Newest-first overall.
		const pending = [...buffer].reverse();

		let files: string[];
		try {
			files = (await readdir(root))
				.filter((f) => DAY_FILE_RE.test(f))
				.sort()
				.reverse();
		} catch {
			files = [];
		}
		if (q.day) {
			const only = `${q.day}.jsonl`;
			files = files.filter((f) => f === only);
		}

		const out: LogArchiveEntry[] = [];
		const pushBounded = (e: LogArchiveEntry): boolean => {
			out.push(e);
			return out.length < limit;
		};
		// Live tail first (unless browsing a past day where buffer is irrelevant).
		if (!q.day) {
			for (const e of pending) if (!pushBounded(e)) return out;
		}
		for (const file of files) {
			const rows = await readDayFile(join(root, file));
			for (let i = rows.length - 1; i >= 0; i--) {
				const e = rows[i];
				if (!e) continue;
				if (!pushBounded(e)) return out;
			}
		}
		return out;
	}

	// ~1s flush cadence + final flush on graceful shutdown (the data-integrity
	// guarantee: a clean dispose/SIGINT never loses the unflushed tail).
	opts.serviceCtx.setInterval(() => {
		void flush();
	}, LOG_FLUSH_INTERVAL_MS);
	opts.serviceCtx.onDispose(async () => {
		await flush();
	});

	return { ingest, flush, query, dayFilePath };
}

/** Day-file names under `<dataDir>/logs`. Used by log retention. */
export async function listLogDayFiles(dataDir: string): Promise<string[]> {
	try {
		return (await readdir(join(dataDir, "logs"))).filter((f) => DAY_FILE_RE.test(f));
	} catch {
		return [];
	}
}

/** Delete one day file under `<dataDir>/logs`. Used by log retention. */
export async function deleteLogDayFile(dataDir: string, fileName: string): Promise<void> {
	await unlink(join(dataDir, "logs", fileName));
}
