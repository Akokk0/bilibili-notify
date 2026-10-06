import { createReadStream } from "node:fs";
import { mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { LogArchiveEntry } from "@bilibili-notify/contract";
import type { Logger, ServiceContext } from "@bilibili-notify/internal";
import { appendLines } from "@bilibili-notify/storage";
import { z } from "zod";
import { hostPath } from "../runtime/roots.js";
import { LOG_LEVELS, type LogEntry } from "../ws/types.js";

/**
 * jsonl-by-day log archive — the on-disk half of the Logs tab.
 *
 * Mirrors {@link HistoryStore}/{@link FollowersStore} layout: one append-only file
 * per day at `<hostRoot>/logs/<YYYY-MM-DD>.jsonl`. Unlike those two, ingest is
 * BUFFERED — when a module is cranked to `debug` entries can arrive dozens/sec
 * and a per-entry `await appendFile` would serialise I/O onto the business hot
 * path. Entries accumulate in memory and flush on a ~1s timer or when the
 * batch hits {@link MAX_BATCH}; a final flush runs on serviceCtx dispose /
 * SIGINT so a graceful shutdown never drops the tail. The final flush first waits
 * for the write already in flight, then writes whatever piled up behind it, and
 * only then closes the door: entries arriving afterwards go to stdout (pino) only.
 *
 * Level gating happens UPSTREAM in service-context.ts `fanOut`
 * (`target.isLevelEnabled`), so every entry reaching `ingest` is already past
 * its module's live level — the store writes whatever it is given (no floor;
 * Tab live == archive == console, all driven by the per-module pino level).
 *
 * Entries arrive ALREADY redacted (see logs/sink.ts) — this store never sees
 * cleartext secrets and performs no scrubbing itself.
 */

const LOG_FLUSH_INTERVAL_MS = 1_000;
export const MAX_BATCH = 100;
const QUERY_CAP = 500;

/**
 * Archived line shape. `args` kept as opaque JSON (already redacted).
 * 类型本体在 `@bilibili-notify/contract`(web 同源消费);`z.ZodType` 注解把本
 * schema 的 parse 输出钉死在契约类型上,两边漂移会在编译期报错。
 */
const LogArchiveEntrySchema: z.ZodType<LogArchiveEntry> = z.object({
	ts: z.string(),
	level: z.enum(LOG_LEVELS),
	name: z.string().optional(),
	msg: z.string(),
	args: z.array(z.unknown()).optional(),
});

interface LogQuery {
	/** Restrict to a single `YYYY-MM-DD` day file (date picker). Omit = recent days, newest-first. */
	day?: string;
	/** Max rows, capped at 500 (mirrors history). */
	limit?: number;
}

export interface LogStore {
	/** Enqueue one entry. Non-blocking. */
	ingest(entry: LogEntry): void;
	/**
	 * Flush the in-memory buffer to disk now. Called by the timer + on dispose. A flush that
	 * finds one already in flight joins it (resolves when that one is on disk) instead of
	 * starting a second; entries buffered after the in-flight batch was taken wait for the next.
	 */
	flush(): Promise<void>;
	/** Newest-first page across day files (or a single day). */
	query(opts: LogQuery): Promise<LogArchiveEntry[]>;
	/** Absolute path of a day's jsonl (for the raw-download route). */
	dayFilePath(day: string): string;
}

export interface CreateLogStoreOptions {
	/** 宿主根:日志 `logs/` 是宿主件,冻住的桌面壳认这个位置,不随数据代走。 */
	hostRoot: string;
	serviceCtx: ServiceContext;
	logger: Logger;
}

const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

export function createLogStore(opts: CreateLogStoreOptions): LogStore {
	const root = hostPath(opts.hostRoot, "logs");
	let ensured = false;
	let buffer: LogArchiveEntry[] = [];
	/** 正在写盘的那一次;没有就是 undefined。 */
	let inflight: Promise<void> | undefined;
	/** 最终落盘之后关门:再来的条目只到 stdout,不缓冲、不写盘。 */
	let closed = false;
	/** 上一次记过的「建不出日志目录」的错(按错误码认)。同一个错只记一行,见 {@link writeBatch}。 */
	let rootError: string | undefined;

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

	/**
	 * Stable single-line serialization that never throws (circular/huge args). No trailing
	 * newline: `appendLines` adds it. The line format is frozen (see store.test.ts).
	 */
	function lineFor(entry: LogArchiveEntry): string {
		try {
			return JSON.stringify(entry);
		} catch {
			return JSON.stringify({ ...entry, args: ["[unserializable]"] });
		}
	}

	function flush(): Promise<void> {
		if (inflight) return inflight;
		if (buffer.length === 0) return Promise.resolve();
		const batch = buffer;
		buffer = [];
		const writing = writeBatch(batch).finally(() => {
			inflight = undefined;
		});
		inflight = writing;
		return writing;
	}

	async function writeBatch(batch: readonly LogArchiveEntry[]): Promise<void> {
		try {
			await ensureRoot();
			rootError = undefined;
		} catch (err) {
			// 建不出日志目录(只读挂载、权限、被同名文件占了):这一批丢掉,与下面某天的文件写不进去同一个口径
			// (日志是非关键的)。以前这里的拒绝没人接,是一次 unhandledRejection。
			//
			// 🔴 **同一个错只记一行。** 这条 warn 自己会经日志 hook 回到本仓的缓冲,下一次落盘同样建不出目录的话
			// 又是一条 warn、又回到缓冲……关停时的最终落盘(`finish`)「缓冲非空就再落一次」,会被它拖成死循环。
			const { code, syscall } = err as NodeJS.ErrnoException;
			const key = code ? `${code}:${syscall ?? ""}` : String(err);
			if (key !== rootError) {
				rootError = key;
				opts.logger.warn(`[log-store] 建不出日志目录 ${root}，这一批日志丢掉: ${String(err)}`);
			}
			return;
		}
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
				await appendLines(dayFilePath(day), lines);
			} catch (err) {
				// Best-effort: a failed flush drops that batch (logs are
				// non-critical). Warn so the operator notices disk problems.
				opts.logger.warn(`[log-store] flush ${day} failed: ${String(err)}`);
			}
		}
	}

	/**
	 * 关停时的最终落盘:先等在途的那次,再把它落盘期间与之后攒下的写完,最后关门。
	 * (在途那次不等的话,它在关停返回之后才落盘,而它之后进缓冲的条目也就此丢了。)
	 */
	async function finish(): Promise<void> {
		try {
			while (inflight || buffer.length > 0) await flush();
		} finally {
			closed = true;
		}
	}

	function ingest(entry: LogEntry): void {
		if (closed) return;
		const archived: LogArchiveEntry = {
			ts: entry.ts,
			level: entry.level,
			msg: entry.msg,
		};
		if (entry.name) archived.name = entry.name;
		if (entry.args.length > 0) archived.args = entry.args;
		buffer.push(archived);
		if (buffer.length >= MAX_BATCH) trackFlush();
	}

	/**
	 * 落盘发出去不等,但登记进 track:关停得等这一批交进盘再往下走。`flush` 自己接住了失败,不会拒。
	 * (最终落盘 `finish` 在 dispose 段,会再等一遍在途的,这里是让 flush 之前的等待也看得见它。)
	 */
	function trackFlush(): void {
		opts.serviceCtx.track(flush());
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
	opts.serviceCtx.setInterval(trackFlush, LOG_FLUSH_INTERVAL_MS);
	// 最后一段(`dispose`)里最早登记的,所以最后跑:关停期各段打的日志都赶得上这一次落盘。
	opts.serviceCtx.onDispose(finish);

	return { ingest, flush, query, dayFilePath };
}

/** Day-file names under `<hostRoot>/logs`. Used by log retention. */
export async function listLogDayFiles(hostRoot: string): Promise<string[]> {
	try {
		return (await readdir(hostPath(hostRoot, "logs"))).filter((f) => DAY_FILE_RE.test(f));
	} catch {
		return [];
	}
}

/** Delete one day file under `<hostRoot>/logs`. Used by log retention. */
export async function deleteLogDayFile(hostRoot: string, fileName: string): Promise<void> {
	await unlink(hostPath(hostRoot, "logs", fileName));
}
