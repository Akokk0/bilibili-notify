/**
 * 图库:所有图按内容摘要存成 `images/<sha256>.<ext>`(ADR-0022 决策 9),引用 `ImageRef` 就是这个文件名。
 *
 * - 只收 png / jpg / gif / webp,扩展名按嗅探内容得出、JPEG 一律叫 jpg —— 调用方说它是什么格式不算数;
 *   SVG 一律拒。
 * - 单张 8MB 是图库自己的线;上传那层更紧的规矩(5MB、聊天附件不收 gif)留在上传那层。
 * - 同一份字节再存一次不重写、只刷新修改时间:⑰ 的新图宽限期按修改时间算。
 *
 * 以上几条的来由见 ADR-0022 决策 9 下 10-03 的 🔗。存储本身是 {@link createAssetStore} 按摘要取名的那一种。
 */

import {
	fail,
	type ImageRef,
	ok,
	type ReportImageFormat,
	type Result,
	sniffImageFormat,
} from "@bilibili-notify/internal";
import { createAssetStore } from "../assets/asset-store.js";

/** 单张图的字节上限。 */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** 图库收的格式:扩展名 → mime。 */
const IMAGE_FORMATS = {
	png: "image/png",
	jpg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
} as const;

/** 嗅探出来的格式 → 图库里的扩展名。 */
const EXT_OF_FORMAT = {
	png: "png",
	jpeg: "jpg",
	gif: "gif",
	webp: "webp",
} as const satisfies Record<ReportImageFormat, keyof typeof IMAGE_FORMATS>;

export interface ImageStore {
	/** 存一张图,回引用;不是收的那几种图、超上限回 `invalid`。磁盘写失败是抛错。 */
	put(bytes: Uint8Array): Promise<Result<{ ref: ImageRef }>>;
	/** 按引用读字节与 mime;引用不合规矩(不碰盘)或文件不在回 `undefined`。 */
	read(ref: string): Promise<{ bytes: Buffer; mime: string } | undefined>;
}

export function createImageStore(options: { dir: string }): ImageStore {
	const assets = createAssetStore({
		dir: options.dir,
		formats: IMAGE_FORMATS,
		maxBytes: IMAGE_MAX_BYTES,
		naming: { kind: "sha256" },
	});
	return {
		async put(bytes) {
			const format = sniffImageFormat(bytes);
			if (!format) return fail("invalid", "不是图库收的图(只收 png / jpg / gif / webp)");
			const result = await assets.put({ bytes, ext: EXT_OF_FORMAT[format] });
			return result.ok ? ok({ ref: result.id }) : result;
		},
		async read(ref) {
			return (await assets.read(ref)) ?? undefined;
		},
	};
}
