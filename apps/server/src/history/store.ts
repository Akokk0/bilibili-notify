import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
	HistoryEntry,
	HistoryPayload,
	HistorySource,
	Logger,
	MessageBus,
	NotificationPayload,
} from "@bilibili-notify/internal";
import { HistoryEntrySchema } from "@bilibili-notify/internal";

/**
 * jsonl-by-day history persistence + bus emission.
 *
 * Each successful or failed sink dispatch produces a single {@link HistoryEntry}
 * appended to `<dataDir>/history/<YYYY-MM-DD>.jsonl`. After the append the
 * store emits `history-recorded` on the bus so the WS `push-events` channel
 * fans the entry out to connected dashboards.
 *
 * Image bytes are written to `<dataDir>/history/img/<entryId>.<ext>` with the
 * relative file name stored in `payload.imageRef`. The dashboard reads the
 * blob via the static fileserver mounted on `/history-img/*`.
 *
 * Append-only design — entries are never updated in place. The retention pass
 * (see `retention.ts`) drops day files older than the configured horizon.
 */

export interface HistoryAppendInput {
	source: HistorySource;
	uid: string;
	subscriptionId: string;
	targets: Array<{ targetId: string; ok: boolean; latencyMs: number; err?: string }>;
	payload: NotificationPayload;
	/** Snapshot of sub.cachedProfile.name at write time; survives订阅删除。 */
	unameSnapshot?: string;
	/** Snapshot of sub.cachedProfile.avatar at write time。 */
	uavatarSnapshot?: string;
}

export interface HistoryQuery {
	limit?: number;
	since?: string;
	source?: HistorySource;
	uid?: string;
}

export interface DailyAggregateOptions {
	/** 窗口天数(含今天),调用方负责 clamp。 */
	days: number;
	/**
	 * 客户端时区偏移,JS `Date.prototype.getTimezoneOffset()` 口径
	 * (分钟,UTC+8 → -480)。缺省 0 = UTC 日界。
	 */
	tzOffsetMin?: number;
	/** 注入时钟,测试用。 */
	now?: Date;
}

export interface DailyHistoryCount {
	/** 按 tzOffsetMin 口径的本地日 YYYY-MM-DD。 */
	d: string;
	counts: Record<HistorySource, number>;
	total: number;
	failures: number;
}

export interface HistoryStore {
	append(input: HistoryAppendInput): Promise<HistoryEntry>;
	query(opts: HistoryQuery): Promise<HistoryEntry[]>;
	aggregateDaily(opts: DailyAggregateOptions): Promise<DailyHistoryCount[]>;
	imageDir(): string;
}

const ALL_SOURCES = [
	"dynamic",
	"live",
	"sc",
	"guard",
	"special-danmaku",
	"special-enter",
	"live-summary",
] as const satisfies readonly HistorySource[];

function zeroCounts(): Record<HistorySource, number> {
	return Object.fromEntries(ALL_SOURCES.map((s) => [s, 0])) as Record<HistorySource, number>;
}

export interface CreateHistoryStoreOptions {
	dataDir: string;
	bus: MessageBus;
	logger: Logger;
}

