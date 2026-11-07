import { t as serverText } from "./i18n.js";
/**
 * 推送历史里跟图有关的格 → 图库(ADR-0022 决策 9 下 10-04「⑳ 开片」的 🔗,⑳d)。
 *
 * 0.x 的历史图放在 `history/img/<名字>`:行里的消息存名字(`payload.imageRef`),行存 B 站远端头像网址
 * (`uavatarSnapshot`);重推原件里的图是 `{ ref, mime, own? }`(`own` = 在原件自己的日目录 `repush/<日>/` 里,
 * 否则在 `history/img/`)。`history/img/` 与原件自存的图都不整目录搬(`historyInputReason`),当成迁移的输入:
 *
 * - **保留期内的行**(水位线之后的日子):消息里的 `imageRef` 逐个去 `history/img/` 读字节、按嗅探认格式、**复制**
 *   进新代的图库(不硬链接:图库靠刷新修改时间做宽限期,硬链接会改到第 0 代那份),在原位换成 `image: <引用>`;
 *   对不上的(文件不在、嗅探不过、超 8MB、不是普通文件、名字不干净)这一格拿掉,行与文字照留。
 * - **水位线及以前的行**:`imageRef` 直接拿掉,**不读图文件** —— 重度用户这里是几万张,读一遍太贵。文字照留。
 * - **`uavatarSnapshot` 一律丢掉**:它是 B 站远端网址,头像快照现在只装图库引用,迁移不联网。
 * - **重推原件**(过了保留期的整天目录,清扫时已经删了):每个 `{ ref, mime, own? }` 换成引用,`own` 的从原件
 *   自己的日目录读,其余从 `history/img/` 读。**任何一张读不到,这一份原件整份作废不搬**(运行时也一样:原件的图
 *   读不回来整份作废,绝不交一份缺图的原料出去)。
 * - 没有任何行或原件引用的图(0.x 攒下的孤儿)不搬。
 *
 * 行级的改写是两个纯函数({@link historyImageNames} 先收集、{@link migrateHistoryImageCells} 再改写,改写时查一张
 * 现成的表),读盘与复制在 {@link createHistoryImages} 里:同一个文件只读一次(行和原件常引用同一张),内容一样的
 * 只落一份。它们改的是**已经迁成最新形状**的行(`history.ts` 的 `migrateHistoryLine`),已经是现在形状的行与补丁行
 * 也可能带着这两格,所以不看行是不是刚被改写过;推不出「替谁发的」的坏行(没有 `identity`)整行原样。
 *
 * 不联网、不走 `ImageWriter`:新代的图库此刻没在跑,这里直接落文件,文件名只认 `imageRefOf` 一份规矩。
 */

import { join } from "node:path";
import type { ImageRef } from "@bilibili-notify/internal";
import { isPatchLine } from "../history/store.js";
import { isPlainObject, leftoverReason, listFiles, parseJsonLine } from "./files.js";
import { createImageCopier, isCleanFileName } from "./image-library.js";

/**
 * 0.x 的历史目录 `history/` 里哪些东西不随整棵目录搬、只作迁移的输入(`zero-generation.ts` 的 `history` 一项用):
 * `img/` 整个目录,和重推原件日目录里不是 `.json` 的东西(原件自己存的图)。给相对 `history/` 的路径(`/` 分隔),
 * 回「为什么」就是不搬。
 */
export function historyInputReason(path: string): string | undefined {
	if (path === "img") {
		return serverText("service.migration.history-images.text.1");
	}
	const own = /^repush\/[^/]+\/([^/]+)$/.exec(path)?.[1];
	if (own !== undefined && !own.endsWith(".json")) {
		return serverText("service.migration.history-images.text.2");
	}
	return undefined;
}

/**
 * 这一行是不是迁移该碰图格的:带这两格之一(先用子串筛掉绝大多数行,免得几十万行都 `JSON.parse` 一遍),而且是
 * 现在形状的补丁行或带 `identity` 的行。回解开的对象;不该碰的回 `undefined`。
 */
function recordWithImageCells(line: string): Record<string, unknown> | undefined {
	if (!line.includes('"imageRef"') && !line.includes('"uavatarSnapshot"')) return undefined;
	const record = parseJsonLine(line);
	if (!isPlainObject(record)) return undefined;
	return isPatchLine(line) || "identity" in record ? record : undefined;
}

