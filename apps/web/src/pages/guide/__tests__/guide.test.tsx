// @vitest-environment jsdom

/**
 * /guide 新手指引页(2026-08-29 grilling 定案:独立路由承载长图文教程)。
 *
 * 钉住的结构性约定:
 * - 路由 `/guide/:chapter?`,未知章节回退总览 —— 进度卡里的链接坏了也不该白屏;
 * - 总览开头是选型表(定案:两条 QQ 路都写全,开头帮选型);
 * - push 章双路都在(NapCat/onebot 与 qq-official 扫码),内容完整内嵌不依赖外链;
 * - 顶部常驻进度(与首页进度卡同一份判据),收起首页卡后这里仍看得到进度。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useAuthStore } from "../../../store/auth";
import { BiliLoginStatus } from "../../../types/auth";

const apiGet = vi.hoisted(() => vi.fn(async (_path: string) => null as unknown));
const apiPatch = vi.hoisted(() => vi.fn(async (_p: string, _b?: unknown) => ({})));

vi.mock("../../../services/api", () => ({ api: { get: apiGet, patch: apiPatch } }));

async function mount(path: string) {
	useAuthStore.setState({ snapshot: { status: BiliLoginStatus.LOGGED_IN, msg: "" } });
	apiGet.mockImplementation(async (p: string) => {
		if (p === "/api/subs") return [{ id: "s1" }];
		if (p === "/api/adapters") return [];
		if (p === "/api/targets") return [];
		if (p === "/api/health")
			return { status: "ok", uptime: 1, modules: { image: false, ai: false } };
		return null;
	});
	const { Guide } = await import("../Guide");
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={[path]}>
				<Routes>
					<Route path="/guide/:chapter?" element={<Guide />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	apiGet.mockReset();
});

afterEach(() => {
	cleanup();
	useAuthStore.getState().clear();
	vi.restoreAllMocks();
});

describe("Guide 路由与章节", () => {
	it("/guide 渲染总览:开头是 QQ 通道选型表", async () => {
		await mount("/guide");
		expect(await screen.findByText("新手指引")).toBeTruthy();
		// 选型表的判据维度(grilling 定案四维)至少出现「群推送」这一最硬分流
		expect(screen.getByText(/群推送/)).toBeTruthy();
	});

	it("/guide/push 双路都在:NapCat 教程与官方扫码一键建都出现", async () => {
		await mount("/guide/push");
		expect((await screen.findAllByText(/NapCat/)).length).toBeGreaterThan(0);
		expect(screen.getAllByText(/扫码一键创建/).length).toBeGreaterThan(0);
	});

	it("/guide/login 渲染 B 站登录章", async () => {
		await mount("/guide/login");
		// 用登录章独有的正文锚点,不依赖标题元素的 heading 角色
		expect(await screen.findByText(/自动轮换刷新 cookie/)).toBeTruthy();
	});

	it("未知章节回退总览,不白屏", async () => {
		await mount("/guide/nonsense");
		expect(await screen.findByText(/群推送/)).toBeTruthy();
	});

	it("顶部常驻进度:已登录+有订阅 → 2/5", async () => {
		await mount("/guide");
		expect(await screen.findByText("2/5")).toBeTruthy();
	});
});
