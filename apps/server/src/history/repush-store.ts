import { readdir, readFile, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
	IMAGE_REF_PATTERN,
	type ImageRef,
	ImageRefSchema,
	type Logger,
	type NotificationPayload,
	type PayloadSegment,
	type PushMessageRole,
	PushMessageRoleSchema,
} from "@bilibili-notify/internal";
import { atomicWriteJson } from "@bilibili-notify/storage";
import { z } from "zod";
import type { ImageStore, ImageWriter } from "../images/image-store.js";
import { dataPath } from "../runtime/roots.js";

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
 *    保留期的清扫清到哪一天,就顺手 {@link dropRepushDay} 到哪一天 —— 一个数管两处(决策 4),
 *    整目录删得干净。
 * 3. **图全在图库里**(ADR-0022 决策 9,修订了 ADR-0017 决策 3 的「复用历史那一份、其余自存」):原件里每一张图
 *    (含 composite 第二张起、历史行丢掉的那些)都 `put` 进图库,存的只是引用;同一份字节只有一个文件,重推
 *    每试一次也不会再多写一份。原件是图库的一家引用方(`listRepushImageRefs`),图不由原件删。
 * 4. **下标与历史行的 `messages` 一一对应。** 「只补没到的」靠下标认亲,错位了就补错
 *    消息 —— 所以读回来时拿条数对一次表,对不上整份作废。
 *
 * ⚠️ **还没有总字节上限**(决策 4 那半):一次长离线到底会积多少条、卡片图平均多大,
 * 真机跑过一轮才定得出来(ADR-0017「仍未决」)。今天的天花板只有保留期。
 */

/**
 * 原件里一张图 = 一个图库引用,格式(mime)随引用走。0.x 与 ⑳d 之前的原件存的是 `{ ref, mime, own? }`,
 * 由迁移改写成引用(`migration/history-images.ts`),这里只认引用。
 */
const StoredImageSchema = ImageRefSchema;

/** composite 的一段。判别键与活的 `PayloadSegment` 一样叫 `kind`(3a-16 之前盘上叫 `type`,由迁移改写)。 */
const StoredSegmentSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("text"), text: z.string() }),
	z.object({ kind: z.literal("image"), image: StoredImageSchema }),
	z.object({ kind: z.literal("link"), href: z.string(), title: z.string().optional() }),
	z.object({ kind: z.literal("at-all") }),
]);

/** 图集里的一张图:活的 `PostImage` 的每一格都在。`ref` 只是带着(适配器照 `url` 发),读回时不去图库取字节。 */
const StoredPostImageSchema = z.object({
	ref: ImageRefSchema.optional(),
	url: z.string().optional(),
	width: z.number().optional(),
	height: z.number().optional(),
	isAnimated: z.boolean().optional(),
});

/**
 * 载荷在盘上的样子:与活的 `NotificationPayload` 同名同格,只有图的字节换成了图库引用。3a-16 之前图集叫
 * `forward-images` / `forward`,小程序卡(`miniapp-card`,`desc` / `picUrl` / `path` / `jumpUrl`)在 3b-31 之前
 * 是原生分享的前身,都由迁移改写(`migration/history.ts`),这里只认新的。
 */
const StoredPayloadSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("text"), text: z.string() }),
	z.object({ kind: z.literal("image"), image: StoredImageSchema, caption: z.string().optional() }),
	z.object({ kind: z.literal("composite"), segments: z.array(StoredSegmentSchema) }),
	z.object({
		kind: z.literal("image-group"),
		images: z.array(StoredPostImageSchema),
		mergeForward: z.boolean(),
	}),
	z.object({
		kind: z.literal("native-share"),
		appId: z.string(),
		title: z.string(),
		description: z.string(),
		imageUrl: z.string(),
		pagePath: z.string(),
		webUrl: z.string(),
		iconUrl: z.string().optional(),
	}),
]);
type StoredPayload = z.infer<typeof StoredPayloadSchema>;
type StoredSegment = z.infer<typeof StoredSegmentSchema>;

