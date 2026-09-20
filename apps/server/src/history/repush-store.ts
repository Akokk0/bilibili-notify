import { mkdir, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	HistoryMessageRole,
	HistoryPayload,
	Logger,
	NotificationPayload,
	PayloadSegment,
} from "@bilibili-notify/internal";
import { z } from "zod";
import { mimeToExt } from "./store.js";

/**
 * **重推原件**(ADR-0017 决策 1-5)——「失败那一刻留一份能再发一次的原料」。
 *
 * 🔴 **不从历史行重建**:历史里的 payload 是给人看的**有损摘要**。图集只剩一句
 * 「[图集 N 张]」、小程序卡只剩标题、composite 只留第一张图,而 `at-all` 段被写成
 * **字面文字**「@全体」—— 拿它重发,那四个字会真的发到群里,而该响的铃一个都不响。
 *
 * 几条形状,每条对着一个会静默坏掉的地方:
 *
 * 1. **落盘,不放内存。** 要解的场景是「离线一段时间后上线」,而这段时间里服务端重启
 *    完全可能(本项目自己就有应用内自主升级,升级即重启)。内存版会在最需要它的那一次
 *    恰好是空的。
 * 2. **按 UTC 日分目录**,与历史的日文件同名(`repush/2026-09-20/` ↔ `2026-09-20.jsonl`)。
 *    保留期删日文件时顺手 {@link RepushStore.dropDay} —— 一个数管两处(决策 4),而且
 *    整目录删得干净:历史那边的 `deleteDayFile` 只 unlink jsonl,`history/img/` 至今
 *    没有清理器,原件的图混进去就是往那个洞里再加东西。
 * 3. **图复用历史已经写过的那一份**(决策 3),一个字节都不多存;只有历史丢掉的
 *    (composite 第二张图起)才写进原件自己的日目录,标一个 `own`。
 * 4. **下标与历史行的 `messages` 一一对应。** 「只补没到的」靠下标认亲,错位了就补错
 *    消息 —— 所以读回来时拿条数对一次表,对不上整份作废。
 *
 * ⚠️ **还没有总字节上限**(决策 4 那半):一次长离线到底会积多少条、卡片图平均多大,
 * 真机跑过一轮才定得出来(ADR-0017「仍未决」)。今天的天花板只有保留期。
 */

/** 盘上那个文件名安全吗 —— 与 `HistoryPayload.imageRef` 同一把尺子,挡路径穿越。 */
const SAFE_REF = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

const StoredImageSchema = z.object({
	/** 盘上的纯文件名。 */
	ref: z
		.string()
		.regex(SAFE_REF, "ref 必须是纯文件名")
		.refine((s) => !s.includes(".."), "ref 不得含 .."),
	mime: z.string(),
	/** true = 这张图在原件自己的日目录里;缺省 = 在 `history/img/`(复用历史那份)。 */
	own: z.literal(true).optional(),
});

const StoredSegmentSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("text"), text: z.string() }),
	z.object({ type: z.literal("image"), image: StoredImageSchema }),
	z.object({ type: z.literal("link"), href: z.string(), title: z.string().optional() }),
	z.object({ type: z.literal("at-all") }),
]);

const StoredPayloadSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("text"), text: z.string() }),
	z.object({ kind: z.literal("image"), image: StoredImageSchema, caption: z.string().optional() }),
	z.object({ kind: z.literal("composite"), segments: z.array(StoredSegmentSchema) }),
	z.object({
		kind: z.literal("forward-images"),
		images: z.array(
			z.object({ url: z.string(), width: z.number().optional(), height: z.number().optional() }),
		),
		forward: z.boolean(),
	}),
	z.object({
		kind: z.literal("miniapp-card"),
		title: z.string(),
		desc: z.string(),
		picUrl: z.string(),
		path: z.string(),
		jumpUrl: z.string(),
	}),
]);
type StoredPayload = z.infer<typeof StoredPayloadSchema>;

const DraftSchema = z.object({
	v: z.literal(1),
	messages: z.array(z.object({ payload: StoredPayloadSchema, role: z.enum(["main", "extra"]) })),
});

/** 交给 {@link RepushStore.append} 的一条:原始 payload,加上历史那边已经算好的那一条。 */
export interface RepushAppendItem {
	payload: NotificationPayload;
	role: HistoryMessageRole;
	/**
	 * 历史 `reduce` 出来的**就是这一条**(调用方手里正好有)。这儿只关心其中一样:
	 * **图写到哪去了** —— 有 `imageRef` 就复用,没有才自己写一份(决策 3)。
	 */
	reduced: HistoryPayload;
}

