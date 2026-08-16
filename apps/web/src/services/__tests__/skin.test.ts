// @vitest-environment jsdom

/**
 * 皮肤合成层:语义字段 → CSS 变量表 → documentElement 注入。
 * 预览与正式应用共用同一套合成函数(定案);单套皮肤锁模式;?skin=off 逃生舱。
 */

import type { SkinManifest, SkinMode } from "@bilibili-notify/contract";
import { describe, expect, it } from "vitest";
import {
	applySkinCss,
	applySkinVars,
	clearSkinCss,
	clearSkinVars,
	composeChatWallpaperCss,
	composeEffectsCss,
	composeSkinCss,
	composeSkinVars,
	composeWallpaperCss,
	resolveSkinMode,
	skinKillSwitchActive,
	translateSkinCssHooks,
} from "../skin";

const assetUrl = (name: string) => `/api/skins/abc/assets/${name.slice("assets/".length)}`;

describe("composeSkinVars", () => {
	it("colors 语义键映射到内部 --bn-* 变量", () => {
		const vars = composeSkinVars(
			{ colors: { accent: "#123456", textPrimary: "#111111", dangerSoft: "#fee" } },
			assetUrl,
			"light",
		);
		expect(vars["--color-bn-pink"]).toBe("#123456");
		expect(vars["--color-bn-text-primary"]).toBe("#111111");
		expect(vars["--color-bn-danger-soft"]).toBe("#fee");
	});

	it("page.background → --bn-page-bg", () => {
		const vars = composeSkinVars({ page: { background: "#fef0f4" } }, assetUrl, "light");
		expect(vars["--bn-page-bg"]).toBe("#fef0f4");
	});

	it("wallpaper 合成:overlay 纱跟模式走(亮=白纱/暗=黑纱)+ 资产 URL + cover,并覆盖 page.background", () => {
		const mode: SkinMode = {
			page: { background: "#000000" },
			wallpaper: { image: "assets/bg.webp", fit: "cover", overlay: 0.3 },
		};
		const light = composeSkinVars(mode, assetUrl, "light");
		expect(light["--bn-page-bg"]).toContain('url("/api/skins/abc/assets/bg.webp")');
		expect(light["--bn-page-bg"]).toContain("rgba(255, 255, 255, 0.3)");
		expect(light["--bn-page-bg"]).toContain("cover");
		expect(light["--bn-page-bg"]).not.toContain("#000000");

		const dark = composeSkinVars(mode, assetUrl, "dark");
		expect(dark["--bn-page-bg"]).toContain("rgba(0, 0, 0, 0.3)");
	});

	it("wallpaper tile 铺法用 repeat,不带 cover", () => {
		const vars = composeSkinVars(
			{ wallpaper: { image: "assets/bg.png", fit: "tile" } },
			assetUrl,
			"light",
		);
		expect(vars["--bn-page-bg"]).toContain("repeat");
		expect(vars["--bn-page-bg"]).not.toContain("cover");
	});

	it("glass 六键映射,blur 数字拼 px", () => {
		const vars = composeSkinVars(
			{
				glass: {
					background: "rgba(255, 255, 255, 0.5)",
					border: "rgba(255, 255, 255, 0.3)",
					strongBackground: "rgba(255, 255, 255, 0.9)",
					strongBorder: "rgba(0, 0, 0, 0.05)",
					blur: 20,
					strongBlur: 28,
				},
			},
			assetUrl,
			"light",
		);
		expect(vars["--bn-glass-bg"]).toBe("rgba(255, 255, 255, 0.5)");
		expect(vars["--bn-glass-border"]).toBe("rgba(255, 255, 255, 0.3)");
		expect(vars["--bn-glass-strong-bg"]).toBe("rgba(255, 255, 255, 0.9)");
		expect(vars["--bn-glass-strong-border"]).toBe("rgba(0, 0, 0, 0.05)");
		expect(vars["--bn-glass-blur"]).toBe("20px");
		expect(vars["--bn-glass-strong-blur"]).toBe("28px");
	});

	it("fonts.body:带空格/中文的名字加引号,末尾补 system-ui 兜底", () => {
		const vars = composeSkinVars(
			{ fonts: { body: ["LXGW WenKai", "霞鹜文楷", "monospace"] } },
			assetUrl,
			"light",
		);
		expect(vars["--font-cjk"]).toBe('"LXGW WenKai", "霞鹜文楷", monospace, system-ui, sans-serif');
	});

	it("radius 数字拼 px", () => {
		const vars = composeSkinVars({ radius: { card: 8, pill: 12 } }, assetUrl, "light");
		expect(vars["--radius-bn-card"]).toBe("8px");
		expect(vars["--radius-bn-pill"]).toBe("12px");
	});

	it("空 mode → 只剩 chat 接管变量(皮肤生效即接管聊天观感),其余全回默认装", () => {
		const vars = composeSkinVars({}, assetUrl, "light");
		const keys = Object.keys(vars);
		expect(keys.every((k) => k.startsWith("--bn-chat-"))).toBe(true);
		expect(keys).toHaveLength(5);
	});

	it("colors 新键 listRow/listRowBorder 映射到行条变量", () => {
		const vars = composeSkinVars(
			{ colors: { listRow: "rgba(255, 255, 255, 0.45)", listRowBorder: "#39c5bb" } },
			assetUrl,
			"light",
		);
		expect(vars["--color-bn-list-row"]).toBe("rgba(255, 255, 255, 0.45)");
		expect(vars["--color-bn-list-row-border"]).toBe("#39c5bb");
	});
});

