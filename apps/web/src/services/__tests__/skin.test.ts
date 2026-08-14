// @vitest-environment jsdom

/**
 * 皮肤合成层:语义字段 → CSS 变量表 → documentElement 注入。
 * 预览与正式应用共用同一套合成函数(定案);单套皮肤锁模式;?skin=off 逃生舱。
 */

import type { SkinManifest, SkinMode } from "@bilibili-notify/contract";
import { describe, expect, it } from "vitest";
import {
	applySkinVars,
	clearSkinVars,
	composeSkinVars,
	decorationStyle,
	resolveSkinMode,
	skinKillSwitchActive,
} from "../skin";

const assetUrl = (name: string) => `/api/skins/abc/assets/${name.slice("assets/".length)}`;

describe("composeSkinVars", () => {
	it("colors 语义键映射到内部 --bn-* 变量", () => {
		const vars = composeSkinVars(
			{ colors: { accent: "#123456", textPrimary: "#111111", dangerSoft: "#fee" } },
			assetUrl,
		);
		expect(vars["--color-bn-pink"]).toBe("#123456");
		expect(vars["--color-bn-text-primary"]).toBe("#111111");
		expect(vars["--color-bn-danger-soft"]).toBe("#fee");
	});

	it("page.background → --bn-page-bg", () => {
		const vars = composeSkinVars({ page: { background: "#fef0f4" } }, assetUrl);
		expect(vars["--bn-page-bg"]).toBe("#fef0f4");
	});

	it("wallpaper 合成:overlay 渐变层 + 资产 URL + cover 铺法,并覆盖 page.background", () => {
		const vars = composeSkinVars(
			{
				page: { background: "#000000" },
				wallpaper: { image: "assets/bg.webp", fit: "cover", overlay: 0.3 },
			},
			assetUrl,
		);
		const bg = vars["--bn-page-bg"];
		expect(bg).toContain('url("/api/skins/abc/assets/bg.webp")');
		expect(bg).toContain("rgba(0, 0, 0, 0.3)");
		expect(bg).toContain("cover");
		expect(bg).not.toContain("#000000");
	});

	it("wallpaper tile 铺法用 repeat,不带 cover", () => {
		const vars = composeSkinVars({ wallpaper: { image: "assets/bg.png", fit: "tile" } }, assetUrl);
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
		);
		expect(vars["--font-cjk"]).toBe('"LXGW WenKai", "霞鹜文楷", monospace, system-ui, sans-serif');
	});

	it("radius 数字拼 px", () => {
		const vars = composeSkinVars({ radius: { card: 8, pill: 12 } }, assetUrl);
		expect(vars["--radius-bn-card"]).toBe("8px");
		expect(vars["--radius-bn-pill"]).toBe("12px");
	});

	it("空 mode → 空表(全回默认装)", () => {
		expect(composeSkinVars({}, assetUrl)).toEqual({});
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
		);
		expect(vars["--shadow-bn-card"]).toBe("0 10px 30px rgba(57, 197, 187, 0.25)");
		expect(vars["--shadow-bn-elev"]).toBe("0 18px 50px rgba(57, 197, 187, 0.4)");
	});
});

describe("decorationStyle(九宫格贴纸定位)", () => {
	it("bottom-right 贴边;center 双向居中;offset 叠进 translate", () => {
		const br = decorationStyle({
			image: "assets/a.png",
			anchor: "bottom-right",
			width: 220,
			opacity: 0.9,
		});
		expect(br).toMatchObject({ bottom: 0, right: 0, width: 220, opacity: 0.9 });

		const center = decorationStyle({
			image: "assets/a.png",
			anchor: "center",
			width: 100,
			opacity: 1,
		});
		expect(center.left).toBe("50%");
		expect(center.top).toBe("50%");
		expect(String(center.transform)).toContain("-50%");

		const offset = decorationStyle({
			image: "assets/a.png",
			anchor: "bottom-right",
			width: 100,
			opacity: 1,
			offsetX: -12,
			offsetY: -8,
		});
		expect(String(offset.transform)).toContain("-12px");
		expect(String(offset.transform)).toContain("-8px");
	});
});