/** 读回来的一条:可以直接交给发送层的 {@link NotificationPayload}。 */
export interface RepushMessage {
	payload: NotificationPayload;
	role: HistoryMessageRole;
}

/**
 * 每个方法的 `ts` 是**这一行的 `ts`**(或它的日期串 —— 只取前 10 个字符)。原件按 UTC 日
 * 分目录,与历史的日文件同名;追加时用的是**原行**那一天,与补丁行写进 `dayFile(原行.ts)`
 * 严丝合缝 —— 两边永远落在同一个日子里。
 */
export interface RepushStore {
	/** 把这一段消息的原料追加到这一行的原件后面。下标接着往后排。 */
	append(rowId: string, ts: string, items: readonly RepushAppendItem[]): Promise<void>;
	/**
	 * 读一行的原件,图一并读回内存。没存过、读不动、或**条数与历史行对不上**都回 `null`
	 * —— 调用方据此把按钮灰掉并说明原因(决策 9),绝不交一份错位的原料出去。
	 */
	load(rowId: string, ts: string, expectLen: number): Promise<{ messages: RepushMessage[] } | null>;
	/** 删掉这一行的原件与它自己写过的图。不存在不算错。 */
	drop(rowId: string, ts: string): Promise<void>;
	/** 保留期:端掉某一个 UTC 日的全部原件。 */
	dropDay(day: string): Promise<void>;
}

export interface CreateRepushStoreOptions {
	dataDir: string;
	logger: Logger;
}

