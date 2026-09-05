import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { DailyHistoryCount } from "@bilibili-notify/contract";
import type {
	HistoryEntry,
	HistoryMessage,
	HistoryMessageResult,
	HistoryMessageRole,
	HistoryPayload,
	Logger,
	MessageBus,
	NotificationPayload,
	PushKind,
	PushStatus,
} from "@bilibili-notify/internal";
import {
	countsAsDelivery,
	countsAsFailure,
	HistoryEntrySchema,
	HistoryPatchSchema,
	PushKindSchema,
} from "@bilibili-notify/internal";
import { RecencyTable } from "../util/recency-table.js";

/**
 * 推送历史:jsonl-by-day 持久化 + bus 广播。
 *
 * **一行 = 一次推送 × 一个目标**,行里是这次推送发给这个目标的消息列表与逐条结果。
 * 本体(卡片)落地就建行、emit `history-recorded`;同一次推送的后续消息(词云 / 总结 /
 * 图集 / @全体)算好发出后**追加到同一行**:盘上写一条补丁行,读时按行 id 并回去,
 * emit `history-updated`。jsonl 仍是 append-only,保留期(见 `retention.ts`)按日文件淘汰。
 *
 * 图片写到 `<dataDir>/history/img/<rowId>-<idx>.<ext>`,相对文件名存在
 * `payload.imageRef`;面板经 `/api/history/img/*` 读。
 */

export interface HistoryRecordMessage {
	payload: NotificationPayload;
	role: HistoryMessageRole;
	/** 无目标行没有它。 */
	result?: HistoryMessageResult;
}

export interface HistoryRecordInput {
	pushId: string;
	kind: PushKind;
	uid: string;
	subscriptionId: string;
	/** null = 这类推送没有任何可用目标,落「无目标」那一行。 */
	target: string | null;
	messages: HistoryRecordMessage[];
	/** Snapshot of sub.cachedProfile.name at write time; survives 订阅删除。 */
	unameSnapshot?: string;
	/** Snapshot of sub.cachedProfile.avatar at write time。 */
	uavatarSnapshot?: string;
}

interface HistoryQuery {
	limit?: number;
	since?: string;
	kind?: PushKind;
	uid?: string;
}

