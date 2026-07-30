/**
 * 单元测试 —— 主人上传的字体文件落盘。
 *
 * 与卡片背景图同一套形态(`<dataDir>/assets/…`、资产 id = 文件名、id 正则是防穿越
 * 的唯一闸门、渲染期解析成 data URL 内联),两处差别是刻意的:
 *
 * 1. **后缀取自文件名,不看浏览器给的 mime**。图片的 mime 各家浏览器都给得准,字体
 *    不然:同一个 .ttf 可能是 `font/ttf`、`application/x-font-ttf`、
 *    `application/octet-stream`,甚至空串。照 mime 判会把一堆正常字体拒在门外。
 * 2. **要记住原始文件名**。背景图有缩略图可看,字体没有 —— 列表里只剩一串 hex 的话
 *    主人根本认不出哪个是哪个。名字存在同目录的 `index.json` 里,而**目录才是真相**:
 *    清单丢了照样列得出字体,只是名字回落成 id。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
	deleteFontAsset,
	fontAssetDir,
	isValidFontAssetId,
	listFontAssets,
	MAX_FONT_ASSET_BYTES,
	readFontAsset,
	readFontAssetDataUrl,
	saveFontAsset,
} from "../font-assets";

let dir: string;
/** woff2 magic(`wOF2`)+ 几个字节 —— 这一组只关心字节能不能原样回来。 */
const WOFF2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x02, 0x03]);

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "font-assets-"));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("落盘与读回", () => {
	it("存一款 woff2 → id 合法,字节与 mime 都原样回来", async () => {
		const id = await saveFontAsset(dir, WOFF2, "思源黑体.woff2");
		expect(isValidFontAssetId(id)).toBe(true);
		expect(id.endsWith(".woff2")).toBe(true);
		const read = await readFontAsset(dir, id);
		expect(read?.mime).toBe("font/woff2");
		expect(read?.bytes.equals(Buffer.from(WOFF2))).toBe(true);
	});

	it("四种字体后缀都收 —— woff2 / woff / ttf / otf", async () => {
		expect(await saveFontAsset(dir, WOFF2, "a.woff")).toMatch(/\.woff$/);
		expect(await saveFontAsset(dir, WOFF2, "b.ttf")).toMatch(/\.ttf$/);
		expect(await saveFontAsset(dir, WOFF2, "c.otf")).toMatch(/\.otf$/);
	});

	it("后缀认**文件名**,不看 mime —— 浏览器给字体的 mime 一塌糊涂", async () => {
		// 同一个 .ttf 在各家浏览器里可能是 font/ttf、application/x-font-ttf、
		// application/octet-stream 甚至空串。照 mime 判会把正常字体拒在门外。
		const id = await saveFontAsset(dir, WOFF2, "MyFont.TTF");
		expect(id.endsWith(".ttf")).toBe(true);
	});

	it("不认的后缀一律拒 —— 上传目录不是随便放文件的地方", async () => {
		await expect(saveFontAsset(dir, WOFF2, "malware.exe")).rejects.toThrow();
		await expect(saveFontAsset(dir, WOFF2, "无后缀")).rejects.toThrow();
	});

	it("超上限拒掉,报错说得出上限是多少", async () => {
		const tooBig = new Uint8Array(MAX_FONT_ASSET_BYTES + 1);
		await expect(saveFontAsset(dir, tooBig, "huge.ttf")).rejects.toThrow(/20/);
	});
});

describe("id 校验是唯一的防穿越闸门", () => {
	it("挡掉路径穿越与花样 id", () => {
		expect(isValidFontAssetId("../../bn.config.yaml")).toBe(false);
		expect(isValidFontAssetId("/etc/passwd")).toBe(false);
		expect(isValidFontAssetId("abc.woff2")).toBe(false); // 不是 32 位 hex
		expect(isValidFontAssetId(`${"a".repeat(32)}.exe`)).toBe(false);
		expect(isValidFontAssetId(`${"a".repeat(32)}.woff2`)).toBe(true);
	});

	it("非法 id 读不到、删不动(幂等返回 false)", async () => {
		expect(await readFontAsset(dir, "../x")).toBeNull();
		expect(await deleteFontAsset(dir, "../x")).toBe(false);
	});
});