export function createRepushStore(opts: CreateRepushStoreOptions): RepushStore {
	const root = join(opts.dataDir, "history", "repush");
	const historyImgRoot = join(opts.dataDir, "history", "img");

	const dayOf = (ts: string): string => ts.slice(0, 10);
	const dayDir = (ts: string): string => join(root, dayOf(ts));
	const draftPath = (rowId: string, ts: string): string => join(dayDir(ts), `${rowId}.json`);

	/** 这张图在盘上的完整路径 —— `own` 决定去哪个目录找。 */
	const imagePath = (img: z.infer<typeof StoredImageSchema>, ts: string): string =>
		img.own ? join(dayDir(ts), img.ref) : join(historyImgRoot, img.ref);

	async function readDraft(rowId: string, ts: string): Promise<z.infer<typeof DraftSchema> | null> {
		let raw: string;
		try {
			raw = await readFile(draftPath(rowId, ts), "utf8");
		} catch {
			return null;
		}
		try {
			const parsed = DraftSchema.safeParse(JSON.parse(raw));
			return parsed.success ? parsed.data : null;
		} catch {
			// 坏 json。原件不是真相的唯一副本(历史那一行还在),作废掉就是了。
			return null;
		}
	}

	/**
	 * 一条 `NotificationPayload` → 可存的形状,顺便把**历史没写过的**图落进日目录。
	 *
	 * `msgIdx` 是这一条在**整行**里的下标,与历史行的 `messages` 同一个数 —— 自己写的
	 * 图跟着它命名,两次 append 不会撞名。
	 */
	async function toStored(
		item: RepushAppendItem,
		rowId: string,
		ts: string,
		msgIdx: number,
	): Promise<StoredPayload> {
		const { payload, reduced } = item;
		let ownCount = 0;
		/** 自己写一份,回它的引用。 */
		const writeOwn = async (buffer: Buffer, mime: string) => {
			const ref = `${rowId}-${msgIdx}-${ownCount++}.${mimeToExt(mime)}`;
			await writeFile(join(dayDir(ts), ref), buffer);
			return { ref, mime, own: true as const };
		};

		switch (payload.kind) {
			case "text":
				return { kind: "text", text: payload.text };
			case "image": {
				// 历史一定给整张图写过一份(`reduce` 的 image 分支),照理走不到 else。
				const image = reduced.imageRef
					? { ref: reduced.imageRef, mime: payload.image.mime }
					: await writeOwn(payload.image.buffer, payload.image.mime);
				return {
					kind: "image",
					image,
					...(payload.caption !== undefined ? { caption: payload.caption } : {}),
				};
			}
			case "forward-images":
				// 图集本来就是一串 url(没有 buffer),原样抄过去。历史那边只剩一句摘要。
				return {
					kind: "forward-images",
					images: payload.images.map((i) => ({ ...i })),
					forward: payload.forward,
				};
			case "miniapp-card":
				return { ...payload };
			case "composite": {
				const segments: z.infer<typeof StoredSegmentSchema>[] = [];
				let firstImage = true;
				for (const seg of payload.segments) {
					if (seg.type === "image") {
						// 历史的 `reduce` 只写**第一张**(那句 `!imageRef`),所以只有它能复用。
						const image =
							firstImage && reduced.imageRef
								? { ref: reduced.imageRef, mime: seg.mime }
								: await writeOwn(seg.buffer, seg.mime);
						firstImage = false;
						segments.push({ type: "image", image });
					} else {
						segments.push({ ...seg });
					}
				}
				return { kind: "composite", segments };
			}
		}
	}

	/** 可存的形状 + 盘上的字节 → 能直接发的 payload。读不到图就抛,由 `load` 收成 null。 */
	async function toPayload(stored: StoredPayload, ts: string): Promise<NotificationPayload> {
		switch (stored.kind) {
			case "text":
				return { kind: "text", text: stored.text };
			case "image":
				return {
					kind: "image",
					image: {
						buffer: await readFile(imagePath(stored.image, ts)),
						mime: stored.image.mime,
					},
					...(stored.caption !== undefined ? { caption: stored.caption } : {}),
				};
			case "forward-images":
				return {
					kind: "forward-images",
					images: stored.images.map((i) => ({ ...i })),
					forward: stored.forward,
				};
			case "miniapp-card":
				return { ...stored };
			case "composite": {
				const segments: PayloadSegment[] = [];
				for (const seg of stored.segments) {
					if (seg.type === "image") {
						segments.push({
							type: "image",
							buffer: await readFile(imagePath(seg.image, ts)),
							mime: seg.image.mime,
						});
					} else {
						segments.push({ ...seg });
					}
				}
				return { kind: "composite", segments };
			}
		}
	}

	async function append(
		rowId: string,
		ts: string,
		items: readonly RepushAppendItem[],
	): Promise<void> {
		if (items.length === 0) return;
		await mkdir(dayDir(ts), { recursive: true });
		const existing = await readDraft(rowId, ts);
		const messages = existing ? [...existing.messages] : [];
		const offset = messages.length;
		for (const [i, item] of items.entries()) {
			messages.push({ payload: await toStored(item, rowId, ts, offset + i), role: item.role });
		}
		await writeFile(draftPath(rowId, ts), JSON.stringify({ v: 1, messages }), "utf8");
	}

	async function load(
		rowId: string,
		ts: string,
		expectLen: number,
	): Promise<{ messages: RepushMessage[] } | null> {
		const draft = await readDraft(rowId, ts);
		if (!draft) return null;
		// 条数对不上 = 原件与历史行错位了(某一次 append 没写成)。补错消息比补不了更糟。
		if (draft.messages.length !== expectLen) {
			opts.logger.warn(
				`[history] 重推原件与历史行对不上号(原件 ${draft.messages.length} 条、行 ${expectLen} 条),作废:${rowId}`,
			);
			return null;
		}
		try {
			const messages: RepushMessage[] = [];
			for (const m of draft.messages) {
				messages.push({ payload: await toPayload(m.payload, ts), role: m.role });
			}
			return { messages };
		} catch (err) {
			// 图不在盘上了(被 devtools 的截流清理收走过)。原件不完整,补不出原样。
			opts.logger.warn(`[history] 重推原件的图读不回来,作废:${rowId} — ${String(err)}`);
			return null;
		}
	}

	async function drop(rowId: string, ts: string): Promise<void> {
		const draft = await readDraft(rowId, ts);
		if (draft) {
			for (const m of draft.messages) {
				const imgs =
					m.payload.kind === "image"
						? [m.payload.image]
						: m.payload.kind === "composite"
							? m.payload.segments.flatMap((s) => (s.type === "image" ? [s.image] : []))
							: [];
				// 只删自己写的那些 —— 复用的那份归历史管,删了会把历史页上的图也弄没。
				for (const img of imgs) {
					if (img.own) await unlink(join(dayDir(ts), img.ref)).catch(() => {});
				}
			}
		}
		await unlink(draftPath(rowId, ts)).catch(() => {});
	}

	async function dropDay(day: string): Promise<void> {
		await rm(join(root, day), { recursive: true, force: true });
	}

	return { append, load, drop, dropDay };
}

/** 盘上现有哪些日子的原件 —— 保留期拿它对表。 */
export async function listRepushDays(dataDir: string): Promise<string[]> {
	try {
		const all = await readdir(join(dataDir, "history", "repush"));
		return all.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
	} catch {
		return [];
	}
}
