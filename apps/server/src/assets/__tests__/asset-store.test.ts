/**
 * 资产存储(`createAssetStore`)的工厂层测试:一个目录里放一类文件,id 就是文件名。
 *
 * 钉的是这一层自己的性质 —— 取名、认后缀、限大小、不出目录、原名清单不丢 —— 不去碰卡片背景图、
 * 聊天附件、字体那三个消费层各自的规矩(那些在它们自己的测试里)。全部走真目录,不 mock 原语:
 * 原子写、串行队列是这一层性质的一部分,替掉它们就测不出并发丢清单。
 */

import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { i18n } from "../../i18n/index.js";
import {
	type AssetPutOptions,
	type AssetStore,
	createAssetStore,
	isValidAssetId,
} from "../asset-store.js";

const IMAGE_FORMATS = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEX32_PNG = /^[a-f0-9]{32}\.png$/;

/** 每条用例一个临时根;资产目录是根下还不存在的 `assets/`,根本身当「目录之外」用。 */
let root: string;
let dir: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "bn-asset-store-"));
	dir = join(root, "assets");
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

/** put 该成功的场合:成功就给 id,被拒就把拒收原因带进失败信息。 */
async function putOk(store: AssetStore, options: AssetPutOptions): Promise<string> {
	const result = await store.put(options);
	if (!result.ok) throw new Error(`put 应当成功却被拒:${result.message}`);
	return result.id;
}

/** 宽松的取名判据:除了「非空」什么都放行,让名字的把关落到 store 自己身上。 */
const anyName = (name: string): boolean => name.length > 0;

describe("随机取名", () => {
	it("存下来的 id 是 32 位小写 hex + 后缀,字节与 mime 原样读回", async () => {
		const store = createAssetStore({
			dir,
			formats: IMAGE_FORMATS,
			maxBytes: 1024,
			naming: { kind: "random" },
		});
		const id = await putOk(store, { bytes: PNG, ext: "png" });
		expect(id).toMatch(HEX32_PNG);
		const read = await store.read(id);
		expect(read?.mime).toBe("image/png");
		expect(read?.bytes.equals(Buffer.from(PNG))).toBe(true);
		expect(await readdir(dir)).toEqual([id]);
	});

	it("后缀决定 mime —— 每个认得的后缀各回各的", async () => {
		const store = createAssetStore({
			dir,
			formats: IMAGE_FORMATS,
			maxBytes: 1024,
			naming: { kind: "random" },
		});
		const jpg = await putOk(store, { bytes: PNG, ext: "jpg" });
		const webp = await putOk(store, { bytes: PNG, ext: "webp" });
		expect(jpg).toMatch(/\.jpg$/);
		expect((await store.read(jpg))?.mime).toBe("image/jpeg");
		expect((await store.read(webp))?.mime).toBe("image/webp");
	});

	it("同一份字节存两次得到不同 id —— 删一个不该带走另一个", async () => {
		const store = createAssetStore({
			dir,
			formats: IMAGE_FORMATS,
			maxBytes: 1024,
			naming: { kind: "random" },
		});
		const a = await putOk(store, { bytes: PNG, ext: "png" });
		const b = await putOk(store, { bytes: PNG, ext: "png" });
		expect(a).not.toBe(b);
	});

	it("isValidId 只放行 32 位小写 hex + 认得的后缀,穿越与花样一概不放", () => {
		const store = createAssetStore({
			dir,
			formats: { png: "image/png", jpg: "image/jpeg" },
			maxBytes: 1024,
			naming: { kind: "random" },
		});
		const hex = "0123456789abcdef0123456789abcdef";
		expect(store.isValidId(`${hex}.png`)).toBe(true);
		expect(store.isValidId(`${hex}.jpg`)).toBe(true);
		for (const bad of [
			"",
			"short.png",
			`${hex}.gif`, // 后缀不认
			`${hex}.PNG`, // 后缀大小写要对上
			`${hex.toUpperCase()}.png`, // hex 只认小写
			`${hex}0.png`, // 33 位
			`${hex}xpng`, // 主名与后缀之间不是点
			`${hex.slice(1)}.png`, // 31 位
			"../../config/bn.config.yaml",
			`../${hex}.png`,
			`/${hex}.png`,
			`${hex}.png/../../x`,
			`${hex}.png\u0000.png`,
		]) {
			expect(store.isValidId(bad), bad).toBe(false);
		}
	});
});

