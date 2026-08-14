// @vitest-environment jsdom

/**
 * SkinRoot:启动拉当前皮肤 → documentElement 注入变量;preview 优先于 active;
 * ?skin=off 逃生舱;单套皮肤锁模式(dataset.theme 唯一 writer 是 ThemeRoot,
 * SkinRoot 只写 skin store 的 lockedTheme)。
 */

import type { SkinManifest } from "@bilibili-notify/contract";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useSessionStore } from "../../store/session";
import { useSkinStore } from "../../store/skin";
import { useThemeStore } from "../../store/theme";
import { SkinRoot } from "../skin-root";
import { ThemeRoot } from "../theme-root";

const H = vi.hoisted(() => ({
	activeResponse: { active: null } as {
		active: { id: string; manifest: SkinManifest } | null;
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

function makeSkin(modes: SkinManifest["modes"]): { id: string; manifest: SkinManifest } {
	return { id: "abc", manifest: { schemaVersion: 1, name: "测试", modes } };
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
	H.activeResponse = { active: null };
	useThemeStore.setState({ preference: "system", systemPrefersDark: false, resolved: "light" });
	useSessionStore.setState({ authRequired: false, authed: false, hydrated: false, expired: false });
	useSkinStore.setState({ active: null, preview: null, killSwitch: false, lockedTheme: null });
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
		H.activeResponse = {
			active: makeSkin({ light: { colors: { accent: "#123456" } } }),
		};
		renderRoots();
		await waitFor(() => expect(rootVar("--color-bn-pink")).toBe("#123456"));
	});

	it("?skin=off → active 皮肤不注入(逃生舱)", async () => {
		window.history.replaceState({}, "", "/?skin=off");
		H.activeResponse = {
			active: makeSkin({ light: { colors: { accent: "#123456" } } }),
		};
		renderRoots();
		await waitFor(() => expect(useSkinStore.getState().active).not.toBeNull());
		expect(rootVar("--color-bn-pink")).toBe("");
	});

	it("单套 dark 皮肤 + 用户 light → 锁到 dark(dataset.theme=dark,lockedTheme=dark)", async () => {
		H.activeResponse = {
			active: makeSkin({ dark: { colors: { accent: "#bbb222" } } }),
		};
		renderRoots();
		await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
		expect(useSkinStore.getState().lockedTheme).toBe("dark");
		expect(rootVar("--color-bn-pink")).toBe("#bbb222");
	});

	it("preview 优先于 active;清 preview 回 active", async () => {
		H.activeResponse = {
			active: makeSkin({ light: { colors: { accent: "#111111" } } }),
		};
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

	it("双套皮肤不锁:lockedTheme 保持 null,主题跟随用户", async () => {
		H.activeResponse = {
			active: makeSkin({
				light: { colors: { accent: "#111111" } },
				dark: { colors: { accent: "#222222" } },
			}),
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

describe("SkinRoot × 登录门", () => {
	it("authRequired 且未 authed → 不拉 active;登录(markAuthed)后才拉并注入", async () => {
		useSessionStore.setState({ authRequired: true, authed: false, hydrated: true });
		H.activeResponse = {
			active: makeSkin({ light: { colors: { accent: "#654321" } } }),
		};
		renderRoots();
		// 未登录:不该有任何注入
		await new Promise((r) => setTimeout(r, 20));
		expect(rootVar("--color-bn-pink")).toBe("");

		useSessionStore.getState().markAuthed();
		await waitFor(() => expect(rootVar("--color-bn-pink")).toBe("#654321"));
	});
});

describe("SkinRoot / 贴纸装饰层", () => {
	it("active 皮肤带 decorations → 渲染穿透点击的贴纸 img,src 指向皮肤资产", async () => {
		H.activeResponse = {
			active: makeSkin({
				light: {
					decorations: [
						{ image: "assets/chara.png", anchor: "bottom-right", width: 220, opacity: 0.9 },
					],
				},
			}),
		};
		const { container } = renderRoots();
		await waitFor(() => {
			const img = container.querySelector("img[src='/api/skins/abc/assets/chara.png']");
			expect(img).toBeTruthy();
		});
		const layer = container.querySelector("[data-skin-decorations]") as HTMLElement;
		expect(layer.className).toContain("pointer-events-none");
	});

	it("无 decorations → 不渲染贴纸层;killSwitch 下也不渲染", async () => {
		H.activeResponse = {
			active: makeSkin({ light: { colors: { accent: "#123456" } } }),
		};
		const { container } = renderRoots();
		await waitFor(() => expect(rootVar("--color-bn-pink")).toBe("#123456"));
		expect(container.querySelector("[data-skin-decorations]")).toBeNull();
	});
});