describe("composeWallpaperCss(壁纸糊化层)", () => {
	const wp = { image: "assets/bg.webp", overlay: 0.3, blur: 12 } as const;

	it("blur>0:壁纸(含纱)整体搬进 body::before 固定层做静态高斯模糊", () => {
		const css = composeWallpaperCss({ wallpaper: { ...wp } }, assetUrl, "light");
		expect(css).toContain("body::before");
		expect(css).toContain("position:fixed");
		expect(css).toContain("filter:blur(12px)");
		// 负 inset 外扩,遮掉 blur 的边缘透底
		expect(css).toContain("inset:-24px");
		expect(css).toContain('url("/api/skins/abc/assets/bg.webp")');
		expect(css).toContain("rgba(255, 255, 255, 0.3)");
		// 纱色照旧跟模式走
		expect(composeWallpaperCss({ wallpaper: { ...wp } }, assetUrl, "dark")).toContain(
			"rgba(0, 0, 0, 0.3)",
		);
	});

	it("blur>0 时 --bn-page-bg 不再放壁纸(留给 page.background/默认底)", () => {
		const vars = composeSkinVars(
			{ page: { background: "#101010" }, wallpaper: { ...wp } },
			assetUrl,
			"light",
		);
		expect(vars["--bn-page-bg"]).toBe("#101010");
	});

	it("没配 blur → 返回空串,壁纸照旧走 --bn-page-bg(现状不变)", () => {
		const mode: SkinMode = { wallpaper: { image: "assets/bg.webp" } };
		expect(composeWallpaperCss(mode, assetUrl, "light")).toBe("");
		expect(composeSkinVars(mode, assetUrl, "light")["--bn-page-bg"]).toContain("url(");
	});
});

describe("resolveSkinMode(单套锁模式)", () => {
	const light: SkinMode = { colors: { accent: "#aaa111" } };
	const dark: SkinMode = { colors: { accent: "#bbb222" } };

	it("双套皮肤:跟随请求的模式,不锁", () => {
		const skin: SkinManifest = { schemaVersion: 1, name: "t", modes: { light, dark } };
		expect(resolveSkinMode(skin, "dark")).toEqual({ mode: dark, theme: "dark", locked: false });
		expect(resolveSkinMode(skin, "light")).toEqual({ mode: light, theme: "light", locked: false });
	});

	it("只有 dark 一套:请求 light 也锁到 dark", () => {
		const skin: SkinManifest = { schemaVersion: 1, name: "t", modes: { dark } };
		expect(resolveSkinMode(skin, "light")).toEqual({ mode: dark, theme: "dark", locked: true });
	});
});

describe("applySkinVars / clearSkinVars", () => {
	it("注入 setProperty;clear 把上次注入的全部移除", () => {
		const el = document.createElement("div");
		applySkinVars(el, { "--color-bn-pink": "#123456", "--bn-page-bg": "#fff" });
		expect(el.style.getPropertyValue("--color-bn-pink")).toBe("#123456");

		// 换一套变量更少的皮肤:上一套的残留键必须被清掉
		applySkinVars(el, { "--bn-page-bg": "#000" });
		expect(el.style.getPropertyValue("--color-bn-pink")).toBe("");
		expect(el.style.getPropertyValue("--bn-page-bg")).toBe("#000");

		clearSkinVars(el);
		expect(el.style.getPropertyValue("--bn-page-bg")).toBe("");
	});
});

describe("skinKillSwitchActive(?skin=off 逃生舱)", () => {
	it("?skin=off → true;其余 → false", () => {
		expect(skinKillSwitchActive("?skin=off")).toBe(true);
		expect(skinKillSwitchActive("?foo=1&skin=off")).toBe(true);
		expect(skinKillSwitchActive("?skin=on")).toBe(false);
		expect(skinKillSwitchActive("")).toBe(false);
	});
});

