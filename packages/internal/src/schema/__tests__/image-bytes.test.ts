/**
 * 图片字节的格式与宽高识别。只读文件头,不解码。
 */

import { describe, expect, it } from "vite-plus/test";
import { readImageSize, sniffImageFormat } from "../image-bytes";

const MAGIC = {
	png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
	jpeg: [0xff, 0xd8, 0xff, 0xe0],
	webp: [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8 ")],
	gif: [...Buffer.from("GIF89a")],
	svg: [...Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
} as const;

/** 一张 `format` 格式的「图」,总长 `size` 字节(至少是文件头那么长)。 */
function image(format: keyof typeof MAGIC, size = 32): Uint8Array {
	const head = MAGIC[format];
	const bytes = new Uint8Array(Math.max(size, head.length));
	bytes.set(head);
	return bytes;
}

describe("按文件头认图的格式", () => {
	it("四种位图认得出,SVG / 空的 / 残缺的认不出", () => {
		expect(sniffImageFormat(image("png"))).toBe("png");
		expect(sniffImageFormat(image("jpeg"))).toBe("jpeg");
		expect(sniffImageFormat(image("webp"))).toBe("webp");
		expect(sniffImageFormat(image("gif"))).toBe("gif");
		expect(sniffImageFormat(image("svg"))).toBeUndefined();
		expect(sniffImageFormat(new Uint8Array())).toBeUndefined();
		// 只有 RIFF 没有 WEBP 的(wav 就是这样)。
		expect(
			sniffImageFormat(
				new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WAVE")]),
			),
		).toBeUndefined();
	});
});

// ---- 读宽高:按规范手搓文件头,只有决定宽高的那几个字节是真的 --------------------------------

const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];

function pngOf(width: number, height: number): Uint8Array {
	// 签名 + IHDR(长 13):宽、高各 4 字节大端,后面是位深 / 颜色类型等。
	return new Uint8Array([
		...MAGIC.png,
		...u32be(13),
		...Buffer.from("IHDR"),
		...u32be(width),
		...u32be(height),
		8,
		6,
		0,
		0,
		0,
	]);
}

/** JPEG:SOI、一段 APP0、一段哈夫曼表(C4 不是帧头,别认错)、帧头 `sof`,再来一截熵编码数据。 */
function jpegOf(width: number, height: number, sof = 0xc0): Uint8Array {
	const app0 = [0xff, 0xe0, ...u16be(16), ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0];
	const dht = [0xff, 0xc4, ...u16be(5), 0, 1, 2];
	const frame = [0xff, sof, ...u16be(17), 8, ...u16be(height), ...u16be(width), 3];
	return new Uint8Array([
		0xff,
		0xd8,
		...app0,
		// 段与段之间允许塞填充的 0xff。
		0xff,
		...dht,
		...frame,
		...new Array(15).fill(0),
	]);
}

function webpOf(chunk: "VP8 " | "VP8L" | "VP8X", width: number, height: number): Uint8Array {
	const riff = (body: number[]) =>
		new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP"), ...body]);
	switch (chunk) {
		case "VP8 ":
			// 有损:3 字节帧标记 + 起始码 9d 01 2a,再是宽、高(各 14 位,小端)。
			return riff([
				...Buffer.from("VP8 "),
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0x9d,
				0x01,
				0x2a,
				...u16le(width),
				...u16le(height),
			]);
		case "VP8L": {
			// 无损:签名 0x2f,之后 4 字节小端里前 14 位是宽 - 1、再 14 位是高 - 1。
			const bits = ((width - 1) | ((height - 1) << 14)) >>> 0;
			return riff([
				...Buffer.from("VP8L"),
				0,
				0,
				0,
				0,
				0x2f,
				bits & 0xff,
				(bits >> 8) & 0xff,
				(bits >> 16) & 0xff,
				(bits >>> 24) & 0xff,
			]);
		}
		case "VP8X":
			// 扩展格式(动图 / 带透明):画布宽 - 1、高 - 1 各 3 字节小端。
			return riff([
				...Buffer.from("VP8X"),
				10,
				0,
				0,
				0,
				0x10,
				0,
				0,
				0,
				...u24le(width - 1),
				...u24le(height - 1),
			]);
	}
}

function gifOf(width: number, height: number): Uint8Array {
	return new Uint8Array([...MAGIC.gif, ...u16le(width), ...u16le(height), 0xf7, 0, 0]);
}

describe("读图的宽高(卡片的图廊判长图要用)", () => {
	it("png:IHDR 里的宽高", () => {
		expect(readImageSize(pngOf(1080, 1920))).toEqual({ width: 1080, height: 1920 });
	});

	it("jpeg:跳过 APP0 与哈夫曼表,读帧头;基线与渐进式都认", () => {
		expect(readImageSize(jpegOf(640, 480))).toEqual({ width: 640, height: 480 });
		expect(readImageSize(jpegOf(1242, 2688, 0xc2))).toEqual({ width: 1242, height: 2688 });
	});

	it("webp:有损 / 无损 / 扩展三种块都认", () => {
		expect(readImageSize(webpOf("VP8 ", 800, 600))).toEqual({ width: 800, height: 600 });
		expect(readImageSize(webpOf("VP8L", 1024, 3000))).toEqual({ width: 1024, height: 3000 });
		expect(readImageSize(webpOf("VP8X", 720, 1280))).toEqual({ width: 720, height: 1280 });
	});

	it("gif:逻辑屏幕的宽高", () => {
		expect(readImageSize(gifOf(320, 240))).toEqual({ width: 320, height: 240 });
	});

	it("读不出来就是 undefined:SVG、空的、截断的、没有帧头的、不认识的 webp 块、宽高是 0 的", () => {
		expect(readImageSize(image("svg"))).toBeUndefined();
		expect(readImageSize(new Uint8Array())).toBeUndefined();
		expect(readImageSize(pngOf(10, 10).slice(0, 20))).toBeUndefined();
		expect(readImageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeUndefined();
		expect(readImageSize(jpegOf(640, 480).slice(0, 30))).toBeUndefined();
		const unknownChunk = webpOf("VP8 ", 8, 8);
		unknownChunk.set(Buffer.from("VP8Q"), 12);
		expect(readImageSize(unknownChunk)).toBeUndefined();
		expect(readImageSize(gifOf(0, 240))).toBeUndefined();
	});
});
