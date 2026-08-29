// @vitest-environment jsdom

/**
 * 「带我做」伴随窗的行为(判据跟随逻辑在 tour.test.ts,这里钉组件):
 * 未激活不渲染;激活后显示当前主步的子步;跨路由给「带我去」;子步手动翻页;
 * 「跳过指引」关掉并持久化;全绿进入祝贺态。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useAuthStore } from "../../../store/auth";
import { useTourStore } from "../../../store/tour";
import { BiliLoginStatus } from "../../../types/auth";

const apiGet = vi.hoisted(() => vi.fn(async (_path: string) => null as unknown));
const apiPatch = vi.hoisted(() => vi.fn(async (_p: string, _b?: unknown) => ({})));

vi.mock("../../../services/api", () => ({ api: { get: apiGet, patch: apiPatch } }));

interface Scenario {
	loggedIn?: boolean;
	subs?: unknown[];
	adapters?: unknown[];
	targets?: unknown[];
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
		if (path === "/api/globals") return { onboardingDismissed: false };
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
	localStorage.clear();
	useTourStore.setState({ active: false });
});

afterEach(() => {
	cleanup();
	useAuthStore.getState().clear();
	vi.restoreAllMocks();
});

describe("TourCompanion", () => {
	it("未激活:不渲染", async () => {
		await mount({});
		await new Promise((r) => setTimeout(r, 20));
		expect(screen.queryByLabelText("新手导览")).toBeNull();
	});

	it("激活 + 未登录:显示登录子步;不在 /system 时给「带我去」", async () => {
		useTourStore.setState({ active: true });
		await mount({ route: "/" });
		expect(await screen.findByText("扫码登录 B 站")).toBeTruthy();
		expect(screen.getByRole("button", { name: "带我去" })).toBeTruthy();
	});

	it("已在目标路由:不显示「带我去」", async () => {
		useTourStore.setState({ active: true });
		await mount({ route: "/system" });
		await screen.findByText("扫码登录 B 站");
		expect(screen.queryByRole("button", { name: "带我去" })).toBeNull();
	});

	it("adapter 主步:子步可手动翻页(选型说明 → 新建适配器)", async () => {
		useTourStore.setState({ active: true });
		await mount({ loggedIn: true, subs: [{ id: "s1" }], route: "/targets" });
		expect(await screen.findByText("先选一条 QQ 接入路线")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "下一步" }));
		expect(await screen.findByText("新建推送适配器")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "上一步" }));
		expect(await screen.findByText("先选一条 QQ 接入路线")).toBeTruthy();
	});

	it("「跳过指引」关掉导览并持久化", async () => {
		useTourStore.setState({ active: true });
		await mount({ route: "/system" });
		await screen.findByText("扫码登录 B 站");
		fireEvent.click(screen.getByRole("button", { name: "跳过指引" }));
		expect(useTourStore.getState().active).toBe(false);
		expect(localStorage.getItem("bn-tour-active")).toBe("0");
	});

	it("全绿:祝贺态,点「完成」收窗", async () => {
		useTourStore.setState({ active: true });
		await mount({
			loggedIn: true,
			subs: [{ id: "s1" }],
			adapters: [{ id: "a1", enabled: true, testStatus: { ok: true } }],
			targets: [{ id: "t1", enabled: true, testStatus: { ok: true } }],
		});
		expect(await screen.findByText(/全部配置完成/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "完成" }));
		expect(useTourStore.getState().active).toBe(false);
	});
});
