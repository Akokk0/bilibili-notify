/**
 * 按文件头认图的格式与宽高。只读头、不解码,给图库、取图与来源适配器共用。
 */

export type ReportImageFormat = "png" | "jpeg" | "webp" | "gif";

function startsWith(bytes: Uint8Array, head: readonly number[], at = 0): boolean {
	return bytes.length >= at + head.length && head.every((byte, i) => bytes[at + i] === byte);
}

const ascii = (text: string) => [...text].map((ch) => ch.charCodeAt(0));
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const RIFF = ascii("RIFF");
const WEBP = ascii("WEBP");
const GIF87 = ascii("GIF87a");
const GIF89 = ascii("GIF89a");

/** 按开头那几个字节认图的格式;认不出(SVG、空的、残缺的)是 `undefined`。只看魔数,不解码。 */
export function sniffImageFormat(bytes: Uint8Array): ReportImageFormat | undefined {
	if (startsWith(bytes, PNG_MAGIC)) return "png";
	if (startsWith(bytes, JPEG_MAGIC)) return "jpeg";
	if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return "webp";
	if (startsWith(bytes, GIF87) || startsWith(bytes, GIF89)) return "gif";
	return undefined;
}

/** 一张图的宽高(像素)。 */
export interface ImageSize {
	width: number;
	height: number;
}

const u16be = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u16le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u24le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const u32be = (b: Uint8Array, at: number) =>
	((b[at] << 24) | (b[at + 1] << 16) | u16be(b, at + 2)) >>> 0;

/**
 * JPEG 的帧头(SOF)标记:C0–CF 里除了 C4(哈夫曼表)、C8(保留)、CC(算术编码表)。基线、渐进式、
 * 无损都在里面,宽高都写在同一个位置。
 */
const isJpegFrameMarker = (marker: number) =>
	marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

/** 逐段走到帧头。段长含它自己那两个字节;段之间可能塞着填充的 0xff。 */
function jpegSize(b: Uint8Array): ImageSize | undefined {
	let at = 2;
	while (at + 1 < b.length) {
		if (b[at] !== 0xff) return undefined;
		const marker = b[at + 1];
		if (marker === 0xff) {
			at++;
			continue;
		}
		// 没有长度的独立标记:SOI、RST0–7、TEM。走到图像数据结束(EOI)或扫描开始(SOS)还没见到帧头
		// 就是没有。
		if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
			at += 2;
			continue;
		}
		if (marker === 0xd9 || marker === 0xda) return undefined;
		if (at + 3 >= b.length) return undefined;
		if (isJpegFrameMarker(marker)) {
			if (at + 8 >= b.length) return undefined;
			return { height: u16be(b, at + 5), width: u16be(b, at + 7) };
		}
		at += 2 + u16be(b, at + 2);
	}
	return undefined;
}

/** WebP 的第一块:有损 `VP8 `、无损 `VP8L`、扩展 `VP8X`(动图 / 带透明)各写各的。 */
function webpSize(b: Uint8Array): ImageSize | undefined {
	const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
	switch (chunk) {
		case "VP8 ":
			// 3 字节帧标记之后是起始码 9d 01 2a,再是宽、高各 14 位(高两位是缩放,不算)。
			if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return undefined;
			return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
		case "VP8L": {
			// 签名 0x2f 之后 4 字节小端:前 14 位是宽 - 1,再 14 位是高 - 1。
			if (b.length < 25 || b[20] !== 0x2f) return undefined;
			const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
			return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
		}
		case "VP8X":
			// 画布宽 - 1、高 - 1 各 3 字节小端。
			if (b.length < 30) return undefined;
			return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
		default:
			return undefined;
	}
}

/**
 * 按文件头读图的宽高,只读头、不解码(ADR-0019 决策 55:拓展只交字节,宽高 BN 自己读 —— 卡片的图廊
 * 判「长图」要用)。四种位图认得出;SVG、残缺的、宽高读出来是 0 的一律 `undefined`(出卡照样出,
 * 只是不判长图)。
 */
export function readImageSize(bytes: Uint8Array): ImageSize | undefined {
	let size: ImageSize | undefined;
	switch (sniffImageFormat(bytes)) {
		case "png":
			// 签名之后第一块必是 IHDR:宽、高各 4 字节大端。
			if (bytes.length < 24 || !startsWith(bytes, ascii("IHDR"), 12)) return undefined;
			size = { width: u32be(bytes, 16), height: u32be(bytes, 20) };
			break;
		case "jpeg":
			size = jpegSize(bytes);
			break;
		case "webp":
			size = webpSize(bytes);
			break;
		case "gif":
			// 逻辑屏幕的宽高,小端。
			if (bytes.length < 10) return undefined;
			size = { width: u16le(bytes, 6), height: u16le(bytes, 8) };
			break;
		default:
			return undefined;
	}
	return size && size.width > 0 && size.height > 0 ? size : undefined;
}