describe("put 的拒收", () => {
	const strict = () =>
		createAssetStore({
			dir,
			formats: IMAGE_FORMATS,
			maxBytes: 16,
			naming: { kind: "random" },
		});

	it("后缀不认 → invalid,message 说得出是后缀的事,盘上什么都没落", async () => {
		const result = await strict().put({ bytes: PNG, ext: "svg" });
		expect(result).toMatchObject({ ok: false, code: "invalid" });
		if (!result.ok) expect(result.message).toMatch(/svg/);
		await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("原型链上的名字不算认得的后缀", async () => {
		// `ext in formats` 会把 constructor / toString 当成认得 —— 落盘的文件名就成了
		// `<hex>.constructor`,而 isValidId 又不认它,存得进去、列不出来、读不回。
		for (const ext of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
			const result = await strict().put({ bytes: PNG, ext });
			expect(result, ext).toMatchObject({ ok: false, code: "invalid" });
		}
	});

	it("超上限 → invalid,message 说出上限;恰好等于上限放行", async () => {
		const store = strict();
		const over = await store.put({ bytes: new Uint8Array(17), ext: "png" });
		expect(over).toMatchObject({ ok: false, code: "invalid" });
		if (!over.ok) expect(over.message).toMatch(/16/);
		const exact = await store.put({ bytes: new Uint8Array(16), ext: "png" });
		expect(exact.ok).toBe(true);
	});

	it("上限可以按后缀给 —— 同一个目录里不同格式各有各的线", async () => {
		const store = createAssetStore({
			dir,
			formats: { png: "image/png", webp: "image/webp" },
			maxBytes: (ext) => (ext === "png" ? 4 : 8),
			naming: { kind: "random" },
		});
		expect((await store.put({ bytes: new Uint8Array(5), ext: "png" })).ok).toBe(false);
		expect((await store.put({ bytes: new Uint8Array(5), ext: "webp" })).ok).toBe(true);
		expect((await store.put({ bytes: new Uint8Array(9), ext: "webp" })).ok).toBe(false);
	});
});

describe("自己给名字", () => {
	const given = (isValidName: (name: string) => boolean = anyName) =>
		createAssetStore({
			dir,
			formats: IMAGE_FORMATS,
			maxBytes: 1024,
			naming: { kind: "given", isValidName },
		});

	it("id 就是给的名字,读得回", async () => {
		const store = given();
		const id = await putOk(store, { bytes: PNG, ext: "png", name: "bg.png" });
		expect(id).toBe("bg.png");
		expect((await store.read("bg.png"))?.bytes.equals(Buffer.from(PNG))).toBe(true);
	});

	it("同名再存直接覆盖 —— 同名拒收之类的策略是调用方的事,不在这一层", async () => {
		const store = given();
		await putOk(store, { bytes: new Uint8Array([1, 1, 1]), ext: "png", name: "bg.png" });
		await putOk(store, { bytes: new Uint8Array([2, 2]), ext: "png", name: "bg.png" });
		expect((await store.read("bg.png"))?.bytes.equals(Buffer.from([2, 2]))).toBe(true);
		expect(await readdir(dir)).toEqual(["bg.png"]);
	});

	it("isValidId = isValidName 且后缀认得", () => {
		const store = given((name) => name.startsWith("img-"));
		expect(store.isValidId("img-1.png")).toBe(true);
		expect(store.isValidId("bg.png")).toBe(false); // isValidName 不认
		expect(store.isValidId("img-1.gif")).toBe(false); // 后缀不认
		expect(store.isValidId("img-1")).toBe(false); // 没后缀
	});

	it("缺名字 / isValidName 不认 → invalid,盘上什么都没落", async () => {
		const noName = await given().put({ bytes: PNG, ext: "png" });
		expect(noName).toMatchObject({ ok: false, code: "invalid" });
		const picky = await given((name) => name.startsWith("img-")).put({
			bytes: PNG,
			ext: "png",
			name: "bg.png",
		});
		expect(picky).toMatchObject({ ok: false, code: "invalid" });
		await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("名字带路径成分一律拒 —— 哪怕 isValidName 什么都放行(id 从 HTTP 原样进来的兜底)", async () => {
		const store = given();
		for (const name of [
			"../x.png",
			"a/b.png",
			"a\\b.png",
			"/x.png",
			"..",
			".",
			"../.png",
			"a\u0000.png",
		]) {
			const result = await store.put({ bytes: PNG, ext: "png", name });
			expect(result, name).toMatchObject({ ok: false, code: "invalid" });
		}
		await expect(stat(join(root, "x.png"))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("名字的后缀与 ext 对不上 → invalid", async () => {
		const result = await given().put({ bytes: PNG, ext: "png", name: "bg.jpg" });
		expect(result).toMatchObject({ ok: false, code: "invalid" });
	});
});

describe("非法 id 不碰盘", () => {
	it("read 对非法 id 回 null —— 目录外躺着的文件读不到", async () => {
		await writeFile(join(root, "secret.png"), "top secret");
		const store = createAssetStore({
			dir,
			formats: IMAGE_FORMATS,
			maxBytes: 1024,
			naming: { kind: "given", isValidName: anyName },
		});
		await putOk(store, { bytes: PNG, ext: "png", name: "ok.png" });
		expect(await store.read("../secret.png")).toBeNull();
		expect(await store.read("..\\secret.png")).toBeNull();
		expect(await store.read("ok.png")).not.toBeNull();
	});

	it("read 对合法却不存在的 id 回 null,不抛;目录都没建也一样", async () => {
		const store = createAssetStore({
			dir,
			formats: IMAGE_FORMATS,
			maxBytes: 1024,
			naming: { kind: "random" },
		});
		expect(await store.read(`${"a".repeat(32)}.png`)).toBeNull();
	});

	it("pathOf:合法 id 给出目录里的路径(不查在不在),非法 id 给 null", () => {
		const store = createAssetStore({
			dir,
			formats: IMAGE_FORMATS,
			maxBytes: 1024,
			naming: { kind: "random" },
		});
		const id = `${"b".repeat(32)}.png`;
		expect(store.pathOf(id)).toBe(join(dir, id));
		expect(store.pathOf("../../etc/passwd")).toBeNull();
		expect(store.pathOf("")).toBeNull();
	});

	it("remove 对非法 id 回 false —— 目录外的文件纹丝不动", async () => {
		await writeFile(join(root, "secret.png"), "top secret");
		const store = createAssetStore({
			dir,
			formats: IMAGE_FORMATS,
			maxBytes: 1024,
			naming: { kind: "given", isValidName: anyName },
		});
		expect(await store.remove("../secret.png")).toBe(false);
		expect(await readFile(join(root, "secret.png"), "utf8")).toBe("top secret");
	});
});

describe("列表", () => {
	it("只列合法 id,带字节数;垃圾文件与不认得的后缀不列", async () => {
		const store = createAssetStore({
			dir,
			formats: IMAGE_FORMATS,
			maxBytes: 1024,
			naming: { kind: "random" },
		});
		const png = await putOk(store, { bytes: PNG, ext: "png" });
		const webp = await putOk(store, { bytes: new Uint8Array(3), ext: "webp" });
		await writeFile(join(dir, "notes.txt"), "x");
		await writeFile(join(dir, "deadbeef.png"), "x"); // 不是 32 位 hex
		await writeFile(join(dir, `${"a".repeat(32)}.gif`), "x"); // 后缀不认
		const listed = await store.list();
		// 没记原名的资产不带 label 字段(而不是 label: undefined)。
		expect(listed.sort((a, b) => a.id.localeCompare(b.id))).toStrictEqual(
			[
				{ id: png, size: PNG.byteLength },
				{ id: webp, size: 3 },
			].sort((a, b) => a.id.localeCompare(b.id)),
		);
	});

	it("目录还不存在 → 空列表,不抛", async () => {
		const store = createAssetStore({
			dir,
			formats: IMAGE_FORMATS,
			maxBytes: 1024,
			naming: { kind: "random" },
		});
		expect(await store.list()).toEqual([]);
	});

	it("跳过存储层留下的暂存与旧目录残留", async () => {
		// 取名放行一切、后缀又认得 —— 构造成这样,才只有「残留」这一道判据拦得住它们。
		const store = createAssetStore({
			dir,
			formats: IMAGE_FORMATS,
			maxBytes: 1024,
			naming: { kind: "given", isValidName: anyName },
		});
		await putOk(store, { bytes: PNG, ext: "png", name: "real.png" });
		await writeFile(join(dir, "half.bn-tmp.42.png"), "x");
		await writeFile(join(dir, "old.bn-old.42.png"), "x");
		expect((await store.list()).map((view) => view.id)).toEqual(["real.png"]);
		// 同一道判据也挡着写:存得进去、列不出来的名字比拒收更坏。
		expect(await store.put({ bytes: PNG, ext: "png", name: "half.bn-tmp.42.png" })).toMatchObject({
			ok: false,
			code: "invalid",
		});
		expect(store.isValidId("old.bn-old.42.png")).toBe(false);
	});

	it("清单文件自己不算资产;给它的名字存不进去", async () => {
		const store = createAssetStore({
			dir,
			formats: { png: "image/png", json: "application/json" },
			maxBytes: 1024,
			naming: { kind: "given", isValidName: anyName },
			labelsFile: "index.json",
		});
		await putOk(store, { bytes: PNG, ext: "png", name: "a.png", label: "甲" });
		expect((await store.list()).map((view) => view.id)).toEqual(["a.png"]);
		const clobber = await store.put({
			bytes: new Uint8Array([1]),
			ext: "json",
			name: "index.json",
		});
		expect(clobber).toMatchObject({ ok: false, code: "invalid" });
		expect(store.isValidId("index.json")).toBe(false);
		expect(await store.labels()).toEqual({ "a.png": "甲" });
	});
});

describe("删除", () => {
	it("删掉存在的返回 true,文件与列表里都不剩;再删返回 false", async () => {
		const store = createAssetStore({
			dir,
			formats: IMAGE_FORMATS,
			maxBytes: 1024,
			naming: { kind: "random" },
		});
		const id = await putOk(store, { bytes: PNG, ext: "png" });
		expect(await store.remove(id)).toBe(true);
		expect(await store.read(id)).toBeNull();
		expect(await store.list()).toEqual([]);
		expect(await store.remove(id)).toBe(false);
	});

	it("合法却不存在 → false,什么都不建", async () => {
		const store = createAssetStore({
			dir,
			formats: IMAGE_FORMATS,
			maxBytes: 1024,
			naming: { kind: "random" },
			labelsFile: "index.json",
		});
		expect(await store.remove(`${"c".repeat(32)}.png`)).toBe(false);
		await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("清单里那条一并抹掉 —— 留着就是个永远对不上的名字", async () => {
		const store = createAssetStore({
			dir,
			formats: IMAGE_FORMATS,
			maxBytes: 1024,
			naming: { kind: "random" },
			labelsFile: "index.json",
		});
		const keep = await putOk(store, { bytes: PNG, ext: "png", label: "留下.png" });
		const gone = await putOk(store, { bytes: PNG, ext: "png", label: "待删.png" });
		expect(await store.remove(gone)).toBe(true);
		expect(await store.labels()).toEqual({ [keep]: "留下.png" });
		expect(JSON.parse(await readFile(join(dir, "index.json"), "utf8"))).toEqual({
			[keep]: "留下.png",
		});
	});
});

describe("原名清单", () => {
	const withLabels = () =>
		createAssetStore({
			dir,
			formats: IMAGE_FORMATS,
			maxBytes: 1024,
			naming: { kind: "random" },
			labelsFile: "index.json",
		});

	it("put 记原名,labels() 与 list() 都带得出;清单是带末尾换行的 JSON", async () => {
		const store = withLabels();
		const id = await putOk(store, { bytes: PNG, ext: "png", label: "霞鹜文楷.png" });
		expect(await store.labels()).toEqual({ [id]: "霞鹜文楷.png" });
		expect(await store.list()).toEqual([{ id, size: PNG.byteLength, label: "霞鹜文楷.png" }]);
		const text = await readFile(join(dir, "index.json"), "utf8");
		expect(JSON.parse(text)).toEqual({ [id]: "霞鹜文楷.png" });
		expect(text.endsWith("\n")).toBe(true);
	});

	it("原名记之前先洗:整条路径只留最后一截,控制字符与双向覆盖符剥掉,超长截断", async () => {
		const store = withLabels();
		const path = await putOk(store, { bytes: PNG, ext: "png", label: "D:\\pics\\bg.png" });
		const bidi = await putOk(store, { bytes: PNG, ext: "png", label: "bad\u202Egnp.png" });
		const ctrl = await putOk(store, { bytes: PNG, ext: "png", label: "a\u0000b\nc.png" });
		const long = await putOk(store, { bytes: PNG, ext: "png", label: `${"字".repeat(300)}.png` });
		// 看盘上的原文而不是 labels():读出来那头也会洗,只看它的话,存进去时没洗也照样绿。
		const labels = JSON.parse(await readFile(join(dir, "index.json"), "utf8")) as Record<
			string,
			string
		>;
		expect(labels[path]).toBe("bg.png");
		expect(labels[bidi]).toBe("badgnp.png");
		expect(labels[ctrl]).toBe("abc.png");
		expect(labels[long]?.length).toBeLessThanOrEqual(120);
	});

	it("洗完什么都不剩、或压根没给 → 不记,put 照样成功", async () => {
		const store = withLabels();
		const blank = await putOk(store, { bytes: PNG, ext: "png", label: "\u0000" });
		const none = await putOk(store, { bytes: PNG, ext: "png" });
		expect(await store.labels()).toEqual({});
		expect((await store.list()).map((view) => view.id).sort()).toEqual([blank, none].sort());
		// 没有名字可记、也没有旧名可抹,就不该为它写一份清单。
		await expect(stat(join(dir, "index.json"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	describe("同名覆盖", () => {
		const givenLabeled = () =>
			createAssetStore({
				dir,
				formats: IMAGE_FORMATS,
				maxBytes: 1024,
				naming: { kind: "given", isValidName: anyName },
				labelsFile: "index.json",
			});
		const diskLabels = async (): Promise<unknown> =>
			JSON.parse(await readFile(join(dir, "index.json"), "utf8"));

		it("覆盖时没给原名 → 旧名抹掉,不留一个和新内容对不上的名字", async () => {
			const store = givenLabeled();
			await putOk(store, { bytes: PNG, ext: "png", name: "bg.png", label: "旧.png" });
			await putOk(store, { bytes: new Uint8Array([9]), ext: "png", name: "bg.png" });
			expect(await store.labels()).toEqual({});
			expect(await diskLabels()).toEqual({});
			expect(await store.list()).toStrictEqual([{ id: "bg.png", size: 1 }]);
		});

		it("覆盖时给的原名洗完为空 → 同样抹掉", async () => {
			const store = givenLabeled();
			await putOk(store, { bytes: PNG, ext: "png", name: "bg.png", label: "旧.png" });
			await putOk(store, { bytes: PNG, ext: "png", name: "bg.png", label: "\u0000" });
			expect(await diskLabels()).toEqual({});
		});

		it("覆盖时给了新原名 → 换成新的;别的资产的名字不动", async () => {
			const store = givenLabeled();
			await putOk(store, { bytes: PNG, ext: "png", name: "a.png", label: "甲.png" });
			await putOk(store, { bytes: PNG, ext: "png", name: "b.png", label: "乙.png" });
			await putOk(store, { bytes: PNG, ext: "png", name: "a.png", label: "丙.png" });
			expect(await store.labels()).toEqual({ "a.png": "丙.png", "b.png": "乙.png" });
			// 没给名字的覆盖只抹自己那条。
			await putOk(store, { bytes: PNG, ext: "png", name: "a.png" });
			expect(await store.labels()).toEqual({ "b.png": "乙.png" });
		});
	});

	it("没给 labelsFile → 不记原名,目录里只有资产自己", async () => {
		const store = createAssetStore({
			dir,
			formats: IMAGE_FORMATS,
			maxBytes: 1024,
			naming: { kind: "random" },
		});
		const id = await putOk(store, { bytes: PNG, ext: "png", label: "会被忽略.png" });
		expect(await store.labels()).toEqual({});
		expect(await readdir(dir)).toEqual([id]);
		expect(await store.list()).toStrictEqual([{ id, size: PNG.byteLength }]);
	});

	it("清单丢了照样列得出资产,只是没有名字 —— 目录才是真相", async () => {
		const store = withLabels();
		const id = await putOk(store, { bytes: PNG, ext: "png", label: "会丢.png" });
		await rm(join(dir, "index.json"));
		expect(await store.list()).toStrictEqual([{ id, size: PNG.byteLength }]);
	});

	it("清单里躺着盘上已经没有的记录 → 不列它", async () => {
		const store = withLabels();
		const id = await putOk(store, { bytes: PNG, ext: "png", label: "在的.png" });
		const ghost = `${"f".repeat(32)}.png`;
		await writeFile(
			join(dir, "index.json"),
			JSON.stringify({ [id]: "在的.png", [ghost]: "不在的.png" }),
		);
		expect((await store.list()).map((view) => view.id)).toEqual([id]);
	});

	it("清单是盘上的普通 JSON,里头的东西不可信:值不是字符串、键不是合法 id 的只丢那一条", async () => {
		const store = withLabels();
		const a = await putOk(store, { bytes: PNG, ext: "png" });
		const b = await putOk(store, { bytes: PNG, ext: "png" });
		await writeFile(
			join(dir, "index.json"),
			JSON.stringify({ [a]: 42, [b]: "好.png", "../x.png": "穿越.png" }),
		);
		expect(await store.labels()).toEqual({ [b]: "好.png" });
	});

	it("清单是数组 / 标量 / null → 当空表,不抛", async () => {
		const store = withLabels();
		const id = await putOk(store, { bytes: PNG, ext: "png" });
		for (const bad of ["[]", '"x"', "42", "null"]) {
			await writeFile(join(dir, "index.json"), bad);
			expect(await store.labels(), bad).toEqual({});
			expect((await store.list())[0]?.id, bad).toBe(id);
		}
	});

	it("清单根本不是 JSON → 当空表,原文件改名隔离不丢,之后照常记名字", async () => {
		const store = withLabels();
		const first = await putOk(store, { bytes: PNG, ext: "png" });
		await writeFile(join(dir, "index.json"), "{半截");
		expect(await store.labels()).toEqual({});
		const quarantined = (await readdir(dir)).filter((name) =>
			name.startsWith("index.json.corrupt-"),
		);
		expect(quarantined).toHaveLength(1);
		expect(await readFile(join(dir, quarantined[0] as string), "utf8")).toBe("{半截");
		const second = await putOk(store, { bytes: PNG, ext: "png", label: "新的.png" });
		expect(await store.labels()).toEqual({ [second]: "新的.png" });
		// 隔离出来的文件不是资产,列表里只有那两件。
		expect((await store.list()).map((view) => view.id).sort()).toEqual([first, second].sort());
	});
});

describe("并发", () => {
	const labeled = () =>
		createAssetStore({
			dir,
			formats: IMAGE_FORMATS,
			maxBytes: 1024,
			naming: { kind: "random" },
			labelsFile: "index.json",
		});

	it("同时存 8 件带原名的 → 清单里 8 条一条不丢", async () => {
		// 清单是读改写:8 个 put 各读到同一份旧清单、各写回自己那一条,后写的盖掉先写的。
		// 不串行的话,这里只剩寥寥几条。
		const store = labeled();
		const ids = await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				putOk(store, { bytes: PNG, ext: "png", label: `第${i}张.png` }),
			),
		);
		const labels = await store.labels();
		expect(Object.keys(labels).sort()).toEqual([...ids].sort());
		expect(Object.values(labels).sort()).toEqual(
			Array.from({ length: 8 }, (_, i) => `第${i}张.png`).sort(),
		);
		// 落盘的清单本身也是齐的,不只是内存里读得出。
		const onDisk = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
		expect(Object.keys(onDisk)).toHaveLength(8);
	});

	it("存与删交错 → 清单只剩该剩的", async () => {
		const store = labeled();
		const seeds = await Promise.all(
			Array.from({ length: 4 }, (_, i) =>
				putOk(store, { bytes: PNG, ext: "png", label: `旧${i}.png` }),
			),
		);
		const [drop0, drop1, keep0, keep1] = seeds as [string, string, string, string];
		const [removed, added] = await Promise.all([
			Promise.all([store.remove(drop0), store.remove(drop1)]),
			Promise.all(
				Array.from({ length: 4 }, (_, i) =>
					putOk(store, { bytes: PNG, ext: "png", label: `新${i}.png` }),
				),
			),
		]);
		expect(removed).toEqual([true, true]);
		const labels = await store.labels();
		expect(Object.keys(labels).sort()).toEqual([keep0, keep1, ...added].sort());
	});

	it("同一目录建两个 store 实例、各自并发 put → 清单一条不丢", async () => {
		// 调用方(比如按数据目录就地建 store 的门面)在同一个目录上必然建出不止一个实例。
		// 串行队列若住在实例里,各排各的队,清单照样丢名字 —— 队列得按清单文件走。
		const a = labeled();
		// 同一个目录换一种写法:相对路径的实例与绝对路径的实例是同一份清单。
		const b = createAssetStore({
			dir: relative(process.cwd(), dir),
			formats: IMAGE_FORMATS,
			maxBytes: 1024,
			naming: { kind: "random" },
			labelsFile: "index.json",
		});
		const ids = await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				putOk(i % 2 === 0 ? a : b, { bytes: PNG, ext: "png", label: `第${i}张.png` }),
			),
		);
		expect(Object.keys(await a.labels()).sort()).toEqual([...ids].sort());
	});

	it("写完之后目录里没有原子写留下的临时文件,只有资产与清单", async () => {
		const store = labeled();
		const ids = await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				putOk(store, { bytes: PNG, ext: "png", label: `第${i}张.png` }),
			),
		);
		const names = await readdir(dir);
		expect(names.filter((name) => name.includes(".bn-tmp."))).toEqual([]);
		expect(names.sort()).toEqual(["index.json", ...ids].sort());
	});
});

describe("isValidAssetId", () => {
	const hex = "0123456789abcdef0123456789abcdef";
	const random = { formats: IMAGE_FORMATS, maxBytes: 1024, naming: { kind: "random" } } as const;
	const given = {
		formats: IMAGE_FORMATS,
		maxBytes: 1024,
		naming: { kind: "given", isValidName: (name: string) => name.startsWith("img-") },
	} as const;

	it("不建 store、不给目录就能判:随机取名看形状与后缀", () => {
		expect(isValidAssetId(random, `${hex}.png`)).toBe(true);
		expect(isValidAssetId(random, `${hex}.gif`)).toBe(false);
		expect(isValidAssetId(random, `../${hex}.png`)).toBe(false);
	});

	it("自己给名字:isValidName 且后缀认得,路径成分不论 isValidName 怎么说一律拒", () => {
		expect(isValidAssetId(given, "img-1.png")).toBe(true);
		expect(isValidAssetId(given, "bg.png")).toBe(false);
		expect(isValidAssetId(given, "img-1.gif")).toBe(false);
		expect(isValidAssetId(given, "img-/../x.png")).toBe(false);
		expect(
			isValidAssetId({ ...given, naming: { kind: "given", isValidName: anyName } }, "../x.png"),
		).toBe(false);
	});

	it("暂存与旧目录残留的名字不算合法 id", () => {
		expect(
			isValidAssetId(
				{ ...given, naming: { kind: "given", isValidName: anyName } },
				"x.bn-tmp.1.png",
			),
		).toBe(false);
	});

	it("与 store.isValidId 判得一致(清单文件名那一条除外,那是 store 才知道的)", () => {
		for (const rules of [random, given]) {
			const store = createAssetStore({ ...rules, dir });
			for (const id of [
				`${hex}.png`,
				`${hex}.gif`,
				"img-1.png",
				"bg.png",
				"../x.png",
				"",
				"x.bn-tmp.1.png",
			]) {
				expect(isValidAssetId(rules, id), id).toBe(store.isValidId(id));
			}
		}
	});
});

it("localizes asset rejection on a held store and leaves storage untouched", async () => {
	const store = createAssetStore({
		dir,
		formats: IMAGE_FORMATS,
		maxBytes: 1024,
		naming: { kind: "random" },
	});
	const previous = i18n.state();
	try {
		for (const [locale, message] of [
			["en", "Unsupported format: pdf (only png / jpg / webp)."],
			["ja", "未対応の形式です：pdf（対応形式：png / jpg / webp）"],
			["zh-TW", "不支援的格式：pdf（僅接受 png / jpg / webp）。"],
		] as const) {
			i18n.set({ locale, voice: "plain" });
			expect(await store.put({ bytes: PNG, ext: "pdf" })).toEqual({
				ok: false,
				code: "invalid",
				message,
			});
			expect(await store.list()).toEqual([]);
		}
	} finally {
		i18n.set(previous);
	}
});