/** 一行里每条消息的 `payload`(是普通对象的)。 */
function payloadsOf(record: Record<string, unknown>): Record<string, unknown>[] {
	if (!Array.isArray(record.messages)) return [];
	return record.messages.flatMap((message: unknown) =>
		isPlainObject(message) && isPlainObject(message.payload) ? [message.payload] : [],
	);
}

/** 一行(jsonl 的一行原文,已迁成最新形状)里消息引用着的 `history/img/` 文件名。不该碰的行没有。 */
export function historyImageNames(line: string): string[] {
	const record = recordWithImageCells(line);
	if (record === undefined) return [];
	return payloadsOf(record).flatMap((payload) =>
		typeof payload.imageRef === "string" ? [payload.imageRef] : [],
	);
}

/**
 * 一行的图格迁成现在的样子:每条消息的 `imageRef: <名字>` 在**原位**换成 `image: <引用>`(`resolve` 对不上回
 * `undefined` 就拿掉),行的 `uavatarSnapshot` 丢掉。别的格一个字不动;不该碰的行、没有这两格的行回原文(同一个字符串)。
 */
export function migrateHistoryImageCells(
	line: string,
	resolve: (name: string) => ImageRef | undefined,
): string {
	const record = recordWithImageCells(line);
	if (record === undefined) return line;
	const next: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (key === "uavatarSnapshot") continue;
		next[key] = key === "messages" ? swapMessageImages(value, resolve) : value;
	}
	return JSON.stringify(next);
}

function swapMessageImages(
	messages: unknown,
	resolve: (name: string) => ImageRef | undefined,
): unknown {
	if (!Array.isArray(messages)) return messages;
	return messages.map((message: unknown) => {
		if (!isPlainObject(message) || !isPlainObject(message.payload)) return message;
		if (!("imageRef" in message.payload)) return message;
		const payload: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(message.payload)) {
			if (key !== "imageRef") {
				payload[key] = value;
				continue;
			}
			const ref = typeof value === "string" ? resolve(value) : undefined;
			if (ref !== undefined) payload.image = ref;
		}
		return { ...message, payload };
	});
}

interface HistoryImageResult {
	/** 复制进图库的图:第 0 代里的路径(相对第 0 代根,`/` 分隔)→ 引用,每个源文件一条。 */
	copied: { from: string; ref: ImageRef }[];
	/** `history/img/` 里只被过了保留期的行引用的文件有几个(没带过来)。 */
	expired: number;
	/** 保留期内的行引用、却带不过来的图有几张(已经从那些行里拿掉)。 */
	dropped: number;
	/** `history/img/` 里没有任何行或原件引用的文件有几个(没带过来;临时文件之类的残留不算)。 */
	orphans: number;
}

export interface HistoryImages {
	/**
	 * 一个日文件(`day` = `YYYY-MM-DD`)的行(已迁成最新形状)的图格迁完的样子。水位线及以前的日子拿掉图格、
	 * 不读图文件;保留期内的把引用着的图复制进图库。
	 */
	rewriteDay(day: string, lines: readonly string[]): Promise<string[]>;
	/**
	 * 一份重推原件(日目录 `day`)里每个旧的图格换成引用。有一张图读不到回 `null`(这份原件作废);什么都不用换回原对象。
	 * 已经是引用的图格原样(对新代再迁一次不改字节)。
	 */
	rewriteSnapshot(
		day: string,
		snapshot: Record<string, unknown>,
	): Promise<Record<string, unknown> | null>;
	/** 迁完以后的账。要在所有日文件与原件都过完之后调。 */
	result(): Promise<HistoryImageResult>;
}

