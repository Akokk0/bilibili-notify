// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { THEME_STORAGE_KEY } from "../../services/theme";
import { useSkinStore } from "../../store/skin";
import { useThemeStore } from "../../store/theme";
import { ThemeRoot } from "../theme-root";

const apiGet = vi.hoisted(() =>
	vi.fn(async (path: string) => {
		if (path === "/api/health") return { status: "ok", uptime: 1 };
		if (path === "/api/subs") return [];
		if (path === "/api/targets") return [];
		return null;
	}),
);

vi.mock("../../services/api", () => ({ api: { get: apiGet } }));

async function importHeader() {
	const mod = await import("../header");
	return mod.GlassHeader;
}

function resetThemeStore(): void {
	useThemeStore.setState({
		preference: "system",
		systemPrefersDark: false,
		resolved: "light",
	});
}

function stubLocalStorage(initial: Record<string, string> = {}) {
	const store = new Map(Object.entries(initial));
	const getItem = vi.fn((key: string) => store.get(key) ?? null);
	const setItem = vi.fn((key: string, value: string) => store.set(key, value));
	vi.stubGlobal("localStorage", { getItem, setItem });
	return { getItem, setItem, store };
}

function stubMatchMedia(matches: boolean) {
	const mql = {
		matches,
		media: "(prefers-color-scheme: dark)",
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	};
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => mql),
	);
}

async function renderHeader() {
	const GlassHeader = await importHeader();
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<ThemeRoot>
				<MemoryRouter>
					<GlassHeader />
				</MemoryRouter>
			</ThemeRoot>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	apiGet.mockClear();
	resetThemeStore();
	useSkinStore.setState({ lockedTheme: null, editing: false });
	delete document.documentElement.dataset.theme;
	document.documentElement.style.colorScheme = "";
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("GlassHeader 一级导航挂点", () => {
	// 挂点掉了皮肤只会静默失效(此类已复发多回),钉住:一级导航走 tab 家族,
	// 当前路由那格额外挂 tab-active(data-bn 是静态属性,选中态由 useLocation 手算)。
	it("一级导航挂 tab,当前路由的那格额外挂 tab-active", async () => {
		stubLocalStorage();
		stubMatchMedia(false);

		await renderHeader();

		const nav = document.querySelector('nav[data-bn~="nav"]');
		expect(nav).toBeTruthy();
		const tabs = [...(nav as Element).querySelectorAll('[data-bn~="tab"]')];
		expect(tabs.length).toBeGreaterThan(0);
		for (const el of tabs) expect(el.getAttribute("data-bn")).not.toContain("btn");
		// MemoryRouter 初始路由是 "/" —— 只有「概览」是选中态。
		const actives = tabs.filter((el) =>
			(el.getAttribute("data-bn") ?? "").split(/\s+/).includes("tab-active"),
		);
		expect(actives.map((el) => el.textContent)).toEqual(["概览"]);
	});
});

describe("GlassHeader theme switcher", () => {
	it("shows the theme entry and three choices", async () => {
		stubLocalStorage();
		stubMatchMedia(false);

		await renderHeader();

		const trigger = await screen.findByRole("button", { name: /主题：跟随系统/ });
		fireEvent.click(trigger);

		expect(screen.getByRole("button", { name: "跟随系统" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "浅色" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "深色" })).toBeTruthy();
	});

	it("switches to dark from the header and persists it", async () => {
		const storage = stubLocalStorage();
		stubMatchMedia(false);

		await renderHeader();
		fireEvent.click(await screen.findByRole("button", { name: /主题：跟随系统/ }));
		fireEvent.click(screen.getByRole("button", { name: "深色" }));

		await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
		expect(useThemeStore.getState().preference).toBe("dark");
		expect(storage.setItem).toHaveBeenLastCalledWith(THEME_STORAGE_KEY, "dark");
		expect(screen.getByRole("button", { name: /主题：深色/ })).toBeTruthy();
	});

	it("switches back to system and resolves from the system preference", async () => {
		const storage = stubLocalStorage({ [THEME_STORAGE_KEY]: "dark" });
		stubMatchMedia(false);

		await renderHeader();
		await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
		fireEvent.click(screen.getByRole("button", { name: /主题：深色/ }));
		fireEvent.click(screen.getByRole("button", { name: "跟随系统" }));

		await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
		expect(useThemeStore.getState()).toMatchObject({ preference: "system", resolved: "light" });
		expect(storage.setItem).toHaveBeenLastCalledWith(THEME_STORAGE_KEY, "system");
	});

	it("编辑器锁着主题时,别说成「试穿」—— 那句话指的操作在编辑器里不存在", async () => {
		// 编辑器编哪一套就锁哪一套(双套皮肤也锁)。沿用试穿那句「应用或取消试穿即可
		// 切换」的话,主人会去找一个抽屉里根本没有的按钮。
		stubLocalStorage();
		stubMatchMedia(false);
		useSkinStore.setState({ lockedTheme: "light", editing: true });

		await renderHeader();

		const btn = await screen.findByRole("button", { name: /主题：浅色/ });
		expect(btn.getAttribute("title")).toContain("编辑");
		expect(btn.getAttribute("title")).not.toContain("试穿");
	});
});