describe("composeSkinVars / shadows(辉光)", () => {
	it("card/elev 映射到 --shadow-bn-* 变量", () => {
		const vars = composeSkinVars(
			{
				shadows: {
					card: "0 10px 30px rgba(57, 197, 187, 0.25)",
					elev: "0 18px 50px rgba(57, 197, 187, 0.4)",
				},
			},
			assetUrl,
			"light",
		);
		expect(vars["--shadow-bn-card"]).toBe("0 10px 30px rgba(57, 197, 187, 0.25)");
		expect(vars["--shadow-bn-elev"]).toBe("0 18px 50px rgba(57, 197, 187, 0.4)");
	});
});

describe("自定义 CSS:hook 翻译与合成", () => {
	it("hook 按映射表翻译成真实选择器;未知 hook 原样保留(命中不了任何元素)", () => {
		expect(translateSkinCssHooks('[data-bn="glass"]:hover{border-width:2px}')).toBe(
			".bn-glass:hover{border-width:2px}",
		);
		expect(translateSkinCssHooks('[data-bn="page"]::before{content:""}')).toBe(
			'body::before{content:""}',
		);
		// 挂属性的组件 hook → ~= 匹配(一个元素可挂多个 hook)
		expect(translateSkinCssHooks('[data-bn="btn-primary"]{opacity:0.9}')).toBe(
			'[data-bn~="btn-primary"]{opacity:0.9}',
		);
		// 无引号形式(css-tree 对 Identifier 值的序列化)同样认
		expect(translateSkinCssHooks("[data-bn=glass]{opacity:1}")).toBe(".bn-glass{opacity:1}");
		expect(translateSkinCssHooks('[data-bn="nope"]{opacity:1}')).toBe(
			'[data-bn="nope"]{opacity:1}',
		);
	});

	it("composeSkinCss:顶层共用 + 当前模式追加,输出已翻译;两段都缺 → 空串", () => {
		const manifest: SkinManifest = {
			schemaVersion: 1,
			name: "t",
			css: '[data-bn="glass"]{border-width:1px}',
			modes: {
				light: { css: '[data-bn="btn"]{opacity:0.9}' },
				dark: {},
			},
		};
		const light = composeSkinCss(manifest, "light");
		expect(light).toContain(".bn-glass{border-width:1px}");
		expect(light).toContain('[data-bn~="btn"]{opacity:0.9}');
		// dark 套没有自己的 css,但顶层共用仍在
		expect(composeSkinCss(manifest, "dark")).toBe(".bn-glass{border-width:1px}");
		expect(composeSkinCss({ schemaVersion: 1, name: "t", modes: { light: {} } }, "light")).toBe("");
	});

	it("applySkinCss 注入 <style>;再次调用覆盖;clearSkinCss 移除", () => {
		applySkinCss(".bn-glass{opacity:0.95}");
		const el = document.getElementById("bn-skin-css");
		expect(el?.tagName).toBe("STYLE");
		expect(el?.textContent).toBe(".bn-glass{opacity:0.95}");

		applySkinCss("body{border-width:0}");
		expect(document.querySelectorAll("#bn-skin-css")).toHaveLength(1);
		expect(document.getElementById("bn-skin-css")?.textContent).toBe("body{border-width:0}");

		clearSkinCss();
		expect(document.getElementById("bn-skin-css")).toBeNull();
		// 空串 = 不留空标签
		applySkinCss("");
		expect(document.getElementById("bn-skin-css")).toBeNull();
	});
});

describe("composeEffectsCss(动效预设 → 内置 CSS)", () => {
	it("backgroundFlow 已移除(整页 background 动画真机卡顿):存量数据不再产出任何 CSS", () => {
		const legacyMode = { effects: { backgroundFlow: true } } as unknown as SkinMode;
		expect(composeEffectsCss(legacyMode)).toBe("");
	});

	it("glassShine:默认主强调色,可指定颜色;动画只碰 box-shadow", () => {
		const dflt = composeEffectsCss({ effects: { glassShine: {} } });
		expect(dflt).toContain("var(--color-bn-pink)");
		expect(dflt).toContain("bn-skin-glass-shine");
		const custom = composeEffectsCss({ effects: { glassShine: { color: "#39c5bb" } } });
		expect(custom).toContain("#39c5bb");
	});

	it("glassShine 叠加在基础影上:关键帧合回 --tw-shadow 链,不顶掉 shadow-bn-* 的层次", () => {
		// CSS 动画值覆盖 utility 的 box-shadow —— 帧里必须引用元素自己的
		// --tw-shadow(自定义属性动画覆盖不到)把基础三层影合回来,流光只做追加层;
		// 否则流光一开,无描边卡片风的层次感整个被吃掉(真机验过)。
		const css = composeEffectsCss({ effects: { glassShine: {} } });
		expect(css).toContain("var(--tw-shadow, 0 0 #0000)");
	});

	it("光斑:输出 keyframes,且 reduce 偏好下隐藏效果层", () => {
		const css = composeEffectsCss({
			effects: { bokeh: { colors: ["#fb7299"] } },
		});
		expect(css).toContain("bn-skin-drift");
		expect(css).toMatch(/prefers-reduced-motion: reduce[^}]*\{\s*\[data-skin-effects\]/);
	});

	it("没配 effects → 空串", () => {
		expect(composeEffectsCss({})).toBe("");
	});
});

