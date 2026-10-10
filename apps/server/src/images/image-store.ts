/**
 * 图库:所有图按内容摘要存成 `images/<sha256>.<ext>`(ADR-0022 决策 9),引用 `ImageRef` 就是这个文件名。
 *
 * - 只收 png / jpg / gif / webp,扩展名按嗅探内容得出、JPEG 一律叫 jpg —— 调用方说它是什么格式不算数;
 *   SVG 一律拒。
 * - 单张 8MB 是图库自己的线;上传那层更紧的规矩(5MB、聊天附件不收 gif)留在上传那层。
 * - 同一份字节再存一次不重写、只刷新修改时间:清扫的新图宽限期按修改时间算。
 * - 存图的失败都是结果、不抛(docs/agents/conventions/failure-results.md 规矩 8):不收的图回 `invalid`,磁盘写失败
 *   (盘满、权限不对)回 `unavailable`。抛出来的只有关门之后还来存的那一种。
 *
 * 以上几条的来由见 ADR-0022 决策 9 下 10-03 的 🔗。存储本身是 {@link createAssetStore} 按摘要取名的那一种。
 * 引用的形状({@link isValidImageRef})、一份字节会得到的引用({@link imageRefOf})、引用的扩展名({@link imageExtOf})
 * 是纯函数,不碰盘,谁都能用 —— 迁移开新代时直接往 `images/` 落文件,要事先知道文件名。
 *
 * **谁引用、谁才能存**(同一决策下 10-04「⑳ 开片」的 🔗):图按内容起名,同一张会被几家共用,所以没有
 * 「删这张图」的口,只有清扫 —— 过了宽限期、又没有哪家引用的才删。漏登记的引用方的图会被当垃圾清掉而
 * 门禁全绿,所以存图的口不挂在图库上:先 {@link ImageStore.register} 交出「列出我引用的图」,才拿得到
 * {@link ImageWriter}。引用只许从两处来:自己刚 `put` 的,或者抄别家的并 `keep` 过的 —— 两样都会刷新
 * 修改时间,清扫正扫到一半时这张图也在宽限期里。
 *
 * 一处例外(主人 10-05 认的):拓展上报的图先用 {@link imageRefOf} 算出引用、出卡前才真 `put`
 * (`images/image-writes.ts` 的 `deferImageWrites`)。用它的有两条路:拓展作品(被屏蔽的作品因此一张图都
 * 不写盘;算出引用到写盘之间只有过滤读这份 `Post`,只看文字和形状、不读图)与拓展直播卡(版式把卡藏起来、关了
 * 出图时不写盘;封面与头像的字节住在在播表里,每次出卡再存一遍)。写盘时核对图库回的引用与算的一致。拓展上报
 * 改成直接交引用(契约 v3,3b)后这一步消失;别处不许照这个样子做。
 */

