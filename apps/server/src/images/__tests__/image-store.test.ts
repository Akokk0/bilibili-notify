import { mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGE_REF_EXTENSIONS } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
	createImageStore,
	IMAGE_GRACE_MS,
	IMAGE_MAX_BYTES,
	type ImageStore,
	type ImageWriter,
	imageExtOf,
	imageRefOf,
	isValidImageRef,
} from "../image-store.js";

/**
 * 图库本体(ADR-0022 决策 9 下 10-03 的 🔗):引用就是文件名 `<sha256>.<ext>`,扩展名按嗅探;只收
 * png / jpg / gif / webp、单张 8MB;同一份字节再存不重写、只刷新修改时间。
 *
 * 存图的口只有登记成引用方才拿得到;清扫只删「过了宽限期、又没有哪家引用」的图(决策 9 下 10-04「⑳ 开片」的 🔗)。
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
let writer: ImageWriter;
/** 那家测试引用方此刻引用着的图。 */
let held: string[];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-images-"));
	store = createImageStore({ dir });
	held = [];
	writer = store.register({ name: "测试", listRefs: async () => held });
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function putOk(bytes: Uint8Array): Promise<string> {
	const result = await writer.put(bytes);
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
		const result = await writer.put(bytes);
		expect(result).toMatchObject({ ok: false, code: "invalid" });
		expect(await readdir(dir).catch(() => [])).toEqual([]);
	});

	it("单张 8MB 封顶:正好 8MB 收,多一个字节回 invalid", async () => {
		const exact = new Uint8Array(MB8);
		exact.set(PNG);
		expect((await writer.put(exact)).ok).toBe(true);

		const over = new Uint8Array(MB8 + 1);
		over.set(JPEG);
		expect(await writer.put(over)).toMatchObject({ ok: false, code: "invalid" });
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

describe("引用的规矩是纯函数,不碰盘", () => {
	it("imageRefOf 与 put 起的名字一致(迁移直接落文件,名字得事先算出来)", async () => {
		for (const bytes of [PNG, JPEG, GIF, WEBP]) {
			expect(imageRefOf(bytes)).toBe(await putOk(bytes));
		}
	});

	it("imageRefOf:不是收的那几种图回 undefined,超 8MB 也是", () => {
		expect(imageRefOf(Uint8Array.from(ascii("<svg/>")))).toBeUndefined();
		expect(imageRefOf(new Uint8Array())).toBeUndefined();
		const over = new Uint8Array(IMAGE_MAX_BYTES + 1);
		over.set(PNG);
		expect(imageRefOf(over)).toBeUndefined();
	});

	it("isValidImageRef 与 read 认同一套形状:64 位小写 hex + 收的扩展名", () => {
		expect(isValidImageRef(`${PNG_SHA256}.png`)).toBe(true);
		expect(isValidImageRef(`${PNG_SHA256}.jpg`)).toBe(true);
		for (const bad of [
			`../${PNG_SHA256}.png`,
			"abc.png",
			`${PNG_SHA256.toUpperCase()}.png`,
			`${PNG_SHA256}.jpeg`,
			PNG_SHA256,
			"",
		]) {
			expect(isValidImageRef(bad), bad).toBe(false);
		}
	});

	it("isValidImageRef(internal 的 IMAGE_REF_PATTERN)与存储那头(格式表 + sha256 取名)对同一组名字答案一致", async () => {
		// 每个名字都真的在盘上放一个文件:存储那头认的才读得出字节,不认的 read 回 undefined。
		const names = [
			...IMAGE_REF_EXTENSIONS.map((ext) => `${PNG_SHA256}.${ext}`),
			`${PNG_SHA256}.jpeg`,
			`${PNG_SHA256}.svg`,
			`${PNG_SHA256}.PNG`,
			`${PNG_SHA256.slice(1)}.png`,
			`${PNG_SHA256.toUpperCase()}.png`,
			`${PNG_SHA256}.png.bak`,
		];
		for (const name of names) await writeFile(join(dir, name), PNG);
		for (const name of names) {
			expect(isValidImageRef(name), name).toBe((await store.read(name)) !== undefined);
		}
		expect(names.filter(isValidImageRef)).toEqual(
			IMAGE_REF_EXTENSIONS.map((ext) => `${PNG_SHA256}.${ext}`),
		);
	});

	it("imageExtOf 从引用本身得出扩展名;形状不对回 undefined", () => {
		expect(imageExtOf(`${PNG_SHA256}.png`)).toBe("png");
		expect(imageExtOf(`${PNG_SHA256}.webp`)).toBe("webp");
		expect(imageExtOf("../x.png")).toBeUndefined();
	});
});

describe("同一份字节再存一次", () => {
	// 盘上约定:图库清扫(⑳)的新图宽限期按修改时间算,接口上看不出来,所以直接看文件。
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

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-04T12:00:00Z");

/** 把一张图的修改时间拨到「此刻之前 ms 毫秒」。 */
async function age(ref: string, ms: number): Promise<void> {
	const at = new Date(NOW.getTime() - ms);
	await utimes(join(dir, ref), at, at);
}

describe("清扫", () => {
	it("宽限期写死 24 小时", () => {
		expect(IMAGE_GRACE_MS).toBe(DAY);
	});

	it("过了宽限期又没人引用的图删掉,回报删了哪些", async () => {
		const ref = await putOk(PNG);
		await age(ref, DAY + 1000);

		const report = await store.sweep({ now: NOW });

		expect(report).toEqual({
			removed: [ref],
			removedBytes: PNG.byteLength,
			referenced: 0,
			inGrace: 0,
		});
		expect(await readdir(dir)).toEqual([]);
	});

	it("还在宽限期里的图没人引用也留着", async () => {
		const ref = await putOk(PNG);
		await age(ref, DAY - 1000);

		expect(await store.sweep({ now: NOW })).toEqual({
			removed: [],
			removedBytes: 0,
			referenced: 0,
			inGrace: 1,
		});
		expect(await readdir(dir)).toEqual([ref]);
	});

	it("有一家引用着的老图留着,哪怕引用它的不是存它的那一家", async () => {
		const ref = await putOk(PNG);
		const other = await putOk(JPEG);
		await age(ref, 10 * DAY);
		await age(other, 10 * DAY);
		store.register({ name: "另一家", listRefs: async () => [ref] });

		const report = await store.sweep({ now: NOW });

		expect(report).toEqual({
			removed: [other],
			removedBytes: JPEG.byteLength,
			referenced: 1,
			inGrace: 0,
		});
		expect(await readdir(dir)).toEqual([ref]);
	});

	it("任何一家列不出自己的引用,这一轮一张都不删", async () => {
		const ref = await putOk(PNG);
		await age(ref, 10 * DAY);
		store.register({
			name: "坏掉的那家",
			listRefs: async () => {
				throw new Error("读不了盘");
			},
		});

		await expect(store.sweep({ now: NOW })).rejects.toThrow("读不了盘");
		expect(await readdir(dir)).toEqual([ref]);
	});

	it("清扫列完引用之后、动手删之前又被存了一次的图不删", async () => {
		// 引用方的 listRefs 是清扫给的唯一一个「中途」的口:在这里再存一次,正好卡在「看过修改时间」与「删」之间。
		const ref = await putOk(PNG);
		await age(ref, 10 * DAY);
		store.register({
			name: "中途存图的那家",
			listRefs: async () => {
				await putOk(PNG);
				return [];
			},
		});

		expect((await store.sweep({ now: NOW })).removed).toEqual([]);
		expect(await readdir(dir)).toEqual([ref]);
	});

	it("图库目录里不是图库的文件不碰", async () => {
		await putOk(PNG);
		await writeFile(join(dir, "README.txt"), "别人放的");
		const old = new Date(NOW.getTime() - 10 * DAY);
		await utimes(join(dir, "README.txt"), old, old);
		await age(`${PNG_SHA256}.png`, 10 * DAY);

		await store.sweep({ now: NOW });

		expect(await readdir(dir)).toEqual(["README.txt"]);
	});

	it("目录还没建(从没存过图)时清扫什么都不做", async () => {
		await rm(dir, { recursive: true, force: true });
		expect(await store.sweep({ now: NOW })).toEqual({
			removed: [],
			removedBytes: 0,
			referenced: 0,
			inGrace: 0,
		});
	});
});

describe("续期", () => {
	it("抄别人引用的一方续期后,老图回到宽限期里", async () => {
		const ref = await putOk(PNG);
		await age(ref, 10 * DAY);

		expect(await writer.keep(ref)).toBe(true);

		const { mtimeMs } = await stat(join(dir, ref));
		expect(mtimeMs).toBeGreaterThan(NOW.getTime() - DAY);
	});

	it("图已经不在了回 false,不凭空造文件", async () => {
		expect(await writer.keep(`${PNG_SHA256}.png`)).toBe(false);
		expect(await writer.keep("../etc/passwd")).toBe(false);
		expect(await readdir(dir)).toEqual([]);
	});
});

describe("登记与关门", () => {
	it("同一个名字登记两次是写错了,当场抛", () => {
		expect(() => store.register({ name: "测试", listRefs: async () => [] })).toThrow("测试");
	});

	it("关门之后存图、续期、清扫都被拒,读照常", async () => {
		const ref = await putOk(PNG);
		await store.close();

		const closed = { code: "queue_closed" };
		await expect(writer.put(JPEG)).rejects.toMatchObject(closed);
		await expect(writer.keep(ref)).rejects.toMatchObject(closed);
		await expect(store.sweep({ now: NOW })).rejects.toMatchObject(closed);
		expect((await store.read(ref))?.mime).toBe("image/png");
	});
});

describe("put — 磁盘写失败", () => {
	/** 图库的目录是个普通文件:往里写必挂(ENOTDIR),盘满 / 权限不对是同一类。 */
	async function brokenWriter(): Promise<ImageWriter> {
		const blocked = join(dir, "挡路");
		await writeFile(blocked, "x");
		return createImageStore({ dir: blocked }).register({ name: "测试", listRefs: async () => [] });
	}

	it("回 unavailable、不抛;message 带着原因,不吞", async () => {
		const result = await (await brokenWriter()).put(PNG);

		expect(result).toMatchObject({ ok: false, code: "unavailable" });
		if (result.ok) throw new Error("不该存得进去");
		expect(result.message).toContain("ENOTDIR");
	});

	it("不是图库收的图照旧是 invalid(先判图、后碰盘)", async () => {
		const result = await (await brokenWriter()).put(Uint8Array.from([1, 2, 3]));
		expect(result).toMatchObject({ ok: false, code: "invalid" });
	});
});