/**
 * 一份重推原件在盘上的样子(`history/repush/<日>/<行 id>.json`)。`version` 是原件容器的版本;⑱c 之前叫 `v`,
 * 老原件由迁移改写(`migration/history.ts`),这里只认新的。图格的新旧不靠它认:对象(`{ ref, mime, own? }`)是
 * 旧的、字符串(图库引用)是新的 —— 与资料缓存的头像按值的形状认是一个做法。
 */
const RepushSnapshotSchema = z.object({
	version: z.literal(1),
	messages: z.array(z.object({ payload: StoredPayloadSchema, role: PushMessageRoleSchema })),
});
type RepushSnapshot = z.infer<typeof RepushSnapshotSchema>;

/** 交给 {@link RepushStore.append} 的一条:原始 payload,加上历史那边已经算好的那一条。 */
export interface RepushAppendItem {
	payload: NotificationPayload;
	role: PushMessageRole;
}

/** 读回来的一条:可以直接交给发送层的 {@link NotificationPayload}。 */
export interface RepushMessage {
	payload: NotificationPayload;
	role: PushMessageRole;
}

/**
 * 每个方法的 `createdAt` 是**这一行的 `createdAt`**(或它的日期串 —— 只取前 10 个字符)。原件按 UTC 日
 * 分目录,与历史的日文件同名;追加时用的是**原行**那一天,与补丁行写进 `dayFile(原行.createdAt)`
 * 严丝合缝 —— 两边永远落在同一个日子里。
 */
export interface RepushStore {
	/** 把这一段消息的原料追加到这一行的原件后面。下标接着往后排。 */
	append(rowId: string, createdAt: string, items: readonly RepushAppendItem[]): Promise<void>;
	/**
	 * 读一行的原件,图从图库一并读回内存。没存过、读不动、图库里没有某张图、或**条数与历史行对不上**都回 `null`
	 * —— 调用方据此把按钮灰掉并说明原因(决策 9),绝不交一份错位的原料出去。
	 */
	load(
		rowId: string,
		createdAt: string,
		expectLen: number,
	): Promise<{ messages: RepushMessage[] } | null>;
	/**
	 * 这一行还有原件吗。**只看文件在不在** —— 面板要为每一行失败的问一次「按钮该不该
	 * 灰」(决策 9),所以这一口不解析 json、更不把图读进内存。
	 */
	has(rowId: string, createdAt: string): Promise<boolean>;
	/** 删掉这一行的原件(只删那份 JSON)。**不删图**:图在图库里,原件没了它就不再引用,由图库的清扫收走。不存在不算错。 */
	drop(rowId: string, createdAt: string): Promise<void>;
}

export interface CreateRepushStoreOptions {
	dataRoot: string;
	logger: Logger;
	/**
	 * 图库:原件登记成引用方(`runtime/bootstrap.ts`)才拿得到的存图口,和读图用的 `read`(mime 随引用)。
	 */
	images: ImageWriter;
	imageStore: Pick<ImageStore, "read">;
}