describe("列表带得出原始文件名", () => {
	it("列出来的每一款都带上传时那个名字,中文名也不丢", async () => {
		const fresh = await mkdtemp(join(tmpdir(), "font-list-"));
		const id = await saveFontAsset(fresh, WOFF2, "霞鹜文楷.ttf");
		expect(await listFontAssets(fresh)).toEqual([{ id, name: "霞鹜文楷.ttf" }]);
		await rm(fresh, { recursive: true, force: true });
	});

	it("清单丢了照样列得出字体,名字回落成 id —— **目录才是真相**", async () => {
		const fresh = await mkdtemp(join(tmpdir(), "font-noman-"));
		const id = await saveFontAsset(fresh, WOFF2, "某字体.otf");
		// 模拟清单被手删 / 卷丢失。
		await rm(join(fontAssetDir(fresh), "index.json"), { force: true });
		expect(await listFontAssets(fresh)).toEqual([{ id, name: id }]);
		await rm(fresh, { recursive: true, force: true });
	});

	it("清单里躺着一条盘上已经没有的记录 → 不列它,免得选了个不存在的字体", async () => {
		const fresh = await mkdtemp(join(tmpdir(), "font-ghost-"));
		await saveFontAsset(fresh, WOFF2, "在的.ttf");
		const ghost = `${"f".repeat(32)}.ttf`;
		await writeFile(
			join(fontAssetDir(fresh), "index.json"),
			JSON.stringify({ [ghost]: "不在的.ttf" }),
		);
		const listed = await listFontAssets(fresh);
		expect(listed.some((f: { id: string }) => f.id === ghost)).toBe(false);
		await rm(fresh, { recursive: true, force: true });
	});

	it("目录不存在 → 空列表,不抛", async () => {
		expect(await listFontAssets(join(tmpdir(), "font-nope-does-not-exist"))).toEqual([]);
	});
});

describe("删除", () => {
	it("删掉之后文件、列表、清单里都不剩", async () => {
		const fresh = await mkdtemp(join(tmpdir(), "font-del-"));
		const id = await saveFontAsset(fresh, WOFF2, "待删.woff2");
		expect(await deleteFontAsset(fresh, id)).toBe(true);
		expect(await readFontAsset(fresh, id)).toBeNull();
		expect(await listFontAssets(fresh)).toEqual([]);
		// 清单里那条也得抹掉 —— 留着就是个永远对不上的名字,日后 id 复用还会串台。
		const manifest = JSON.parse(await readFile(join(fontAssetDir(fresh), "index.json"), "utf8"));
		expect(manifest).toEqual({});
		await rm(fresh, { recursive: true, force: true });
	});

	it("删一个不存在的 → false,不抛(幂等)", async () => {
		expect(await deleteFontAsset(dir, `${"e".repeat(32)}.woff2`)).toBe(false);
	});
});

describe("渲染期解析成 data URL", () => {
	it("解析得出 data URL,mime 与后缀对得上", async () => {
		const id = await saveFontAsset(dir, WOFF2, "ok.woff2");
		expect(await readFontAssetDataUrl(dir, id)).toMatch(/^data:font\/woff2;base64,/);
	});

	it("空 id / 悬空 id → 空串,让渲染静静回落到家族名那条路", async () => {
		// 出图不该因为「主人把字体删了」而崩 —— 与背景图同一条纪律。
		expect(await readFontAssetDataUrl(dir, "")).toBe("");
		expect(await readFontAssetDataUrl(dir, `${"d".repeat(32)}.woff2`)).toBe("");
		expect(await readFontAssetDataUrl(dir, "../../secret")).toBe("");
	});
});
