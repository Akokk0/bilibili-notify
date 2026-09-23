import { Buffer } from "node:buffer";

/**
 * 头像测试用的几种字节(ADR-0019 决策 49)。宿主只认**开头那几个魔数字节**,不解码图 ——
 * 所以这里只要开头对得上;PNG 那张是一张真的 1×1,别的只有魔数加几个填充字节。
 */

/** 一张真的 1×1 PNG。 */
export const PNG_BYTES = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);

/** JPEG:FF D8 FF 打头。 */
export const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

/** WEBP:`RIFF` + 四字节长度 + `WEBP`。 */
export const WEBP_BYTES = Buffer.concat([
	Buffer.from("RIFF", "ascii"),
	Buffer.from([0x1a, 0x00, 0x00, 0x00]),
	Buffer.from("WEBPVP8 ", "ascii"),
	Buffer.from([0x00, 0x00, 0x00, 0x00]),
]);

/** 拼一个 `data:image/<type>;base64,…` —— 声明的类型与字节可以故意对不上。 */
export function avatarDataUrl(type: "png" | "jpeg" | "webp" | "svg+xml", bytes: Buffer): string {
	return `data:image/${type};base64,${bytes.toString("base64")}`;
}