export function createRepushStore(opts: CreateRepushStoreOptions): RepushStore {
	const root = dataPath(opts.dataRoot, "history", "repush");

	const dayOf = (createdAt: string): string => createdAt.slice(0, 10);
	const dayDir = (createdAt: string): string => join(root, dayOf(createdAt));
	const snapshotPath = (rowId: string, createdAt: string): string =>
		join(dayDir(createdAt), `${rowId}.json`);

	async function readSnapshot(rowId: string, createdAt: string): Promise<RepushSnapshot | null> {
		let raw: string;
		try {
			raw = await readFile(snapshotPath(rowId, createdAt), "utf8");
		} catch {
			return null;
		}
		try {
			const parsed = RepushSnapshotSchema.safeParse(JSON.parse(raw));
			return parsed.success ? parsed.data : null;
		} catch {
			// 坏 json。原件不是真相的唯一副本(历史那一行还在),作废掉就是了。
			return null;
		}
	}

	/** 原件里的一张图存进图库,回引用。存不进(不是图库收的图、磁盘写失败)就抛 —— 原件不完整比没有更糟,由 `append` 的调用方收成 warn。 */
	async function storeImage(buffer: Uint8Array): Promise<ImageRef> {
		const stored = await opts.images.put(buffer);
		if (!stored.ok) throw new Error(`图存不进图库:${stored.message}`);
		return stored.ref;
	}

	/** 图库引用 → 能直接发的图(字节 + mime)。图库里没有就抛,由 `load` 收成 null。 */
	async function loadImage(ref: ImageRef): Promise<{ buffer: Buffer; mime: string }> {
		const found = await opts.imageStore.read(ref);
		if (!found) throw new Error(`图库里没有这张图:${ref}`);
		return { buffer: found.bytes, mime: found.mime };
	}

	/** 一条 `NotificationPayload` → 可存的形状,顺便把里面每一张图存进图库。 */
	async function toStored(item: RepushAppendItem): Promise<StoredPayload> {
		const { payload } = item;
		switch (payload.kind) {
			case "text":
				return { kind: "text", text: payload.text };
			case "image":
				return {
					kind: "image",
					image: await storeImage(payload.image.buffer),
					...(payload.caption !== undefined ? { caption: payload.caption } : {}),
				};
			case "image-group":
				// 图集本来就是一串 url(没有 buffer),照抄过去。历史那边只剩一句摘要。
				return {
					kind: "image-group",
					images: payload.images.map((i) => ({ ...i })),
					mergeForward: payload.mergeForward,
				};
			case "native-share":
				return { ...payload };
			case "composite": {
				const segments: StoredSegment[] = [];
				for (const seg of payload.segments) {
					segments.push(
						seg.kind === "image"
							? { kind: "image", image: await storeImage(seg.buffer) }
							: { ...seg },
					);
				}
				return { kind: "composite", segments };
			}
		}
	}

	/** 可存的形状 + 图库里的字节 → 能直接发的 payload。读不到图就抛,由 `load` 收成 null。 */
	async function toPayload(stored: StoredPayload): Promise<NotificationPayload> {
		switch (stored.kind) {
			case "text":
				return { kind: "text", text: stored.text };
			case "image":
				return {
					kind: "image",
					image: await loadImage(stored.image),
					...(stored.caption !== undefined ? { caption: stored.caption } : {}),
				};
			case "image-group":
				return {
					kind: "image-group",
					images: stored.images.map((i) => ({ ...i })),
					mergeForward: stored.mergeForward,
				};
			case "native-share":
				return { ...stored };
			case "composite": {
				const segments: PayloadSegment[] = [];
				for (const seg of stored.segments) {
					segments.push(
						seg.kind === "image" ? { kind: "image", ...(await loadImage(seg.image)) } : { ...seg },
					);
				}
				return { kind: "composite", segments };
			}
		}
	}

	async function append(
		rowId: string,
		createdAt: string,
		items: readonly RepushAppendItem[],
	): Promise<void> {
		if (items.length === 0) return;
		const existing = await readSnapshot(rowId, createdAt);
		const messages = existing ? [...existing.messages] : [];
		for (const item of items) {
			messages.push({ payload: await toStored(item), role: item.role });
		}
		// 原子写会顺手建日目录。
		await atomicWriteJson(snapshotPath(rowId, createdAt), { version: 1, messages });
	}

	async function load(
		rowId: string,
		createdAt: string,
		expectLen: number,
	): Promise<{ messages: RepushMessage[] } | null> {
		const snapshot = await readSnapshot(rowId, createdAt);
		if (!snapshot) return null;
		// 条数对不上 = 原件与历史行错位了(某一次 append 没写成)。补错消息比补不了更糟。
		if (snapshot.messages.length !== expectLen) {
			opts.logger.warn(
				`[history] 重推原件与历史行对不上号(原件 ${snapshot.messages.length} 条、行 ${expectLen} 条),作废:${rowId}`,
			);
			return null;
		}
		try {
			const messages: RepushMessage[] = [];
			for (const m of snapshot.messages) {
				messages.push({ payload: await toPayload(m.payload), role: m.role });
			}
			return { messages };
		} catch (err) {
			// 图库里没有某张图了(过了宽限期又没人引用的被清扫收走,或者盘上的文件被动过)。原件不完整,补不出原样。
			opts.logger.warn(`[history] 重推原件的图读不回来,作废:${rowId} — ${String(err)}`);
			return null;
		}
	}

	async function has(rowId: string, createdAt: string): Promise<boolean> {
		try {
			return (await stat(snapshotPath(rowId, createdAt))).isFile();
		} catch {
			return false;
		}
	}

	async function drop(rowId: string, createdAt: string): Promise<void> {
		await unlink(snapshotPath(rowId, createdAt)).catch(() => {});
	}

	return { append, load, has, drop };
}

