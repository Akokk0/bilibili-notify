// @vitest-environment jsdom
/**
 * 首页「系统状态 · 各模块」那四个模块(动态 / 直播 / 卡片 / AI)开没开,读的是详情口
 * `/api/health/details` 的 `modules`(ADR-0025 决策 12):短版 `/api/health` 只剩四格,不再带它。
 *
 * 这里整页渲染首页,钉的是**接线**:卡片自己按 prop 怎么画由 `dashboard-plugin-matrix` 管,这条管
 * 「prop 从哪来」—— 把首页改回读短版,或者干脆不传,卡片测试照绿,这里红。
 */

import type { HealthResponse, ModuleState } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { HEALTH_DETAILS_QUERY_KEY } from "../../hooks/useHealthDetails";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));
// 系统资源卡订 `resources` 频道;这里不起 WS。
vi.mock("../../services/wsSingleton", () => ({
	onWsEvent: () => () => {},
	subscribeChannels: () => {},
	unsubscribeChannels: () => {},
}));

import { api } from "../../services/api";
import Dashboard from "../Dashboard";

/** 短版:只有这四格。 */
const SHORT: HealthResponse = {
	status: "ok",
	version: "0.9.0",
	startedAt: "2026-10-28T00:00:00.000Z",
	uptime: 1,
};

const ALL_ON: ModuleState = {
	dynamic: true,
	live: true,
	image: true,
	ai: true,
};

function mockApi(opts: { loggedIn: boolean; details: () => Promise<unknown> }) {
	vi.mocked(api.get).mockImplementation(async (path: string) => {
		if (path === "/api/health") return SHORT;
		if (path === "/api/health/details") return opts.details();
		if (path === "/api/sources/bilibili/auth") {
			return {
				state: opts.loggedIn
					? { status: "logged-in", loggedInAt: "2026-10-28T00:00:00.000Z" }
					: { status: "logged-out" },
			};
		}
		if (path === "/api/settings") return { core: { logging: { level: "info", levels: {} } } };
		if (path === "/api/subscriptions" || path === "/api/targets") return [];
		if (path === "/api/live/listening") return [];
		if (path.startsWith("/api/history/daily")) return { days: [] };
		if (path.startsWith("/api/history")) return { entries: [] };
		if (path === "/api/stats/followers") return { entries: [] };
		if (path === "/api/ext") return { extensions: [] };
		if (path === "/api/sources") return { sources: [] };
		return null;
	});
}

function renderDashboard() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={["/"]}>
				<Dashboard />
			</MemoryRouter>
		</QueryClientProvider>,
	);
	return qc;
}

class FakeRO {
	observe() {}
	unobserve() {}
	disconnect() {}
}

beforeEach(() => {
	vi.stubGlobal("__WEB_VERSION__", "0.0.0-test");
	vi.stubGlobal("ResizeObserver", FakeRO);
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

describe("首页各模块的状态读详情口", () => {
	it("短版没有 modules、详情说四个都开着 → 8 / 8(没登录也不影响动态那格)", async () => {
		// 没登录:要是动态那格落到「详情没回来」的兜底(跟着登录态走),就只有 4 / 8。
		mockApi({ loggedIn: false, details: async () => ({ phase: "running", modules: ALL_ON }) });
		renderDashboard();
		expect(await screen.findByText("模块全部就绪")).toBeTruthy();
		expect(screen.getByTitle("就绪的模块数").textContent).toBe("8 / 8");
	});

	it("开机详情保留在缓存,首页沿用兜底;运行详情回来后模块恢复", async () => {
		const startup = { phase: "migrating", progress: { step: 1, total: 27, label: "设置与订阅" } };
		mockApi({ loggedIn: true, details: async () => startup });
		const qc = renderDashboard();
		await waitFor(() => expect(qc.getQueryData(HEALTH_DETAILS_QUERY_KEY)).toEqual(startup));
		expect(screen.getByTitle("就绪的模块数").textContent).toBe("5 / 8");
		mockApi({ loggedIn: true, details: async () => ({ phase: "running", modules: ALL_ON }) });
		await qc.invalidateQueries({ queryKey: HEALTH_DETAILS_QUERY_KEY });
		expect(await screen.findByText("模块全部就绪")).toBeTruthy();
	});

	it("详情口失败 → 兜底:动态跟着登录态,其余三个按没开算", async () => {
		mockApi({
			loggedIn: true,
			details: async () => {
				throw new Error("details 挂了");
			},
		});
		const qc = renderDashboard();
		// 等的是「详情确实失败了」,不是「请求发出去了」:兜底那一帧在详情回来之前就已经是这样。
		await waitFor(() => expect(qc.getQueryState(HEALTH_DETAILS_QUERY_KEY)?.status).toBe("error"));
		await waitFor(() => expect(screen.getByTitle("就绪的模块数").textContent).toBe("5 / 8"));
		expect(screen.getByText("3 个模块未启用")).toBeTruthy();
	});
});