export function createHistoryStore(opts: CreateHistoryStoreOptions): HistoryStore {
	const root = join(opts.dataDir, "history");
	const imgRoot = join(root, "img");

	async function ensureDirs(): Promise<void> {
		await mkdir(root, { recursive: true });
		await mkdir(imgRoot, { recursive: true });
	}

	function dayFile(dateIso: string): string {
		// YYYY-MM-DDTHH:MM:SS.sssZ → YYYY-MM-DD
		return join(root, `${dateIso.slice(0, 10)}.jsonl`);
	}

	async function writeImage(entryId: string, buffer: Buffer, mime: string): Promise<string> {
		const ext = mimeToExt(mime);
		const name = `${entryId}.${ext}`;
		await writeFile(join(imgRoot, name), buffer);
		return name;
	}

	async function reduce(
		payload: NotificationPayload,
		entryId: string,
		source: HistorySource,
	): Promise<HistoryPayload> {
		switch (payload.kind) {
			case "text":
				return { kind: "text", text: payload.text };
			case "image": {
				const imageRef = await writeImage(entryId, payload.image.buffer, payload.image.mime);
				// 纯图推送(无 caption)在 History 列表会落成「（无内容）」。此前只有直播
				// 词云会这样;消息版式支持把 card 拆成独立消息后,dynamic/live 的卡片图
				// 也会天然无 caption 单独成条 —— 统一给个可读摘要,而不是只特判词云。
				const text = payload.caption || (source === "live-summary" ? "[弹幕词云]" : "[卡片图]");
				return { kind: "image", text, imageRef };
			}
			case "forward-images":
				return {
					kind: "text",
					text: `[图集 ${payload.images.length} 张${payload.forward ? " · 合并转发" : ""}]`,
				};
			case "composite": {
				const textParts: string[] = [];
				let imageRef: string | undefined;
				let imageIdx = 0;
				for (const seg of payload.segments) {
					if (seg.type === "text") {
						textParts.push(seg.text);
					} else if (seg.type === "image" && !imageRef) {
						const name = `${entryId}-${imageIdx++}.${mimeToExt(seg.mime)}`;
						await writeFile(join(imgRoot, name), seg.buffer);
						imageRef = name;
					} else if (seg.type === "link") {
						textParts.push(seg.title ? `${seg.title} ${seg.href}` : seg.href);
					} else if (seg.type === "at-all") {
						// @全体 段无文字载体,但 History 需要可读标记,否则独立的 @全体 提醒
						// 消息会整条落成「（无内容）」。按段序前置拼接(@全体 通常单独成消息)。
						textParts.push("@全体");
					}
				}
				return {
					kind: "composite",
					text: textParts.join("\n"),
					imageRef,
				};
			}
		}
	}

	async function append(input: HistoryAppendInput): Promise<HistoryEntry> {
		await ensureDirs();
		const id = randomUUID();
		const ts = new Date().toISOString();
		const payload = await reduce(input.payload, id, input.source);
		const entry: HistoryEntry = {
			id,
			ts,
			source: input.source,
			uid: input.uid,
			subscriptionId: input.subscriptionId,
			targetIds: input.targets.map((t) => t.targetId),
			result: {
				ok: input.targets.every((t) => t.ok),
				per: input.targets,
			},
			payload,
			unameSnapshot: input.unameSnapshot,
			uavatarSnapshot: input.uavatarSnapshot,
		};
		// Defensive validation — schema mismatches are programmer errors, but
		// recording corrupt jsonl is worse than rejecting the write.
		const parsed = HistoryEntrySchema.safeParse(entry);
		if (!parsed.success) {
			opts.logger.error(
				`[history] entry rejected by schema, dropping: ${JSON.stringify(parsed.error.issues)}`,
			);
			throw new Error("history entry schema validation failed");
		}
		const line = `${JSON.stringify(parsed.data)}\n`;
		await writeFile(dayFile(ts), line, { flag: "a", encoding: "utf8" });
		opts.bus.emit("history-recorded", parsed.data);
		return parsed.data;
	}

	async function query(q: HistoryQuery): Promise<HistoryEntry[]> {
		await ensureDirs();
		const limit = Math.min(q.limit ?? 100, 500);
		const sinceMs = q.since ? Date.parse(q.since) : Number.NEGATIVE_INFINITY;
		const out: HistoryEntry[] = [];

		// List day files, newest first.
		let files: string[];
		try {
			const all = await readdir(root);
			files = all
				.filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
				.sort()
				.reverse();
		} catch {
			return [];
		}

		for (const file of files) {
			const path = join(root, file);
			const collected = await readJsonl(path);
			// In-file is chronological (append-only); reverse so newest first per day.
			for (let i = collected.length - 1; i >= 0; i--) {
				const entry = collected[i];
				if (!entry) continue;
				if (Date.parse(entry.ts) <= sinceMs) continue;
				if (q.source && entry.source !== q.source) continue;
				if (q.uid && entry.uid !== q.uid) continue;
				out.push(entry);
				if (out.length >= limit) return out;
			}
		}
		return out;
	}

	async function aggregateDaily(opts: DailyAggregateOptions): Promise<DailyHistoryCount[]> {
		await ensureDirs();
		const tz = opts.tzOffsetMin ?? 0;
		const nowMs = (opts.now ?? new Date()).getTime();

		// 「本地日」= UTC 时刻平移 tz 偏移后的 UTC 日期。日文件名是 UTC 日,与本地日
		// 错位(北京凌晨 0~8 点在前一个 UTC 日文件里),所以归属必须按 entry.ts 逐条算,
		// 不能按文件名。
		const localKey = (utcMs: number) => new Date(utcMs - tz * 60_000).toISOString().slice(0, 10);

		// 窗口日序列在「墙钟毫秒」空间里做减法 —— 固定偏移下无 DST,天长恒为 24h。
		const todayWallMs = Date.parse(`${localKey(nowMs)}T00:00:00Z`);
		const out: DailyHistoryCount[] = [];
		const byDay = new Map<string, DailyHistoryCount>();
		for (let i = opts.days - 1; i >= 0; i--) {
			const d = new Date(todayWallMs - i * 86_400_000).toISOString().slice(0, 10);
			const bucket: DailyHistoryCount = { d, counts: zeroCounts(), total: 0, failures: 0 };
			out.push(bucket);
			byDay.set(d, bucket);
		}

		// 窗口首日 0 点的真实 UTC 时刻所在的 UTC 日 —— 比它更早的日文件不可能含窗口内
		// entry,直接跳过不读。窗口后侧不裁(顶多多读今天之后的空文件,不存在)。
		const windowStartUtcMs = todayWallMs - (opts.days - 1) * 86_400_000 + tz * 60_000;
		const firstFileDate = new Date(windowStartUtcMs).toISOString().slice(0, 10);

		let files: string[];
		try {
			files = (await readdir(root)).filter(
				(f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) >= firstFileDate,
			);
		} catch {
			return out;
		}
		for (const file of files) {
			for (const entry of await readJsonl(join(root, file))) {
				const ms = Date.parse(entry.ts);
				if (!Number.isFinite(ms)) continue;
				const bucket = byDay.get(localKey(ms));
				if (!bucket) continue;
				bucket.counts[entry.source] += 1;
				bucket.total += 1;
				if (!entry.result.ok) bucket.failures += 1;
			}
		}
		return out;
	}

	async function readJsonl(path: string): Promise<HistoryEntry[]> {
		const out: HistoryEntry[] = [];
		try {
			const stream = createReadStream(path, { encoding: "utf8" });
			const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
			for await (const line of rl) {
				if (!line.trim()) continue;
				try {
					const parsed = JSON.parse(line);
					const r = HistoryEntrySchema.safeParse(parsed);
					if (r.success) out.push(r.data);
				} catch {
					// skip malformed line
				}
			}
		} catch {
			// missing file is fine
		}
		return out;
	}

	return {
		append,
		query,
		aggregateDaily,
		imageDir: () => imgRoot,
	};
}

function mimeToExt(mime: string): string {
	const m = mime.toLowerCase();
	if (m.includes("png")) return "png";
	if (m.includes("webp")) return "webp";
	if (m.includes("gif")) return "gif";
	return "jpg";
}

/** Internal helper used by retention.ts. */
export async function listDayFiles(dataDir: string): Promise<string[]> {
	const root = join(dataDir, "history");
	try {
		const all = await readdir(root);
		return all.filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
	} catch {
		return [];
	}
}

/** Internal helper used by retention.ts. */
export async function deleteDayFile(dataDir: string, fileName: string): Promise<void> {
	await unlink(join(dataDir, "history", fileName));
}
