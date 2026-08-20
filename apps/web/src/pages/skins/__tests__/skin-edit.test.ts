/**
 * 皮肤编辑器的纯函数层:draft 的不可变修改(空值即删除)、颜色键分组表、
 * hex 解析、字体栈文本互转、补缺失模式套。
 */

import { SKIN_COLOR_TOKEN_MAP, type SkinManifest } from "@bilibili-notify/contract";
import { describe, expect, it } from "vite-plus/test";
import {
	addMissingMode,
	COLOR_GROUPS,
	cleanSection,
	colorAlphaOf,
	fontsToText,
	missingModeOf,
	setManifestText,
	setModeSection,
	splitSkinAssets,
	textToFonts,
	toHex6,
	withColorAlpha,
} from "../skin-edit";

function makeManifest(): SkinManifest {
	return {
		schemaVersion: 1,
		name: "樱花夜",
		modes: { light: { colors: { accent: "#fb7299" } } },
	};
}

describe("colorAlphaOf / withColorAlpha(玻璃片透明度滑杆的解析层)", () => {
	it("colorAlphaOf:rgba/rgb/hex6/hex8 都解析;认不出与缺省 → null", () => {
		expect(colorAlphaOf("rgba(255, 255, 255, 0.5)")).toBe(0.5);
		expect(colorAlphaOf("rgb(10, 20, 30)")).toBe(1);
		expect(colorAlphaOf("#39c5bb")).toBe(1);
		expect(colorAlphaOf("#39c5bb80")).toBeCloseTo(0.5, 1);
		expect(colorAlphaOf("oklch(0.7 0.1 200)")).toBeNull();
		expect(colorAlphaOf(undefined)).toBeNull();
	});

	it("withColorAlpha:保色相只换 alpha,统一输出 rgba;解析不了用 fallback 色相", () => {
		expect(withColorAlpha("rgba(10, 20, 30, 0.8)", 0.3, "255, 255, 255")).toBe(
			"rgba(10, 20, 30, 0.3)",
		);
		expect(withColorAlpha("#39c5bb", 0.5, "255, 255, 255")).toBe("rgba(57, 197, 187, 0.5)");
		expect(withColorAlpha(undefined, 0.4, "255, 255, 255")).toBe("rgba(255, 255, 255, 0.4)");
		expect(withColorAlpha("oklch(0.7 0.1 200)", 0.4, "30, 41, 59")).toBe("rgba(30, 41, 59, 0.4)");
	});
});

describe("cleanSection", () => {
	it("去掉 undefined 与空串;数字 0 保留;全空 → undefined", () => {
		expect(cleanSection({ a: "", b: undefined, c: 0, d: "x" })).toEqual({ c: 0, d: "x" });
		expect(cleanSection({ a: "", b: undefined })).toBeUndefined();
		expect(cleanSection({})).toBeUndefined();
	});
});

describe("setModeSection", () => {
	it("不可变地写入一套 mode 的 section;原 manifest 不动", () => {
		const m = makeManifest();
		const next = setModeSection(m, "light", "glass", { blur: 20 });
		expect(next.modes.light?.glass).toEqual({ blur: 20 });
		expect(m.modes.light?.glass).toBeUndefined();
		// 其他 section 原样保留
		expect(next.modes.light?.colors).toEqual({ accent: "#fb7299" });
	});

	it("value 为 undefined → 删除该 section;mode 本身保留(空套合法且锁定语义不变)", () => {
		const m = makeManifest();
		const next = setModeSection(m, "light", "colors", undefined);
		expect(next.modes.light).toEqual({});
		expect("light" in next.modes).toBe(true);
	});

	it("对不存在的 mode 写入 → 静默返回原 manifest(UI 不该给出这个入口)", () => {
		const m = makeManifest();
		expect(setModeSection(m, "dark", "glass", { blur: 8 })).toBe(m);
	});
});

describe("setManifestText", () => {
	it("写入槽位;空串 → 删槽位;texts 清空后整个字段消失", () => {
		const m = makeManifest();
		const withText = setManifestText(m, "headerTitle", "小恶魔面板");
		expect(withText.texts).toEqual({ headerTitle: "小恶魔面板" });
		const cleared = setManifestText(withText, "headerTitle", "");
		expect(cleared.texts).toBeUndefined();
	});
});

describe("COLOR_GROUPS", () => {
	it("分组表恰好覆盖 SKIN_COLOR_TOKEN_MAP 的全部键,不多不少", () => {
		const flat = COLOR_GROUPS.flatMap((g) => g.keys.map((k) => k.key));
		expect(new Set(flat).size).toBe(flat.length);
		expect([...flat].sort()).toEqual(Object.keys(SKIN_COLOR_TOKEN_MAP).sort());
	});
});

describe("toHex6", () => {
	it("#rgb / #rrggbb / #rrggbbaa → #rrggbb;其他(rgba/oklch/空)→ null", () => {
		expect(toHex6("#fb7299")).toBe("#fb7299");
		expect(toHex6("#F72")).toBe("#ff7722");
		expect(toHex6("#fb7299cc")).toBe("#fb7299");
		expect(toHex6("rgba(0,0,0,0.5)")).toBeNull();
		expect(toHex6("")).toBeNull();
	});
});

describe("fonts 互转", () => {
	it("数组 ⇄ 逗号文本;空文本 → undefined;空白项剔除", () => {
		expect(fontsToText(["LXGW WenKai", "sans-serif"])).toBe("LXGW WenKai, sans-serif");
		expect(fontsToText(undefined)).toBe("");
		expect(textToFonts(" LXGW WenKai , sans-serif ")).toEqual(["LXGW WenKai", "sans-serif"]);
		expect(textToFonts("  ")).toBeUndefined();
	});
});

describe("补缺失模式套", () => {
	it("missingModeOf:单套 → 缺的那套;双套 → null", () => {
		expect(missingModeOf(makeManifest())).toBe("dark");
		const dual = { ...makeManifest(), modes: { light: {}, dark: {} } };
		expect(missingModeOf(dual)).toBeNull();
	});

	it("addMissingMode:把已有那套深拷贝到缺失侧;双套时原样返回", () => {
		const m = makeManifest();
		const next = addMissingMode(m);
		expect(next.modes.dark).toEqual(m.modes.light);
		expect(next.modes.dark).not.toBe(m.modes.light);
		expect(addMissingMode(next)).toBe(next);
	});
});

describe("splitSkinAssets", () => {
	it("按后缀分成图与字体两拨", () => {
		expect(
			splitSkinAssets([
				"assets/bg.png",
				"assets/font-a1.woff2",
				"assets/deco.webp",
				"assets/f.TTF",
				"assets/g.otf",
				"assets/h.woff",
			]),
		).toEqual({
			images: ["assets/bg.png", "assets/deco.webp"],
			fonts: ["assets/font-a1.woff2", "assets/f.TTF", "assets/g.otf", "assets/h.woff"],
		});
	});

	it("判后缀不判名字前缀 —— 手工压出来的包里名字什么样都有", () => {
		// `img-` / `font-` 是落盘时的可读性前缀,不是契约。拿前缀分流的话,主人自己
		// 压一个 assets/wenkai.woff2 传进来,就会出现在「壁纸图片」下拉里。
		expect(splitSkinAssets(["assets/wenkai.woff2", "assets/font-looking.png"])).toEqual({
			images: ["assets/font-looking.png"],
			fonts: ["assets/wenkai.woff2"],
		});
	});

	it("空清单 → 两个空数组", () => {
		expect(splitSkinAssets([])).toEqual({ images: [], fonts: [] });
	});
});
