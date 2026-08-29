// @vitest-environment jsdom

/**
 * 新手导览小卡(三轮定案:左下角常驻唯一载体)的行为:
 * 未毕业且未收起 → 常驻;收起(server 的 onboardingDismissed)→ 不渲染;
 * 「跳过指引」与毕业「完成」都 PATCH onboardingDismissed;有锚点的子步在
 * 目标路由上时渲染聚光灯挖洞层。判据跟随逻辑在 tour.test.ts。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useAuthStore } from "../../../store/auth";
import { BiliLoginStatus } from "../../../types/auth";

const apiGet = vi.hoisted(() => vi.fn(async (_path: string) => null as unknown));
const apiPatch = vi.hoisted(() => vi.fn(async (_p: string, _b?: unknown) => ({})));

vi.mock("../../../services/api", () => ({ api: { get: apiGet, patch: apiPatch } }));

interface Scenario {
	loggedIn?: boolean;
	subs?: unknown[];
	adapters?: unknown[];
	targets?: unknown[];
	dismissed?: boolean;
	route?: string;
}

async function mount(s: Scenario) {
	useAuthStore.setState({
		snapshot: {
			status: s.loggedIn ? BiliLoginStatus.LOGGED_IN : BiliLoginStatus.NOT_LOGIN,
			msg: "",
		},
	});
	apiGet.mockImplementation(async (path: string) => {
		if (path === "/api/subs") return s.subs ?? [];
		if (path === "/api/adapters") return s.adapters ?? [];
		if (path === "/api/targets") return s.targets ?? [];
		if (path === "/api/globals") return { onboardingDismissed: s.dismissed === true };
		if (path === "/api/health")
			return { status: "ok", uptime: 1, modules: { image: false, ai: false } };
		return null;
	});
	const { TourCompanion } = await import("../tour-companion");
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={[s.route ?? "/"]}>
				<TourCompanion />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	apiGet.mockReset();
	apiPatch.mockReset();
	apiPatch.mockResolvedValue({});
	// jsdom 没有 scrollIntoView;聚光灯首次锁定目标时会调它
	Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
	cleanup();
	useAuthStore.getState().clear();
	for (const el of document.querySelectorAll("[data-tour]")) el.remove();
	vi.restoreAllMocks();
});

describe("TourCompanion 常驻小卡", () => {
	it("新用户(未收起未毕业):常驻显示当前步,无需任何入口", async () => {
		await mount({ route: "/" });
		expect(await screen.findByText("扫码登录 B 站")).toBeTruthy();
		expect(screen.getByRole("button", { name: "带我去" })).toBeTruthy();
	});

	it("收起过(server 状态):不渲染", async () => {
		await mount({ dismissed: true, route: "/" });
		await new Promise((r) => setTimeout(r, 20));
		expect(screen.queryByLabelText("新手导览")).toBeNull();
	});

	it("「跳过指引」PATCH onboardingDismissed 到 server", async () => {
		await mount({ route: "/system" });
		await screen.findByText("扫码登录 B 站");
		fireEvent.click(screen.getByRole("button", { name: "跳过指引" }));
		await waitFor(() =>
			expect(apiPatch).toHaveBeenCalledWith("/api/globals", { onboardingDismissed: true }),
		);
	});

	it("聚光灯:在目标路由且锚点元素存在时渲染挖洞层", async () => {
		const anchorEl = document.createElement("div");
		anchorEl.setAttribute("data-tour", "bili-login");
		document.body.appendChild(anchorEl);
		await mount({ route: "/system" });
		await screen.findByText("扫码登录 B 站");
		await waitFor(() => expect(screen.getByTestId("tour-spotlight")).toBeTruthy());
	});

	it("不在目标路由:无聚光灯,给「带我去」", async () => {
		const anchorEl = document.createElement("div");
		anchorEl.setAttribute("data-tour", "bili-login");
		document.body.appendChild(anchorEl);
		await mount({ route: "/" });
		await screen.findByText("扫码登录 B 站");
		expect(screen.queryByTestId("tour-spotlight")).toBeNull();
	});

	it("adapter 主步:子步手动翻页", async () => {
		await mount({ loggedIn: true, subs: [{ id: "s1" }], route: "/targets" });
		expect(await screen.findByText("先选一条 QQ 接入路线")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "下一步" }));
		expect(await screen.findByText("新建推送适配器")).toBeTruthy();
	});

	it("全绿:祝贺态列未开启尾巴,点「完成」PATCH 收窗", async () => {
		await mount({
			loggedIn: true,
			subs: [{ id: "s1" }],
			adapters: [{ id: "a1", enabled: true, testStatus: { ok: true } }],
			targets: [{ id: "t1", enabled: true, testStatus: { ok: true } }],
		});
		expect(await screen.findByText(/全部配置完成/)).toBeTruthy();
		expect(screen.getByText(/图片渲染/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "完成" }));
		await waitFor(() =>
			expect(apiPatch).toHaveBeenCalledWith("/api/globals", { onboardingDismissed: true }),
		);
	});
});