import { createHash } from "node:crypto";
import { readdir, stat, unlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import {
	createSerialQueue,
	fail,
	type IMAGE_REF_EXTENSIONS,
	IMAGE_REF_PATTERN,
	type ImageRef,
	ok,
	type ReportImageFormat,
	type Result,
	sniffImageFormat,
} from "@bilibili-notify/internal";
import { createAssetStore } from "../assets/asset-store.js";

/** 单张图的字节上限。 */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** 图库收的格式:扩展名 → mime。键与 internal 的 `IMAGE_REF_EXTENSIONS` 钉成同一组(多一种少一种都编译不过)。 */
const IMAGE_FORMATS = {
	png: "image/png",
	jpg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
} as const satisfies Record<(typeof IMAGE_REF_EXTENSIONS)[number], string>;

/** 嗅探出来的格式 → 图库里的扩展名。 */
const EXT_OF_FORMAT = {
	png: "png",
	jpeg: "jpg",
	gif: "gif",
	webp: "webp",
} as const satisfies Record<ReportImageFormat, keyof typeof IMAGE_FORMATS>;

/**
 * 这个字符串是不是一个图库引用的形状。纯函数、不碰盘、不管文件在不在:从请求里进来的引用先过这一道,
 * 形状不对的连 `read` / `keep` 都不必问。形状本体是 internal 的 `IMAGE_REF_PATTERN`(历史行与重推原件的 schema 也
 * 用它);存储那头 `createAssetStore` 按 `IMAGE_FORMATS` 与 sha256 取名自己也认一遍,测试钉着两边答案一致。
 */
export function isValidImageRef(ref: string): boolean {
	return IMAGE_REF_PATTERN.test(ref);
}

/**
 * 一份字节存进图库会得到的引用;不是图库收的图(格式不认、超 8MB)回 `undefined`。不碰盘。
 *
 * 给**不走 {@link ImageWriter}、直接落文件**的调用方用(迁移:新代的图库此刻没在跑)—— 它们得事先知道
 * 文件名。取名规矩只此一份:嗅探 → 扩展名(JPEG 一律 jpg) → 摘要,和 `put` 起的名字一致(测试钉着)。
 */
export function imageRefOf(bytes: Uint8Array): ImageRef | undefined {
	if (bytes.byteLength > IMAGE_MAX_BYTES) return undefined;
	const format = sniffImageFormat(bytes);
	if (!format) return undefined;
	return `${createHash("sha256").update(bytes).digest("hex")}.${EXT_OF_FORMAT[format]}`;
}

/** 引用的扩展名(png / jpg / gif / webp);形状不对回 `undefined`。扩展名自己就是引用的一部分,不用另存。 */
export function imageExtOf(ref: string): string | undefined {
	return isValidImageRef(ref) ? ref.slice(ref.lastIndexOf(".") + 1) : undefined;
}

/** 新图宽限期:刚存进来、还没被哪一行引用的图留这么久(写死,不做设置)。 */
export const IMAGE_GRACE_MS = 24 * 60 * 60 * 1000;

/** 一家引用方:落盘的东西里装着图库引用的那一处(会话、资料缓存、历史行、重推原件)。 */
export interface ImageReferrer {
	/** 给人看的名字,也是登记表里的键;重名当场抛。 */
	name: string;
	/**
	 * 此刻还活着的引用。每家只交自己的,清扫不并成一张表来问。列不出来就抛 —— 清扫宁可这一轮一张不删,
	 * 也不拿残缺的名单去删图。
	 */
	listRefs(): Promise<Iterable<ImageRef>>;
}

/** 登记成引用方才拿得到的两个口。 */
export interface ImageWriter {
	/**
	 * 存一张图,回引用;不是收的那几种图、超上限回 `invalid`,磁盘写失败回 `unavailable`(`message` 带着原话,
	 * 里头可能有路径 —— 往面板回之前别原样带出去)。不抛;关门之后还来存是例外,那是写道的 `SerialQueueClosedError`。
	 */
	put(bytes: Uint8Array): Promise<Result<{ ref: ImageRef }>>;
	/**
	 * 续期:要把别家的引用抄进自己这儿之前调(新历史行抄资料缓存里的头像)。图已经不在回 `false`,
	 * 那个引用就别抄了。
	 */
	keep(ref: ImageRef): Promise<boolean>;
}

/** 一轮清扫的结果。 */
export interface ImageSweepReport {
	/** 删掉的图。 */
	removed: ImageRef[];
	/** 删掉的图一共多少字节(删的那一刻重看的文件大小之和)。 */
	removedBytes: number;
	/** 过了宽限期、因为还有人引用而留下的张数。 */
	referenced: number;
	/** 还在宽限期里的张数。 */
	inGrace: number;
}

/** 图库里一张图的用量:谁在引用它由 `holders` 说,分类是读的人的事。 */
export interface ImageUsage {
	ref: ImageRef;
	sizeBytes: number;
	/** 文件修改时间(毫秒时间戳);清扫的宽限期就按它算。 */
	modifiedAt: number;
	/** 引用它的引用方名字({@link ImageReferrer.name}),登记顺序;没人引用是空数组。 */
	holders: string[];
}

export interface ImageStore {
	/** 按引用读字节与 mime;引用不合规矩(不碰盘)或文件不在回 `undefined`。 */
	read(ref: string): Promise<{ bytes: Buffer; mime: string } | undefined>;
	/** 登记一家引用方,回它存图用的口。 */
	register(referrer: ImageReferrer): ImageWriter;
	/**
	 * 盘上每张图的用量与引用方。成本:一张图一次 `stat`、每家 `listRefs` 一次,**不缓存** —— 数量级是图的张数
	 * (重度用户 90 天的历史配图 + 头像约万级),调用方嫌贵自己加 TTL。与 `sweep` 同一口径:任何一家列不出
	 * 引用就整个抛,不回残缺的名单(残缺的 `holders` 会把还有人用的图当成没人用)。读口,关门之后照常。
	 */
	usage(): Promise<ImageUsage[]>;
	/** 清扫一轮:删过了宽限期又没有哪家引用的图。任何一家列不出引用就抛,一张不删。 */
	sweep(options: { now: Date }): Promise<ImageSweepReport>;
	/** 关门:此后存图、续期、清扫都被拒,读照常;等在途的写完才返回。 */
	close(): Promise<void>;
}

/** 写道的唯一一个键:存、续期、删排成一队,删之前在队里再看一眼修改时间(见 `removeIfStale`)。 */
const WRITE_KEY = "images";

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

export function createImageStore(options: { dir: string }): ImageStore {
	const { dir } = options;
	const assets = createAssetStore({
		dir,
		formats: IMAGE_FORMATS,
		maxBytes: IMAGE_MAX_BYTES,
		naming: { kind: "sha256" },
	});
	const writes = createSerialQueue();
	const referrers = new Map<string, ImageReferrer>();

	/** 盘上每张图的修改时间与大小;目录还没建就是空的。每张图一次 `stat`。 */
	async function scanDisk(): Promise<Map<ImageRef, { mtimeMs: number; size: number }>> {
		let names: string[];
		try {
			names = await readdir(dir);
		} catch (error) {
			if (isMissing(error)) return new Map();
			throw error;
		}
		const found = new Map<ImageRef, { mtimeMs: number; size: number }>();
		for (const name of names.filter(assets.isValidId)) {
			try {
				const { mtimeMs, size } = await stat(join(dir, name));
				found.set(name, { mtimeMs, size });
			} catch (error) {
				if (!isMissing(error)) throw error;
			}
		}
		return found;
	}

	/**
	 * 各家此刻的引用,按图归拢:图 → 引用它的引用方名字。`sweep` 与 `usage` 共用这一处,口径不会两样:
	 * 每家只问一次、任何一家抛错整个抛(不拿残缺的名单做任何判断)。
	 */
	async function collectHolders(): Promise<Map<ImageRef, string[]>> {
		const holders = new Map<ImageRef, string[]>();
		for (const referrer of referrers.values()) {
			for (const ref of new Set(await referrer.listRefs())) {
				const names = holders.get(ref);
				if (names) names.push(referrer.name);
				else holders.set(ref, [referrer.name]);
			}
		}
		return holders;
	}

	/**
	 * 删一张图,但先在队里重新看修改时间:清扫看完修改时间到动手删之间,别人可能又存了同一份字节(存是
	 * 刷新修改时间并回 ok),不重看的话那边就拿着一个悬空的引用。宽限期挡不住这个窗口,要靠排队。
	 */
	function removeIfStale(ref: ImageRef, cutoff: number): Promise<number | undefined> {
		return writes.run(WRITE_KEY, async () => {
			const path = join(dir, ref);
			try {
				const { mtimeMs, size } = await stat(path);
				if (mtimeMs > cutoff) return undefined;
				await unlink(path);
				return size;
			} catch (error) {
				if (isMissing(error)) return undefined;
				throw error;
			}
		});
	}

	const writer: ImageWriter = {
		put(bytes) {
			return writes.run(WRITE_KEY, async () => {
				const format = sniffImageFormat(bytes);
				if (!format) return fail("invalid", "不是图库收的图(只收 png / jpg / gif / webp)");
				try {
					const result = await assets.put({ bytes, ext: EXT_OF_FORMAT[format] });
					return result.ok ? ok({ ref: result.id }) : result;
				} catch (error) {
					// 资产库那头磁盘写失败是抛(刷新修改时间、建目录、落文件都可能);图库这一层收成结果,原话照带。
					return fail("unavailable", `图库写盘失败:${String(error)}`);
				}
			});
		},
		keep(ref) {
			return writes.run(WRITE_KEY, async () => {
				const path = assets.pathOf(ref);
				if (path === null) return false;
				const now = new Date();
				try {
					await utimes(path, now, now);
					return true;
				} catch (error) {
					if (isMissing(error)) return false;
					throw error;
				}
			});
		},
	};

	return {
		async read(ref) {
			return (await assets.read(ref)) ?? undefined;
		},

		register(referrer) {
			if (referrers.has(referrer.name)) {
				throw new Error(`图库引用方「${referrer.name}」登记了两次`);
			}
			referrers.set(referrer.name, referrer);
			return writer;
		},

		async usage() {
			// 次序与 sweep 一样:先看盘、再问引用。
			const disk = await scanDisk();
			const holders = await collectHolders();
			return [...disk].map(([ref, { mtimeMs, size }]) => ({
				ref,
				sizeBytes: size,
				modifiedAt: mtimeMs,
				holders: holders.get(ref) ?? [],
			}));
		},

		async sweep({ now }) {
			// 关了门的图库不许再动盘:借写道的关门判定,排一个空任务。
			await writes.run(WRITE_KEY, () => {});
			const cutoff = now.getTime() - IMAGE_GRACE_MS;
			// 先看修改时间、再问引用:这之间新写下的引用必然来自 put / keep,它们的图已经回到宽限期里。
			const disk = await scanDisk();
			const held = await collectHolders();
			const report: ImageSweepReport = { removed: [], removedBytes: 0, referenced: 0, inGrace: 0 };
			for (const [ref, { mtimeMs }] of disk) {
				if (mtimeMs > cutoff) report.inGrace += 1;
				else if (held.has(ref)) report.referenced += 1;
				else {
					const freed = await removeIfStale(ref, cutoff);
					if (freed !== undefined) {
						report.removed.push(ref);
						report.removedBytes += freed;
					}
				}
			}
			return report;
		},

		close: () => writes.close(),
	};
}
