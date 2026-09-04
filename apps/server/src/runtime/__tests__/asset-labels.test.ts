/**
 * 资产显示名的清洗尺 —— 皮肤包的原名清单与字体图廊共用这一把。
 *
 * 为什么不直接拿原名当文件名(主人问过,2026-08-20 定案):那个名字会流进三个
 * sink —— 磁盘路径、URL 路径、以及拼进受信任 <style> 的 `url("…")`。现在盘上的名字
 * **完全由我们生成**,这三处的安全性是由构造保证的;换成原名就变成「靠一条正则守着
 * 三个 sink」,而皮肤包是能从外部导入的 zip,那条正则从此是对第三方包的边界。
 *
 * 所以原名只做**显示**:它唯一的去处是 React 里的一段文本(自动转义)。清单本身来自
 * 不可信的 zip,所以键值都要过一遍尺子。
 */

import { describe, expect, it } from "vite-plus/test";
import { isSkinAssetName } from "../../skins/schema.js";
import { parseAssetNames, sanitizeAssetLabel } from "../asset-labels.js";

describe("sanitizeAssetLabel", () => {
	it("普通名字原样收,中文/空格/括号都不用怕 —— 它只会被当文本渲染", () => {
		for (const name of ["霞鹜文楷 Light.woff2", "壁纸 (1).png", "LXGWWenKai-Regular.ttf"]) {
			expect(sanitizeAssetLabel(name)).toBe(name);
		}
	});

	it("剥掉控制字符与双向覆盖符 —— 那是**唯一**能靠这个名字做的坏事", () => {
		// U+202E(RTL override)能把 `gnp.exe` 显示成 `exe.png`。纯观感欺骗、伤不到
		// 系统,但既然这个名字存在的意义就是「让主人认得出」,让它骗人就说不过去了。
		expect(sanitizeAssetLabel("bad\u202Egnp.exe")).toBe("badgnp.exe");
		expect(sanitizeAssetLabel("a\u0000b\nc.png")).toBe("abc.png");
	});

	it("只留文件名那一截 —— 有些浏览器给的是整条路径", () => {
		expect(sanitizeAssetLabel("C:\\Users\\akokko\\Desktop\\bg.png")).toBe("bg.png"); // local-path-ok
		expect(sanitizeAssetLabel("/home/me/fonts/wenkai.woff2")).toBe("wenkai.woff2"); // local-path-ok
	});

	it("超长截断 —— 下拉框里没人读得完一百多个字", () => {
		const long = `${"字".repeat(300)}.png`;
		const out = sanitizeAssetLabel(long);
		expect(out).not.toBeNull();
		expect((out as string).length).toBeLessThanOrEqual(120);
	});

	it("剥完什么都不剩 / 不是字符串 → null(调用方据此回落成生成名)", () => {
		expect(sanitizeAssetLabel("")).toBeNull();
		expect(sanitizeAssetLabel("   ")).toBeNull();
		expect(sanitizeAssetLabel("\u202E\u0000")).toBeNull();
		expect(sanitizeAssetLabel(42 as unknown as string)).toBeNull();
	});
});

describe("parseAssetNames", () => {
	it("正常清单原样收下", () => {
		expect(
			parseAssetNames(
				{ "assets/font-a1.woff2": "霞鹜文楷.woff2", "assets/img-b2.png": "樱花.png" },
				isSkinAssetName,
			),
		).toEqual({ "assets/font-a1.woff2": "霞鹜文楷.woff2", "assets/img-b2.png": "樱花.png" });
	});

	it("键不是合法资产名 → 丢掉,不让清单成为第二条注入路", () => {
		// 恶意包可以往这儿写任何键。它只是显示层,但别让它有机会去对上别的东西。
		expect(
			parseAssetNames(
				{ "assets/../skin.json": "x", "skin.json": "y", "assets/ok.png": "好.png" },
				isSkinAssetName,
			),
		).toEqual({ "assets/ok.png": "好.png" });
	});

	it("值不合法 → 只丢那一条,其余照收", () => {
		expect(
			parseAssetNames({ "assets/a.png": 1, "assets/b.png": "好.png" }, isSkinAssetName),
		).toEqual({ "assets/b.png": "好.png" });
	});

	it("整个清单坏掉 / 缺失 → 空表,绝不因此让整个包装不进去", () => {
		// 名字是锦上添花,不是包的必要成分。为一份读不懂的清单拒收一整套皮肤,
		// 就是拿最不重要的东西去卡最重要的路。
		for (const bad of [null, undefined, "[]", [], 42, { a: {} }]) {
			expect(parseAssetNames(bad, isSkinAssetName)).toEqual({});
		}
	});
});
