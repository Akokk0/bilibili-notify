// @vitest-environment jsdom

/**
 * SkinRoot:启动拉双槽启用皮肤 → 按当前主题注入对应槽;preview 优先于 active;
 * ?skin=off 逃生舱;锁模式只属于试穿(启用后的槽皮肤不锁 —— 槽空=默认装;
 * dataset.theme 唯一 writer 是 ThemeRoot,SkinRoot 只写 skin store 的 lockedTheme)。
 */

import type { ActiveSkinResponse, SkinManifest } from "@bilibili-notify/contract";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useSessionStore } from "../../store/session";
import { useSkinStore } from "../../store/skin";
import { useThemeStore } from "../../store/theme";
import { SkinRoot } from "../skin-root";
import { ThemeRoot } from "../theme-root";

const H = vi.hoisted(() => ({
	activeResponse: { active: { light: null, dark: null } } as {
		active: {
			light: { id: string; manifest: SkinManifest } | null;
			dark: { id: string; manifest: SkinManifest } | null;
		};
	},
}));

vi.mock("../../services/api", () => ({
	api: {
		get: vi.fn(async (path: string) => {
			if (path === "/api/skins/active") return H.activeResponse;
			throw new Error(`unexpected GET ${path}`);
		}),
	},
}));

function makeSkin(
	modes: SkinManifest["modes"],
	id = "abc",
): { id: string; manifest: SkinManifest } {
	return { id, manifest: { schemaVersion: 1, name: "测试", modes } };
}

/** 单套皮肤按其具备的模式落槽(与服务端 activate 同语义)。 */
function slotsOf(skin: { id: string; manifest: SkinManifest }): ActiveSkinResponse["active"] {
	return {
		light: skin.manifest.modes.light ? skin : null,
		dark: skin.manifest.modes.dark ? skin : null,
	};
}

function rootVar(name: string): string {
	return document.documentElement.style.getPropertyValue(name);
}

