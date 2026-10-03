import { mkdtemp, readdir, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createImageStore, type ImageStore } from "../image-store.js";

/**
 * 图库本体(ADR-0022 决策 9 下 10-03 的 🔗):引用就是文件名 `<sha256>.<ext>`,扩展名按嗅探;只收
 * png / jpg / gif / webp、单张 8MB;同一份字节再存不重写、只刷新修改时间。
 */

const ascii = (text: string) => [...text].map((ch) => ch.charCodeAt(0));
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
/** 上面那份 PNG 字节的 sha256,另算好写死的。 */
const PNG_SHA256 = "4353a1de7e0dcc4e87350e22d5c9ee9f3e70e8ce9c31533ec991bee8870c4814";
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
const GIF = Uint8Array.from([...ascii("GIF89a"), 7, 7]);
const WEBP = Uint8Array.from([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP"), 5]);
const MB8 = 8 * 1024 * 1024;

let dir: string;
let store: ImageStore;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-images-"));
	store = createImageStore({ dir });
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function putOk(bytes: Uint8Array): Promise<string> {
	const result = await store.put(bytes);
	if (!result.ok) throw new Error(`put 失败:${result.message}`);
	return result.ref;
}

describe("put / read", () => {
	it("引用是字节的 sha256 加嗅探出来的扩展名,读回同样的字节与 mime", async () => {
		const ref = await putOk(PNG);
		expect(ref).toBe(`${PNG_SHA256}.png`);
		const read = await store.read(ref);
		expect(read?.mime).toBe("image/png");
		expect(Uint8Array.from(read?.bytes ?? [])).toEqual(PNG);
	});

	it.each([
		["jpg", JPEG, "image/jpeg"],
		["gif", GIF, "image/gif"],
		["webp", WEBP, "image/webp"],
	] as const)("收 %s:扩展名按嗅探,JPEG 一律叫 jpg", async (ext, bytes, mime) => {
		const ref = await putOk(bytes);
		expect(ref).toMatch(new RegExp(`^[0-9a-f]{64}\\.${ext}$`));
		expect((await store.read(ref))?.mime).toBe(mime);
	});

	it.each([
		["SVG", Uint8Array.from(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>'))],
		["认不出的字节", Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])],
		["空的", new Uint8Array()],
	])("不是收的那几种图(%s)回 invalid,盘上什么都不留", async (_label, bytes) => {
		const result = await store.put(bytes);
		expect(result).toMatchObject({ ok: false, code: "invalid" });
		expect(await readdir(dir).catch(() => [])).toEqual([]);
	});

	it("单张 8MB 封顶:正好 8MB 收,多一个字节回 invalid", async () => {
		const exact = new Uint8Array(MB8);
		exact.set(PNG);
		expect((await store.put(exact)).ok).toBe(true);

		const over = new Uint8Array(MB8 + 1);
		over.set(JPEG);
		expect(await store.put(over)).toMatchObject({ ok: false, code: "invalid" });
	});

	it.each([
		["路径穿越", `../${PNG_SHA256}.png`],
		["主名不是 64 位", "abc.png"],
		["大写 hex", `${PNG_SHA256.toUpperCase()}.png`],
		["不收的扩展名", `${PNG_SHA256}.jpeg`],
		["没有扩展名", PNG_SHA256],
	])("引用不合规矩(%s)读回 undefined", async (_label, ref) => {
		await putOk(PNG);
		expect(await store.read(ref)).toBeUndefined();
	});

	it("引用合规矩、文件不在,读回 undefined", async () => {
		expect(await store.read(`${PNG_SHA256}.png`)).toBeUndefined();
	});
});

describe("同一份字节再存一次", () => {
	// 盘上约定:⑰ 的新图宽限期按修改时间算,接口上看不出来,所以直接看文件。
	it("回同一个引用,文件不重写,修改时间刷新", async () => {
		const ref = await putOk(PNG);
		const path = join(dir, ref);
		const old = new Date("2020-01-01T00:00:00Z");
		await utimes(path, old, old);
		const before = await stat(path);

		expect(await putOk(PNG)).toBe(ref);

		const after = await stat(path);
		// 原子写是「写临时文件再改名」,重写会换一个 inode。
		expect(after.ino).toBe(before.ino);
		expect(after.mtimeMs).toBeGreaterThan(old.getTime());
		expect(await readdir(dir)).toEqual([ref]);
	});
});
