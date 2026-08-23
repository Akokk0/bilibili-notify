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
	syncModeTo,
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
		expect(colorAlphaOf("color-mix(in oklab, #fff, #000)")).toBeNull();
		expect(colorAlphaOf(undefined)).toBeNull();
	});

	it("withColorAlpha:保色相只换 alpha,统一输出 rgba;解析不了用 fallback 色相", () => {
		expect(withColorAlpha("rgba(10, 20, 30, 0.8)", 0.3, "255, 255, 255")).toBe(
			"rgba(10, 20, 30, 0.3)",
		);
		expect(withColorAlpha("#39c5bb", 0.5, "255, 255, 255")).toBe("rgba(57, 197, 187, 0.5)");
		expect(withColorAlpha(undefined, 0.4, "255, 255, 255")).toBe("rgba(255, 255, 255, 0.4)");
		expect(withColorAlpha("color-mix(in oklab, #fff, #000)", 0.4, "30, 41, 59")).toBe(
			"rgba(30, 41, 59, 0.4)",
		);
	});

	/**
	 * 「保色相只换 alpha」是这对控件立项时的原话(87b2a9e:hue preserved)。可解析层
	 * 当初只认逗号版 rgb/rgba 与 hex —— 而服务端的 `isColor` 放行的是
	 * `rgb|rgba|hsl|hsla|oklch|oklab` 六个函数,空格语法与 `/ alpha` 也都合法,
	 * AI 皮肤设计师的提示词里还明写着可以用 oklch。
	 *
	 * 于是一套 `oklch(...)` 的玻璃,滑杆读出来是空的,**拖一下就把色相换成了兜底灰**。
	 * 服务端准写的每一种形状,这一头都得认得 —— 认不出就等于毁色,不是「退化」。
	 */
	it("服务端准写的每种颜色形状,拖滑杆都保色相 —— 认不出就等于毁色", () => {
		const cases: [input: string, alpha: number, expected: string][] = [
			// 现代空格语法 + 斜杠 alpha
			["oklch(0.28 0.03 250 / 0.55)", 0.3, "oklch(0.28 0.03 250 / 0.3)"],
			["oklch(0.7 0.1 200)", 0.4, "oklch(0.7 0.1 200 / 0.4)"],
			["oklab(0.5 -0.1 0.1)", 0.25, "oklab(0.5 -0.1 0.1 / 0.25)"],
			["rgb(30 41 59 / 0.55)", 0.8, "rgb(30 41 59 / 0.8)"],
			["hsl(210 40% 20%)", 0.5, "hsl(210 40% 20% / 0.5)"],
			// 逗号语法:统一收成带 alpha 的那一支
			["hsl(210, 40%, 20%)", 0.5, "hsla(210, 40%, 20%, 0.5)"],
			["hsla(210, 40%, 20%, 0.9)", 0.5, "hsla(210, 40%, 20%, 0.5)"],
		];
		for (const [input, alpha, expected] of cases) {
			expect(withColorAlpha(input, alpha, "30, 41, 59")).toBe(expected);
		}
	});

	it("colorAlphaOf 也认得那些形状 —— 否则滑杆一直显示空", () => {
		expect(colorAlphaOf("oklch(0.28 0.03 250 / 0.55)")).toBeCloseTo(0.55, 2);
		expect(colorAlphaOf("oklch(0.7 0.1 200)")).toBe(1);
		expect(colorAlphaOf("rgb(30 41 59 / 50%)")).toBeCloseTo(0.5, 2);
		expect(colorAlphaOf("hsla(210, 40%, 20%, 0.9)")).toBeCloseTo(0.9, 2);
		expect(colorAlphaOf("hsl(210 40% 20%)")).toBe(1);
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

describe("syncModeTo:把一套的调整套到另一套", () => {
	/** 浅色那套什么都配了,深色那套是另一副配色 —— 套用要么全盖、要么只盖版式。 */
	function twoModes(): SkinManifest {
		return {
			schemaVersion: 1,
			name: "双套",
			modes: {
				light: {
					colors: { accent: "#fb7299", textPrimary: "#0f172a" },
					page: { background: "#fef0f4" },
					wallpaper: { image: "assets/bg.png", fit: "cover", overlay: 0.35, blur: 12 },
					glass: { background: "rgba(255, 255, 255, 0.7)", blur: 18, strongBlur: 24 },
					radius: { card: 20 },
					fonts: { body: ["霞鹜文楷"] },
					shadows: { card: "0 1px 2px rgba(0,0,0,0.04)" },
					css: '[data-bn="btn"]{opacity:0.9}',
					effects: { bokeh: { colors: ["#fb7299"] } },
					chat: { background: "#fff5f8", wallpaper: { image: "assets/c.png", blur: 6 } },
				},
				dark: {
					colors: { accent: "#00aeec", textPrimary: "#f8fafc" },
					page: { background: "#0b1020" },
					glass: { background: "rgba(30, 41, 59, 0.72)", blur: 4 },
					shadows: { card: "0 1px 3px rgba(0,0,0,0.28)" },
				},
			},
		};
	}

	it("整套套过去 → 另一套变得一模一样", () => {
		const next = syncModeTo(twoModes(), "light", "dark", "all");
		expect(next.modes.dark).toEqual(next.modes.light);
		// 源那套一个字不动 —— 套用是单向的。
		expect(next.modes.light).toEqual(twoModes().modes.light);
	});

	it("整套套过去 → 两边不共享引用,改一套不会牵动另一套", () => {
		// 浅拷贝的话,之后在深色页调壁纸模糊,浅色页跟着变 —— 而 draft 看起来一切正常。
		const next = syncModeTo(twoModes(), "light", "dark", "all");
		expect(next.modes.dark?.wallpaper).not.toBe(next.modes.light?.wallpaper);
		expect(next.modes.dark?.colors).not.toBe(next.modes.light?.colors);
	});

	it("只套版式 → 壁纸/圆角/字体/玻璃模糊过去", () => {
		const next = syncModeTo(twoModes(), "light", "dark", "layout");
		const d = next.modes.dark;
		expect(d?.wallpaper).toEqual({ image: "assets/bg.png", fit: "cover", overlay: 0.35, blur: 12 });
		expect(d?.radius).toEqual({ card: 20 });
		expect(d?.fonts).toEqual({ body: ["霞鹜文楷"] });
		expect(d?.glass?.blur).toBe(18);
		expect(d?.glass?.strongBlur).toBe(24);
		expect(d?.chat?.wallpaper).toEqual({ image: "assets/c.png", blur: 6 });
	});

	it("只套版式 → 颜色一类原地不动", () => {
		// 分明暗的那半:配色、页面底、玻璃底色、阴影、聊天底。盖过去深色的字就
		// 变成深色系,在深底上直接看不见 —— 这正是「只套版式」要躲开的。
		const next = syncModeTo(twoModes(), "light", "dark", "layout");
		const d = next.modes.dark;
		expect(d?.colors).toEqual({ accent: "#00aeec", textPrimary: "#f8fafc" });
		expect(d?.page).toEqual({ background: "#0b1020" });
		expect(d?.glass?.background).toBe("rgba(30, 41, 59, 0.72)");
		expect(d?.shadows).toEqual({ card: "0 1px 3px rgba(0,0,0,0.28)" });
		expect(d?.chat?.background).toBeUndefined();
	});

	it("只套版式 → 模式专属 CSS 与动效不跟着走", () => {
		// 两者都以颜色为主(暗色霓虹边、光斑颜色是必填的颜色列表),脱了色不成立。
		const next = syncModeTo(twoModes(), "light", "dark", "layout");
		expect(next.modes.dark?.css).toBeUndefined();
		expect(next.modes.dark?.effects).toBeUndefined();
	});

	it("源那套没配的段,目标那边也要跟着清掉 —— 套用不是「叠加」", () => {
		const base = twoModes();
		delete base.modes.light?.wallpaper;
		base.modes.dark = { ...base.modes.dark, wallpaper: { image: "assets/old.png" } };
		const next = syncModeTo(base, "light", "dark", "layout");
		expect(next.modes.dark?.wallpaper).toBeUndefined();
	});

	it("单套皮肤 → 原样返回,不凭空造出另一套", () => {
		// 造出来的话,一颗「同步」就把单套皮肤变成了双套,而主人只是手滑点了一下。
		const single: SkinManifest = {
			schemaVersion: 1,
			name: "纯浅",
			modes: { light: { radius: { card: 8 } } },
		};
		expect(syncModeTo(single, "light", "dark", "all")).toBe(single);
	});
});