describe("chat 变量(皮肤生效即整体接管 AI 聊天观感,变量必须全套输出)", () => {
	it("无 chat 段:从 colors.accent 派生全套 --bn-chat-*,背景 transparent 透出皮肤底", () => {
		const vars = composeSkinVars({ colors: { accent: "#a3de4f" } }, assetUrl, "light");
		expect(vars["--bn-chat-dot"]).toBe("#a3de4f");
		expect(vars["--bn-chat-accent-rgb"]).toBe("163, 222, 79");
		expect(vars["--bn-chat-accent-2"]).toBe("#a3de4f");
		expect(vars["--bn-chat-bg"]).toBe("transparent");
		expect(vars["--bn-chat-glow"]).toContain("163, 222, 79");
	});

	it("chat 段覆盖派生:accent/accentSecondary/background 各自生效", () => {
		const vars = composeSkinVars(
			{
				colors: { accent: "#a3de4f" },
				chat: {
					accent: "#fb7299",
					accentSecondary: "#ff9a5c",
					background: "linear-gradient(135deg, #fdeef1, #fbe7ec)",
				},
			},
			assetUrl,
			"light",
		);
		expect(vars["--bn-chat-dot"]).toBe("#fb7299");
		expect(vars["--bn-chat-accent-rgb"]).toBe("251, 114, 153");
		expect(vars["--bn-chat-accent-2"]).toBe("#ff9a5c");
		expect(vars["--bn-chat-bg"]).toContain("linear-gradient");
	});

	it("皮肤全无 accent → 品牌粉兜底;暗色 glow 与亮色两套浓度", () => {
		const light = composeSkinVars({}, assetUrl, "light");
		expect(light["--bn-chat-dot"]).toBe("#fb7299");
		expect(light["--bn-chat-accent-rgb"]).toBe("251, 114, 153");
		const dark = composeSkinVars({}, assetUrl, "dark");
		expect(dark["--bn-chat-glow"]).not.toBe(light["--bn-chat-glow"]);
	});

	it("chat 壁纸(无 blur):纱层+图层合进 --bn-chat-bg;配了 background 时垫在最底", () => {
		const bare = composeSkinVars(
			{ chat: { wallpaper: { image: "assets/c.webp", overlay: 0.3 } } },
			assetUrl,
			"light",
		);
		expect(bare["--bn-chat-bg"]).toContain('url("/api/skins/abc/assets/c.webp")');
		expect(bare["--bn-chat-bg"]).toContain("rgba(255, 255, 255, 0.3)");

		const withBg = composeSkinVars(
			{
				chat: {
					background: "linear-gradient(135deg, #fff, #eee)",
					wallpaper: { image: "assets/c.webp" },
				},
			},
			assetUrl,
			"light",
		);
		expect(withBg["--bn-chat-bg"]).toMatch(/url\(.+\).*linear-gradient\(135deg/);
	});

	it("chat 壁纸 blur>0:壁纸整体搬进 chat 根的 ::before 糊化层,--bn-chat-bg 留底", () => {
		const mode: SkinMode = { chat: { wallpaper: { image: "assets/c.webp", blur: 10 } } };
		const vars = composeSkinVars(mode, assetUrl, "light");
		expect(vars["--bn-chat-bg"]).toBe("transparent");
		const css = composeChatWallpaperCss(mode, assetUrl, "light");
		expect(css).toContain("[data-bn-chat-root]::before");
		expect(css).toContain("blur(10px)");
		expect(css).toContain('url("/api/skins/abc/assets/c.webp")');
	});

	it("chat 壁纸没配或 blur=0 → composeChatWallpaperCss 输出空串", () => {
		expect(composeChatWallpaperCss({}, assetUrl, "light")).toBe("");
		expect(
			composeChatWallpaperCss(
				{ chat: { wallpaper: { image: "assets/c.webp" } } },
				assetUrl,
				"light",
			),
		).toBe("");
	});
});
