import { Buffer } from "node:buffer";

/**
 * 拓展作品测试用的图字节。宿主读文件头认格式、取宽高,不解码图 —— 所以这里只要头对得上。
 * `tag` 塞进尾巴,好让每张的字节(图库里也就是引用)各不相同。
 */

const u32be = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];

/** 一张宽高真写在文件头里的 png;`padTo` 把它补到至少这么多字节(测大小线用)。 */
export function png(width: number, height: number, tag = 0, padTo = 0): Uint8Array {
	const head = [
		0x89,
		0x50,
		0x4e,
		0x47,
		0x0d,
		0x0a,
		0x1a,
		0x0a,
		...u32be(13),
		...Buffer.from("IHDR"),
		...u32be(width),
		...u32be(height),
		8,
		6,
		0,
		0,
		0,
		tag,
	];
	const bytes = new Uint8Array(Math.max(head.length, padTo));
	bytes.set(head);
	return bytes;
}

/** 一张宽高写在文件头里的 gif(认成动图)。 */
export function gif(width: number, height: number, tag = 0): Uint8Array {
	return new Uint8Array([...Buffer.from("GIF89a"), ...u16le(width), ...u16le(height), 0, 0, tag]);
}
