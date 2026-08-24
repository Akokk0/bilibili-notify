// @vitest-environment jsdom

/**
 * 顶栏一级导航「点下就选中」—— 不等路由。
 *
 * `data-bn` 是静态属性,选中态由 `useLocation()` 的 pathname 手算。而路由切换有
 * 一段缝(真机上量到 ~58ms):松手那一刻 `:active` 已经失效、`tab-active` 还没挂上,
 * 于是像素风皮肤那种「按下位移 3px」的装会**弹起来再按回去** —— 主人看到的是
 * 点一下抖一下(2026-08-24 真机指出:「按下,松手又弹起又按下」)。
 *
 * 这条测试把 `useLocation` 冻住,也就是把那段缝拉成无限长:选中态若只认 pathname,
 * 点下去永远不选中;认「点下的那一格」才立刻选中。
 *
 * 皮肤改不了这个 —— CSS 选择器管不到「刚刚被点过」,那一帧元素身上既没有 `:active`
 * 也没有 `tab-active`。所以修在站内。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
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

/**
 * `useLocation` 钉在 "/" 上 —— 点下去以后路由**永远**不到位。
 *
 * 只换这一个 hook:`useNavigate` 照旧(点击真的会去改 history),NavLink 照旧渲染,
 * 复现的正是「history 已经变了、组件还没读到」这一段。
 */
vi.mock("react-router-dom", async (importActual) => {
	const actual = (await importActual()) as Record<string, unknown>;
	return {
		...actual,
		useLocation: vi.fn(() => ({
			pathname: "/",
			search: "",
			hash: "",
			state: null,
			key: "frozen",
		})),
	};
});

function stubLocalStorage(): void {
	const store = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: vi.fn((k: string) => store.get(k) ?? null),
		setItem: vi.fn((k: string, v: string) => store.set(k, v)),
	});
}

function stubMatchMedia(): void {
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => ({
			matches: false,
			media: "(prefers-color-scheme: dark)",
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		})),
	);
}

/** 交出 rerender —— 「路由追上来了」这件事只能靠改 mock 再重渲染来演。 */
async function renderHeader(): Promise<() => void> {
	const { GlassHeader } = await import("../header");
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	// **每次现造一个 element** —— 传同一个引用进 rerender,React 会当作没变直接
	// bail out,于是改过的 useLocation 压根读不到(踩过)。
	const tree = () => (
		<QueryClientProvider client={qc}>
			<ThemeRoot>
				<MemoryRouter>
					<GlassHeader />
				</MemoryRouter>
			</ThemeRoot>
		</QueryClientProvider>
	);
	const { rerender } = render(tree());
	return () => rerender(tree());
}

/** 一级导航里挂着 tab 的那些格。 */
function tabs(): HTMLElement[] {
	const nav = document.querySelector('nav[data-bn~="nav"]');
	return [...(nav as Element).querySelectorAll<HTMLElement>('[data-bn~="tab"]')];
}

function activeLabels(): string[] {
	return tabs()
		.filter((el) => (el.getAttribute("data-bn") ?? "").split(/\s+/).includes("tab-active"))
		.map((el) => el.textContent ?? "");
}

/** 每条测试都从「路由钉在这里」开始 —— 不然上一条设过的值会漏给下一条。 */
function freezeRouteAt(pathname: string): void {
	vi.mocked(useLocation).mockReturnValue({
		pathname,
		search: "",
		hash: "",
		state: null,
		key: "frozen",
	});
}

beforeEach(() => {
	apiGet.mockClear();
	freezeRouteAt("/");
	useThemeStore.setState({ preference: "system", systemPrefersDark: false, resolved: "light" });
	useSkinStore.setState({ lockedTheme: null, editing: false });
	stubLocalStorage();
	stubMatchMedia();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("顶栏一级导航:点下就选中,不等路由", () => {
	it("点一格 → 它当场挂上 tab-active,而不是等 pathname 追上来", async () => {
		await renderHeader();
		const subs = tabs().find((el) => (el.textContent ?? "").includes("订阅 UP 主"));
		expect(subs).toBeTruthy();

		fireEvent.click(subs as HTMLElement);

		// 路由被冻在 "/",所以只认 pathname 的写法这里永远是「概览」——
		// 而那正是真机上那段缝里的样子:按下的位移弹了回去。
		expect(activeLabels().some((l) => l.includes("订阅 UP 主"))).toBe(true);
	});

	it("选中的只有一格 —— 乐观那一格顶掉旧的,不是两格同时按下", async () => {
		await renderHeader();
		const subs = tabs().find((el) => (el.textContent ?? "").includes("订阅 UP 主"));

		fireEvent.click(subs as HTMLElement);

		// 「旧的立刻弹起」是终稿里明写的一半(2026-08-24 主人口述)。两格同时保持
		// 按下的话,像素风那套装会看起来像卡住了。
		expect(activeLabels()).toHaveLength(1);
	});

	it("Cmd / Ctrl 点击不动选中态 —— 那是「在新标签打开」,这一页没换路由", async () => {
		await renderHeader();
		const subs = tabs().find((el) => (el.textContent ?? "").includes("订阅 UP 主"));

		fireEvent.click(subs as HTMLElement, { metaKey: true });

		// 认了的话顶栏会高亮一个根本没打开的格子,而且没有下一次 pathname 变化
		// 来把它清掉 —— 一直错到主人自己再点一次。
		expect(activeLabels().some((l) => l.includes("概览"))).toBe(true);
		expect(activeLabels().some((l) => l.includes("订阅 UP 主"))).toBe(false);
	});

	it("路由追上来之后乐观值作废 —— 落到第三个地方也不会还高亮着点过的那格", async () => {
		const rerender = await renderHeader();
		const subs = tabs().find((el) => (el.textContent ?? "").includes("订阅 UP 主"));
		fireEvent.click(subs as HTMLElement);
		expect(activeLabels().some((l) => l.includes("订阅 UP 主"))).toBe(true);

		// 路由动了,而且落在第三个地方(浏览器后退、程序内跳转都会这样)。乐观值
		// 该当场作废 —— 存成「需要清的状态」时,清的时机就是这里最容易漂的地方。
		freezeRouteAt("/history");
		rerender();

		expect(activeLabels().some((l) => l.includes("推送历史"))).toBe(true);
		expect(activeLabels().some((l) => l.includes("订阅 UP 主"))).toBe(false);
	});

	it("没点过任何一格时,选中态照旧跟着 pathname 走", async () => {
		await renderHeader();

		// 乐观值不能把初始状态也接管掉 —— 直接打开某个页面时,选中的必须是当前路由。
		expect(activeLabels().some((l) => l.includes("概览"))).toBe(true);
	});
});