export function createHistoryImages(options: {
	/** 第 0 代的历史目录 `history`(只读)。 */
	zeroDir: string;
	/** 新代的图库目录 `images/`。 */
	imagesDir: string;
	/** 水位线:这一天及以前的行过了保留期。还没有水位线就是全都在保留期内。 */
	clearedThrough: string | undefined;
}): HistoryImages {
	const { zeroDir, imagesDir, clearedThrough } = options;
	const imgDir = join(zeroDir, "img");
	const copier = createImageCopier(imagesDir);
	/** 复制过的源文件(相对第 0 代根)→ 引用。 */
	const copied = new Map<string, ImageRef>();
	/** 各路引用过的 `history/img/` 文件名:账里的「过期」「孤儿」靠它们算。 */
	const liveNames = new Set<string>();
	const deadNames = new Set<string>();
	const snapshotNames = new Set<string>();
	/** 保留期内的行引用、却对不上的名字。 */
	const failedNames = new Set<string>();

	const isLive = (day: string) => clearedThrough === undefined || day > clearedThrough;

	async function copyFrom(from: string, path: string): Promise<ImageRef | undefined> {
		const ref = await copier.copyFile(path);
		if (ref !== undefined) copied.set(from, ref);
		return ref;
	}

	/** `history/img/<名字>` 里的一张图。名字来自旧数据,是不可信输入:只认干净的文件名。 */
	async function fromLibrary(name: string): Promise<ImageRef | undefined> {
		if (!isCleanFileName(name)) return undefined;
		return copyFrom(`history/img/${name}`, join(imgDir, name));
	}

	/** 原件自己存的图:`repush/<日>/<名字>`。 */
	async function fromSnapshotDay(day: string, name: string): Promise<ImageRef | undefined> {
		if (!isCleanFileName(name)) return undefined;
		return copyFrom(`history/repush/${day}/${name}`, join(zeroDir, "repush", day, name));
	}

	/** 原件里一个图格怎么迁:`undefined` = 不用动(已经是引用,或认不得的形状原样留着);`null` = 对不上。 */
	async function convertCell(day: string, cell: unknown): Promise<ImageRef | undefined | null> {
		if (!isPlainObject(cell)) return undefined;
		const { ref, own } = cell;
		if (typeof ref !== "string") return null;
		if (own !== true) snapshotNames.add(ref);
		const resolved = own === true ? await fromSnapshotDay(day, ref) : await fromLibrary(ref);
		return resolved ?? null;
	}

	/** 一条消息里的图格换完的样子;`null` = 有一张对不上。 */
	async function convertMessage(day: string, message: unknown): Promise<unknown | null> {
		if (!isPlainObject(message) || !isPlainObject(message.payload)) return message;
		const payload = message.payload;
		let changed = false;
		const next: Record<string, unknown> = { ...payload };
		if ("image" in payload) {
			const ref = await convertCell(day, payload.image);
			if (ref === null) return null;
			if (ref !== undefined) {
				next.image = ref;
				changed = true;
			}
		}
		if (Array.isArray(payload.segments)) {
			const segments: unknown[] = [];
			for (const seg of payload.segments as unknown[]) {
				// 段的判别键已经由前一步(`history.ts` 的 `migrateRepushSnapshot`)改成 `kind`。
				if (!isPlainObject(seg) || seg.kind !== "image") {
					segments.push(seg);
					continue;
				}
				const ref = await convertCell(day, seg.image);
				if (ref === null) return null;
				if (ref === undefined) {
					segments.push(seg);
				} else {
					segments.push({ ...seg, image: ref });
					changed = true;
				}
			}
			next.segments = segments;
		}
		return changed ? { ...message, payload: next } : message;
	}

	return {
		async rewriteDay(day, lines) {
			if (!isLive(day)) {
				return lines.map((line) =>
					migrateHistoryImageCells(line, (name) => {
						deadNames.add(name);
						return undefined;
					}),
				);
			}
			const resolved = new Map<string, ImageRef | undefined>();
			for (const line of lines) {
				for (const name of historyImageNames(line)) {
					if (resolved.has(name)) continue;
					liveNames.add(name);
					const ref = await fromLibrary(name);
					resolved.set(name, ref);
					if (ref === undefined) failedNames.add(name);
				}
			}
			return lines.map((line) => migrateHistoryImageCells(line, (name) => resolved.get(name)));
		},

		async rewriteSnapshot(day, snapshot) {
			if (!Array.isArray(snapshot.messages)) return snapshot;
			let changed = false;
			const messages: unknown[] = [];
			for (const message of snapshot.messages as unknown[]) {
				const converted = await convertMessage(day, message);
				if (converted === null) return null;
				if (converted !== message) changed = true;
				messages.push(converted);
			}
			return changed ? { ...snapshot, messages } : snapshot;
		},

		async result() {
			const present = new Set(
				(await listFiles(imgDir, "")).filter((name) => !leftoverReason(name)),
			);
			const referenced = new Set([...liveNames, ...deadNames, ...snapshotNames]);
			const expired = [...deadNames].filter(
				(name) => present.has(name) && !liveNames.has(name) && !snapshotNames.has(name),
			).length;
			const orphans = [...present].filter((name) => !referenced.has(name)).length;
			return {
				copied: [...copied].map(([from, ref]) => ({ from, ref })),
				expired,
				dropped: failedNames.size,
				orphans,
			};
		},
	};
}
