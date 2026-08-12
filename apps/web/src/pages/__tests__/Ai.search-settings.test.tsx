// @vitest-environment jsdom

/**
 * AI 页「联网搜索」设置块 —— `ai.search`。
 *
 * 这块与选哪家 AI 服务商**正交**:搜索由博查 / Tavily 真正执行,所以它住在
 * 「全局配置」Tab 自己的 GlassBox 里,不挂在任何实例桶下。守四件事:
 *
 * 1. 后端 Picker + key 输入框恒在场,key 是密文输入;
 * 2. key **按后端各存一格**:切到 Tavily,输入框换成 tavily 那格,博查的不丢;
 * 3. 三个引擎开关(点评 / 总结 / 锐评)在场且**默认全关** —— 搜索按次付费,
 *    自动路径必须主人亲手点亮;
 * 4. 这些改动会让灵动岛变 dirty —— 不喂给 packIsland 的话保存条不亮,主人一走就丢。
 */

import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useDraftStore } from "../../store/draft";
import Ai from "../Ai";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), patch: vi.fn(), post: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

function globals() {
	const g = makeDefaultGlobalConfig();
	g.defaults.ai.enabled = true;
	return JSON.parse(JSON.stringify(g));
}

function mount() {
	const g = globals();
	vi.mocked(api.get).mockImplementation(async (path: string) =>
		path === "/api/targets" ? [] : JSON.parse(JSON.stringify(g)),
	);
	vi.mocked(api.patch).mockImplementation(async () => JSON.parse(JSON.stringify(g)));
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<Ai />
		</QueryClientProvider>,
	);
}

function inputAt(code: string): HTMLInputElement | null {
	return document.querySelector<HTMLInputElement>(`[data-code="${code}"] input`);
}

beforeEach(() => {
	vi.clearAllMocks();
	useDraftStore.setState({ current: null });
});
afterEach(cleanup);

describe("Ai 页 · 联网搜索设置块", () => {
	it("后端 Picker 与博查的 key 输入框在场,key 是密文", async () => {
		mount();
		await screen.findByText("联网搜索");
		// 注册表两家都摆着(Picker 选项)。
		expect(screen.getByRole("button", { name: "博查" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Tavily" })).toBeTruthy();

		const key = inputAt("ai.search.keys.bocha");
		expect(key).toBeTruthy();
		expect(key?.type).toBe("password");
	});

	it("切到 Tavily → key 输入框换成 tavily 那格(各存一格,换后端不丢)", async () => {
		mount();
		await screen.findByText("联网搜索");
		const bocha = inputAt("ai.search.keys.bocha");
		expect(bocha).toBeTruthy();
		fireEvent.change(bocha as HTMLInputElement, { target: { value: "sk-bocha" } });

		fireEvent.click(screen.getByRole("button", { name: "Tavily" }));
		expect(inputAt("ai.search.keys.tavily")).toBeTruthy();
		expect(inputAt("ai.search.keys.bocha")).toBeNull();

		// 切回来,刚填的还在 —— 换后端不该丢另一家的 key。
		fireEvent.click(screen.getByRole("button", { name: "博查" }));
		expect(inputAt("ai.search.keys.bocha")?.value).toBe("sk-bocha");
	});

	it("三个引擎开关在场且默认全关", async () => {
		mount();
		await screen.findByText("联网搜索");
		for (const name of ["动态点评联网搜索", "直播总结联网搜索", "锐评联网搜索"]) {
			const toggle = screen.getByRole("button", { name });
			expect(toggle.getAttribute("aria-pressed")).toBe("false");
		}
	});

	it("拨一个引擎开关 → 灵动岛变 dirty(改动喂进了 packIsland)", async () => {
		mount();
		await screen.findByText("联网搜索");
		fireEvent.click(screen.getByRole("button", { name: "动态点评联网搜索" }));
		await waitFor(() => {
			expect(useDraftStore.getState().current?.diff.length ?? 0).toBeGreaterThan(0);
		});
	});
});