beforeEach(() => {
	vi.stubGlobal("localStorage", {
		getItem: () => null,
		setItem: () => {},
	});
	vi.stubGlobal("matchMedia", () => ({
		matches: false,
		addEventListener: () => {},
		removeEventListener: () => {},
	}));
	window.history.replaceState({}, "", "/");
	H.activeResponse = { active: { light: null, dark: null } };
	useThemeStore.setState({ preference: "system", systemPrefersDark: false, resolved: "light" });
	useSessionStore.setState({ authRequired: false, authed: false, hydrated: false, expired: false });
	useSkinStore.setState({
		active: { light: null, dark: null },
		preview: null,
		killSwitch: false,
		lockedTheme: null,
	});
	document.documentElement.removeAttribute("style");
	delete document.documentElement.dataset.theme;
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function renderRoots() {
	return render(
		<ThemeRoot>
			<SkinRoot>
				<div>ok</div>
			</SkinRoot>
		</ThemeRoot>,
	);
}

describe("SkinRoot", () => {
	it("启动拉 active 皮肤 → 变量注入 documentElement", async () => {
		H.activeResponse = { active: slotsOf(makeSkin({ light: { colors: { accent: "#123456" } } })) };
		renderRoots();
		await waitFor(() => expect(rootVar("--color-bn-pink")).toBe("#123456"));
	});

	it("?skin=off → active 皮肤不注入(逃生舱)", async () => {
		window.history.replaceState({}, "", "/?skin=off");
		H.activeResponse = { active: slotsOf(makeSkin({ light: { colors: { accent: "#123456" } } })) };
		renderRoots();
		await waitFor(() => expect(useSkinStore.getState().active.light).not.toBeNull());
		expect(rootVar("--color-bn-pink")).toBe("");
	});

	it("暗槽皮肤 + 用户 light → 浅色是默认装,不锁主题(锁只属于试穿)", async () => {
		H.activeResponse = { active: slotsOf(makeSkin({ dark: { colors: { accent: "#bbb222" } } })) };
		renderRoots();
		await waitFor(() => expect(useSkinStore.getState().active.dark).not.toBeNull());
		expect(useSkinStore.getState().lockedTheme).toBeNull();
		expect(document.documentElement.dataset.theme).toBe("light");
		expect(rootVar("--color-bn-pink")).toBe("");
	});

	it("深浅槽各挂一套:切主题就换对应槽的皮肤", async () => {
		H.activeResponse = {
			active: {
				light: makeSkin({ light: { colors: { accent: "#111111" } } }, "skin-l"),
				dark: makeSkin({ dark: { colors: { accent: "#222222" } } }, "skin-d"),
			},
		};
		renderRoots();
		await waitFor(() => expect(rootVar("--color-bn-pink")).toBe("#111111"));
		expect(useSkinStore.getState().lockedTheme).toBeNull();

		useThemeStore.getState().setPreference("dark");
		await waitFor(() => expect(rootVar("--color-bn-pink")).toBe("#222222"));
		expect(document.documentElement.dataset.theme).toBe("dark");
		expect(useSkinStore.getState().lockedTheme).toBeNull();
	});

	it("preview 优先于 active;清 preview 回 active", async () => {
		H.activeResponse = { active: slotsOf(makeSkin({ light: { colors: { accent: "#111111" } } })) };
		renderRoots();
		await waitFor(() => expect(rootVar("--color-bn-pink")).toBe("#111111"));

		useSkinStore.getState().setPreview({
			id: "p1",
			manifest: {
				schemaVersion: 1,
				name: "试穿",
				modes: { light: { colors: { accent: "#222222" } } },
			},
		});
		await waitFor(() => expect(rootVar("--color-bn-pink")).toBe("#222222"));

		useSkinStore.getState().setPreview(null);
		await waitFor(() => expect(rootVar("--color-bn-pink")).toBe("#111111"));
	});

	it("试穿纯 dark 皮肤 + 用户 light → 锁到 dark 看效果(lockedTheme=dark)", async () => {
		renderRoots();
		useSkinStore.getState().setPreview(makeSkin({ dark: { colors: { accent: "#bbb222" } } }, "p1"));
		await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
		expect(useSkinStore.getState().lockedTheme).toBe("dark");
		expect(rootVar("--color-bn-pink")).toBe("#bbb222");

		useSkinStore.getState().setPreview(null);
		await waitFor(() => expect(useSkinStore.getState().lockedTheme).toBeNull());
	});

	it("双套皮肤占两槽:主题跟随用户,两模式各取所配", async () => {
		H.activeResponse = {
			active: slotsOf(
				makeSkin({
					light: { colors: { accent: "#111111" } },
					dark: { colors: { accent: "#222222" } },
				}),
			),
		};
		renderRoots();
		await waitFor(() => expect(rootVar("--color-bn-pink")).toBe("#111111"));
		expect(useSkinStore.getState().lockedTheme).toBeNull();
		expect(document.documentElement.dataset.theme).toBe("light");

		useThemeStore.getState().setPreference("dark");
		await waitFor(() => expect(rootVar("--color-bn-pink")).toBe("#222222"));
		expect(document.documentElement.dataset.theme).toBe("dark");
	});
});

describe("SkinRoot / 自定义 CSS 注入", () => {
	it("皮肤带 css → <style#bn-skin-css> 注入且 hook 已翻译;清皮肤 → style 移除", async () => {
		H.activeResponse = {
			active: slotsOf({
				id: "abc",
				manifest: {
					schemaVersion: 1,
					name: "测试",
					css: '[data-bn="glass"]{border-width:2px}',
					modes: { light: { css: '[data-bn="btn"]{opacity:0.9}' } },
				},
			}),
		};
		renderRoots();
		await waitFor(() => expect(document.getElementById("bn-skin-css")).not.toBeNull());
		const css = document.getElementById("bn-skin-css")?.textContent ?? "";
		expect(css).toContain(':is(.bn-glass,[data-bn~="glass"]){border-width:2px}');
		expect(css).toContain('[data-bn~="btn"]{opacity:0.9}');

		useSkinStore.getState().setKillSwitch(true);
		await waitFor(() => expect(document.getElementById("bn-skin-css")).toBeNull());
	});
});

describe("SkinRoot / 自带字体", () => {
	it("fonts.asset → @font-face 进同一个 style 标签,--font-cjk 排在最前", async () => {
		// 两半各自能过单测也不够:少接上任何一半都是「选得动、存得住、就是不生效」
		// —— 只有变量没有 @font-face,浏览器认不出这个家族名,静静跳到下一个。
		H.activeResponse = {
			active: slotsOf(
				makeSkin({ light: { fonts: { asset: "assets/font-a1.woff2", body: ["霞鹜文楷"] } } }),
			),
		};
		renderRoots();
		await waitFor(() =>
			expect(document.getElementById("bn-skin-css")?.textContent ?? "").toContain("@font-face"),
		);
		const css = document.getElementById("bn-skin-css")?.textContent ?? "";
		expect(css).toContain('url("/api/skins/abc/assets/font-a1.woff2")');
		expect(document.documentElement.style.getPropertyValue("--font-cjk")).toBe(
			'"bn-skin-font", "霞鹜文楷", system-ui, sans-serif',
		);
	});
});

describe("SkinRoot / 动效预设层", () => {
	it("bokeh → 渲染穿透点击的效果层;effects CSS 拼进 style 标签", async () => {
		H.activeResponse = {
			active: slotsOf(
				makeSkin({
					light: {
						effects: {
							bokeh: { colors: ["#fb7299", "#00aeec"] },
						},
					},
				}),
			),
		};
		const { container } = renderRoots();
		await waitFor(() => {
			const layer = container.querySelector("[data-skin-effects]") as HTMLElement | null;
			expect(layer).toBeTruthy();
			expect(layer?.className).toContain("pointer-events-none");
		});
		// 光斑:2 团
		const layer = container.querySelector("[data-skin-effects]") as HTMLElement;
		expect(layer.querySelectorAll("[data-skin-bokeh]")).toHaveLength(2);
		// 动效 CSS 同一拍进了 style 标签
		const css = document.getElementById("bn-skin-css")?.textContent ?? "";
		expect(css).toContain("bn-skin-drift");
	});

	it("只有 glassShine(无光斑)→ 不渲染效果层,但 CSS 在", async () => {
		H.activeResponse = {
			active: slotsOf(makeSkin({ light: { effects: { glassShine: {} } } })),
		};
		const { container } = renderRoots();
		await waitFor(() =>
			expect(document.getElementById("bn-skin-css")?.textContent ?? "").toContain(
				"bn-skin-glass-shine",
			),
		);
		expect(container.querySelector("[data-skin-effects]")).toBeNull();
	});
});

describe("SkinRoot × 登录门", () => {
	it("authRequired 且未 authed → 不拉 active;登录(markAuthed)后才拉并注入", async () => {
		useSessionStore.setState({ authRequired: true, authed: false, hydrated: true });
		H.activeResponse = { active: slotsOf(makeSkin({ light: { colors: { accent: "#654321" } } })) };
		renderRoots();
		// 未登录:不该有任何注入
		await new Promise((r) => setTimeout(r, 20));
		expect(rootVar("--color-bn-pink")).toBe("");

		useSessionStore.getState().markAuthed();
		await waitFor(() => expect(rootVar("--color-bn-pink")).toBe("#654321"));
	});
});