interface DailyAggregateOptions {
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

// DailyHistoryCount 的类型本体在 @bilibili-notify/contract(web 同源消费)。

export interface HistoryStore {
	/**
	 * 记一次推送对一个目标的一段消息。同 pushId + 同目标第一次来建行,之后追加;
	 * 返回合并后的整行。
	 */
	record(input: HistoryRecordInput): Promise<HistoryEntry>;
	query(opts: HistoryQuery): Promise<HistoryEntry[]>;
	aggregateDaily(opts: DailyAggregateOptions): Promise<DailyHistoryCount[]>;
	imageDir(): string;
}

function zeroCounts(): Record<PushKind, number> {
	return Object.fromEntries(PushKindSchema.options.map((k) => [k, 0])) as Record<PushKind, number>;
}

/**
 * 四态的算法。本体 = 第一条 `role: "main"` 的消息:它没到就是失败;它到了、别的没到是
 * 部分失败(附加项,或本体的后续分条)。只有附加项先到的行(@全体 抢在卡片前面落地)
 * 暂按失败 / 已送达算,本体一到就重算。
 */
export function computeStatus(targetId: string | null, messages: HistoryMessage[]): PushStatus {
	if (targetId === null) return "no-targets";
	const results = messages.flatMap((m) => (m.result ? [m.result] : []));
	// 一条结果都没有的有目标行 = 什么都没发出去,不是「全到了」——`[].every` 恒真,不挡住
	// 它,一行没有结果的消息会顶着「已送达」进面板与今日 KPI。
	if (results.length > 0 && results.every((r) => r.ok)) return "delivered";
	const main = messages.find((m) => m.role === "main");
	if (!main?.result?.ok) return "failed";
	return "partial";
}

/** 同 pushId 同目标的行还在内存里时才能追加;保留最近这些,够一次推送从头到尾。 */
const OPEN_ROWS_CAP = 2000;

export interface CreateHistoryStoreOptions {
	dataDir: string;
	bus: MessageBus;
	logger: Logger;
}

export function createHistoryStore(opts: CreateHistoryStoreOptions): HistoryStore {
	const root = join(opts.dataDir, "history");
	const imgRoot = join(root, "img");
	/** 还可能被追加的行,键 = `${pushId}|${targetId}`;满了丢最久没碰的。 */
	const open = new RecencyTable<HistoryEntry>(OPEN_ROWS_CAP);
	/** 写串行化:同一次推送的两段(卡片、紧随其后的 @全体)不会同时建两行。 */
	let tail: Promise<unknown> = Promise.resolve();

	async function ensureDirs(): Promise<void> {
		await mkdir(root, { recursive: true });
		await mkdir(imgRoot, { recursive: true });
	}

	function dayFile(dateIso: string): string {
		// YYYY-MM-DDTHH:MM:SS.sssZ → YYYY-MM-DD
		return join(root, `${dateIso.slice(0, 10)}.jsonl`);
	}

	async function writeImage(name: string, buffer: Buffer): Promise<string> {
		await writeFile(join(imgRoot, name), buffer);
		return name;
	}

	async function reduce(
		msg: HistoryRecordMessage,
		stem: string,
		kind: PushKind,
	): Promise<HistoryPayload> {
		const payload = msg.payload;
		switch (payload.kind) {
			case "text":
				return { kind: "text", text: payload.text };
			case "image": {
				const imageRef = await writeImage(
					`${stem}.${mimeToExt(payload.image.mime)}`,
					payload.image.buffer,
				);
				// 纯图推送(无 caption)在 History 列表会落成「（无内容）」—— 给个可读摘要。
				// 下播的附加项里唯一的图是词云;别的纯图都是拆成独立消息的卡片。
				const text =
					payload.caption ||
					(kind === "live-end" && msg.role === "extra" ? "[弹幕词云]" : "[卡片图]");
				return { kind: "image", text, imageRef };
			}
			case "forward-images":
				return {
					kind: "text",
					text: `[图集 ${payload.images.length} 张${payload.forward ? " · 合并转发" : ""}]`,
				};
			case "miniapp-card":
				return { kind: "text", text: `[小程序卡] ${payload.title}` };
			case "composite": {
				const textParts: string[] = [];
				let imageRef: string | undefined;
				let imageIdx = 0;
				for (const seg of payload.segments) {
					if (seg.type === "text") {
						textParts.push(seg.text);
					} else if (seg.type === "image" && !imageRef) {
						const name = `${stem}-${imageIdx++}.${mimeToExt(seg.mime)}`;
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

	async function reduceAll(
		messages: HistoryRecordMessage[],
		rowId: string,
		offset: number,
		kind: PushKind,
	): Promise<HistoryMessage[]> {
		const out: HistoryMessage[] = [];
		for (const [i, msg] of messages.entries()) {
			const payload = await reduce(msg, `${rowId}-${offset + i}`, kind);
			out.push({ payload, role: msg.role, ...(msg.result ? { result: msg.result } : {}) });
		}
		return out;
	}

	function validated(entry: HistoryEntry): HistoryEntry {
		// Defensive validation — schema mismatches are programmer errors, but
		// recording corrupt jsonl is worse than rejecting the write.
		const parsed = HistoryEntrySchema.safeParse(entry);
		if (!parsed.success) {
			opts.logger.error(
				`[history] entry rejected by schema, dropping: ${JSON.stringify(parsed.error.issues)}`,
			);
			throw new Error("history entry schema validation failed");
		}
		return parsed.data;
	}

	async function recordSerialized(input: HistoryRecordInput): Promise<HistoryEntry> {
		await ensureDirs();
		const key = `${input.pushId}|${input.target ?? "-"}`;
		const existing = open.get(key);
		if (!existing) {
			const id = randomUUID();
			const ts = new Date().toISOString();
			const messages = await reduceAll(input.messages, id, 0, input.kind);
			const entry = validated({
				id,
				pushId: input.pushId,
				ts,
				kind: input.kind,
				uid: input.uid,
				subscriptionId: input.subscriptionId,
				targetId: input.target,
				status: computeStatus(input.target, messages),
				messages,
				unameSnapshot: input.unameSnapshot,
				uavatarSnapshot: input.uavatarSnapshot,
			});
			await writeFile(dayFile(ts), `${JSON.stringify(entry)}\n`, { flag: "a", encoding: "utf8" });
			open.set(key, entry);
			opts.bus.emit("history-recorded", entry);
			return entry;
		}
		const added = await reduceAll(
			input.messages,
			existing.id,
			existing.messages.length,
			existing.kind,
		);
		const messages = [...existing.messages, ...added];
		const merged = validated({
			...existing,
			status: computeStatus(existing.targetId, messages),
			messages,
		});
		// 补丁行:键序固定 `patch` 在前,读侧靠行首认出它、不必先 JSON.parse。
		const patch = { patch: merged.id, status: merged.status, messages: added };
		await writeFile(dayFile(existing.ts), `${JSON.stringify(patch)}\n`, {
			flag: "a",
			encoding: "utf8",
		});
		open.set(key, merged);
		opts.bus.emit("history-updated", merged);
		return merged;
	}

	function record(input: HistoryRecordInput): Promise<HistoryEntry> {
		const job = tail.then(() => recordSerialized(input));
		tail = job.catch(() => {});
		return job;
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

		// kind / uid 的合格行可能散在整份文件里,拿尾巴不成立 —— 那条路只好照旧
		// 全量解析。前端两个调用点(Dashboard limit=100 / History limit=200)都不带
		// 这两个参数,也就是说热路径永远走便宜的那条。
		const needsFullScan = q.kind !== undefined || q.uid !== undefined;

		for (const file of files) {
			const path = join(root, file);
			const collected = needsFullScan
				? await readJsonl(path)
				: await readTailEntries(path, limit - out.length);
			// In-file is chronological (append-only); reverse so newest first per day.
			for (let i = collected.length - 1; i >= 0; i--) {
				const entry = collected[i];
				if (!entry) continue;
				if (Date.parse(entry.ts) <= sinceMs) continue;
				if (q.kind && entry.kind !== q.kind) continue;
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
				// 「今日推送」数的是推到了多少个地方,「今日失败」把部分失败也算进去 ——
				// 两条口径与面板上的乐观补丁同吃 internal 的那一份。
				if (!countsAsDelivery(entry.status)) continue;
				bucket.counts[entry.kind] += 1;
				bucket.total += 1;
				if (countsAsFailure(entry.status)) bucket.failures += 1;
			}
		}
		return out;
	}

	/**
	 * 一批 jsonl 原文行 → entry,补丁行并回它的行;坏行、不合 schema 的行、找不到
	 * 亲的补丁行静默跳过。老格式行由 schema 读时映射。
	 */
	function parseLines(lines: readonly string[]): HistoryEntry[] {
		const byId = new Map<string, HistoryEntry>();
		const order: HistoryEntry[] = [];
		for (const line of lines) {
			try {
				const json = JSON.parse(line);
				if (isPatchLine(line)) {
					const r = HistoryPatchSchema.safeParse(json);
					const base = r.success ? byId.get(r.data.patch) : undefined;
					if (r.success && base) {
						base.messages.push(...r.data.messages);
						base.status = r.data.status;
					}
					continue;
				}
				const r = HistoryEntrySchema.safeParse(json);
				if (r.success) {
					byId.set(r.data.id, r.data);
					order.push(r.data);
				}
			} catch {
				// skip malformed line
			}
		}
		return order;
	}

	/**
	 * 一个日文件里**最新的那几条**(仍是时序,最新的在最后)。
	 *
	 * 为什么不直接 {@link readJsonl} 再取尾巴:那样每次请求都要把当天每一行都
	 * `JSON.parse` + zod 校验一遍,而返回的最多 `limit` 条 —— 解析开销跟「当天推了
	 * 多少」成正比,跟「要拿几条」无关。攒得越多越慢,而多出来的全是白干。
	 *
	 * 这里逐行流读(不把整份文件读进内存),只把最后 `limit` **行**(补丁行不算,
	 * 它们跟着自己的行一起留下)的原文留在窗口里,读完才解析那几行。
	 */
	async function readTailEntries(path: string, limit: number): Promise<HistoryEntry[]> {
		if (limit <= 0) return [];
		// 窗口只往后追加,丢掉的行用 head 下标跨过去 —— `shift()` 是 O(n),几万行的日文件
		// 上,省下来的那点解析开销会原样还回去。head 跑远了才整块裁一次(摊下来仍是每行
		// O(1)),免得整份文件的行都被这个数组攥着不放。
		const window: string[] = [];
		let head = 0;
		let rowsInWindow = 0;
		let rowsSeen = 0;
		try {
			const stream = createReadStream(path, { encoding: "utf8" });
			const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
			for await (const line of rl) {
				if (!line.trim()) continue;
				window.push(line);
				if (isPatchLine(line)) continue;
				rowsInWindow += 1;
				rowsSeen += 1;
				while (rowsInWindow > limit) {
					const dropped = window[head];
					head += 1;
					if (dropped !== undefined && !isPatchLine(dropped)) rowsInWindow -= 1;
				}
				if (head > limit) {
					window.splice(0, head);
					head = 0;
				}
			}
		} catch {
			// missing file is fine
			return [];
		}
		const entries = parseLines(window.slice(head));
		// **窗口按行取,结果按条算 —— 中间差的那几条不能靠更早的日文件来填。**
		// 尾窗里混进读不回来的行(崩在写一半的最后一行、旧 schema 的行)时,这一份
		// 就少给几条;调用方看见没凑够 limit,转头去前一天的文件里补 —— 夹在中间
		// 那些完好的记录于是从历史页上彻底消失,连翻页都翻不到。
		//
		// 坏行本就罕见,遇上了就把这一份老老实实全读一遍:慢一次(且只慢这一份),
		// 换的是「给出来的一定是连着的最新几条」。
		if (entries.length < rowsInWindow && rowsSeen > limit) {
			return (await readJsonl(path)).slice(-limit);
		}
		return entries;
	}

	async function readJsonl(path: string): Promise<HistoryEntry[]> {
		const lines: string[] = [];
		try {
			const stream = createReadStream(path, { encoding: "utf8" });
			const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
			for await (const line of rl) {
				if (line.trim()) lines.push(line);
			}
		} catch {
			// missing file is fine
		}
		return parseLines(lines);
	}

	return {
		record,
		query,
		aggregateDaily,
		imageDir: () => imgRoot,
	};
}

/** 补丁行的键序固定 `patch` 打头(见 record),行首一眼认出,不用先 JSON.parse。 */
function isPatchLine(line: string): boolean {
	return line.startsWith('{"patch":');
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