/** 保留期:端掉某一个 UTC 日的全部原件(整个日目录)。图在图库里,不在这里删。 */
export async function dropRepushDay(dataRoot: string, day: string): Promise<void> {
	await rm(join(dataPath(dataRoot, "history", "repush"), day), { recursive: true, force: true });
}

/** 原件按 UTC 日分目录,目录名就是日子。 */
const DAY_DIR = /^\d{4}-\d{2}-\d{2}$/;

/** 盘上现有哪些日子的原件 —— 保留期拿它对表。 */
export async function listRepushDays(dataRoot: string): Promise<string[]> {
	try {
		const all = await readdir(dataPath(dataRoot, "history", "repush"));
		return all.filter((d) => DAY_DIR.test(d));
	} catch {
		return [];
	}
}

/**
 * 重推原件这一家引用方此刻活着的图(图库登记用):盘上每一份原件里的每一张图。原件按保留期整天清,留在盘上的
 * 就都是活的。读不动目录或某份原件(不是「不在」)就抛,清扫这一轮一张不删;内容读不懂的原件作废了(`load` 也
 * 当它不存在),不算引用 —— 但**宁多勿少**:不过 schema,只在 JSON 里认「形状对的引用字符串」,别的格出了问题
 * 也不连累它引用的图。
 */
export async function listRepushImageRefs(dataRoot: string): Promise<ImageRef[]> {
	const root = dataPath(dataRoot, "history", "repush");
	let days: string[];
	try {
		days = (await readdir(root)).filter((d) => DAY_DIR.test(d));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	const out: ImageRef[] = [];
	for (const day of days) {
		let names: string[];
		try {
			names = (await readdir(join(root, day))).filter((name) => name.endsWith(".json"));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw err;
		}
		for (const name of names) {
			let text: string;
			try {
				text = await readFile(join(root, day, name), "utf8");
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw err;
			}
			out.push(...imageRefsIn(text));
		}
	}
	return out;
}

/**
 * 一份原件的 JSON 文本里所有图的引用:`image` 格(整张图的消息)、composite 图段里的 `image` 格、图集每张图带着的 `ref`。
 * 读不懂的文本没有引用。
 */
function imageRefsIn(text: string): ImageRef[] {
	let snapshot: unknown;
	try {
		snapshot = JSON.parse(text);
	} catch {
		return [];
	}
	const out: ImageRef[] = [];
	const take = (value: unknown) => {
		if (typeof value === "string" && IMAGE_REF_PATTERN.test(value)) out.push(value);
	};
	const messages = (snapshot as { messages?: unknown } | null)?.messages;
	if (!Array.isArray(messages)) return out;
	for (const message of messages) {
		const payload = (
			message as { payload?: { image?: unknown; segments?: unknown; images?: unknown } } | null
		)?.payload;
		take(payload?.image);
		if (Array.isArray(payload?.segments)) {
			for (const seg of payload.segments) take((seg as { image?: unknown } | null)?.image);
		}
		if (Array.isArray(payload?.images)) {
			for (const image of payload.images) take((image as { ref?: unknown } | null)?.ref);
		}
	}
	return out;
}
