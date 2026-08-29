// @vitest-environment jsdom

/**
 * 新手进度卡的三态渲染与收起交互(判据逻辑在 derive.test.ts,这里只钉组件行为):
 *
 * ① 未全绿 → 完整卡:步骤可见、active 步给「去完成」入口。
 * ② 全绿且未收起 → 紧凑完成横幅 + 「收起」;点收起 PATCH
 *    `{ onboardingDismissed: true }` 到 /api/globals(存 server 是 grilling 定案)。
 * ③ globals.onboardingDismissed=true → 整卡不渲染(想再看去 /guide)。
 *
 * 收起前**不请求确认** —— 它可逆(数据还在,/guide 里进度照常显示),别加弹窗。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useAuthStore } from "../../../store/auth";
import { BiliLoginStatus } from "../../../types/auth";

const apiGet = vi.hoisted(() => vi.fn(async (_path: string) => null as unknown));
const apiPatch = vi.hoisted(() => vi.fn(async (_path: string, _body?: unknown) => ({})));

vi.mock("../../../services/api", () => ({ api: { get: apiGet, patch: apiPatch } }));

interface Scenario {
	loggedIn?: boolean;
	subs?: unknown[];
	adapters?: unknown[];
	targets?: unknown[];
	globals?: Record<string, unknown>;
	modules?: { image: boolean; ai: boolean };
}

async function mount(s: Scenario) {
	useAuthStore.setState({
		snapshot: s.loggedIn
			? { status: BiliLoginStatus.LOGGED_IN, msg: "" }
			: { status: BiliLoginStatus.NOT_LOGIN, msg: "" },
	});
	apiGet.mockImplementation(async (path: string) => {
		if (path === "/api/subs") return s.subs ?? [];
		if (path === "/api/adapters") return s.adapters ?? [];
		if (path === "/api/targets") return s.targets ?? [];
		if (path === "/api/globals") return s.globals ?? { onboardingDismissed: false };
		if (path === "/api/health")
			return { status: "ok", uptime: 1, modules: s.modules ?? { image: false, ai: false } };
		return null;
	});
	const { OnboardingCard } = await import("../onboarding-card");
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<MemoryRouter>
				<OnboardingCard />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

const GRADUATED: Scenario = {
	loggedIn: true,
	subs: [{ id: "s1" }],
	adapters: [{ id: "a1", enabled: true, testStatus: { ok: true } }],
	targets: [{ id: "t1", enabled: true, testStatus: { ok: true } }],
};

beforeEach(() => {
	apiGet.mockReset();
	apiPatch.mockReset();
	apiPatch.mockResolvedValue({});
});

afterEach(() => {
	cleanup();
	useAuthStore.getState().clear();
	vi.restoreAllMocks();
});

describe("OnboardingCard 三态", () => {
	it("空后端:完整卡可见,五步在列,active 步给「去完成」入口", async () => {
		await mount({});
		expect(await screen.findByText("登录 B 站账号")).toBeTruthy();
		expect(screen.getByText("订阅第一个 UP")).toBeTruthy();
		expect(screen.getByText("发送测试推送")).toBeTruthy();
		// active = login → 「去完成」指向 /system(B站扫码登录住 System 页)
		const cta = await screen.findByRole("link", { name: /去完成/ });
		expect(cta.getAttribute("href")).toBe("/system");
	});

	it("可选尾巴:图片渲染标「强烈推荐」,不算进五步", async () => {
		await mount({});
		expect(await screen.findByText("图片渲染")).toBeTruthy();
		expect(screen.getByText("强烈推荐")).toBeTruthy();
	});

	it("全绿未收起:完成横幅 + 收起;点收起 PATCH onboardingDismissed", async () => {
		await mount(GRADUATED);
		expect(await screen.findByText(/配置完成/)).toBeTruthy();
		// 完整步骤列表收进横幅,不再占半屏
		expect(screen.queryByText("登录 B 站账号")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "收起" }));
		await waitFor(() =>
			expect(apiPatch).toHaveBeenCalledWith("/api/globals", { onboardingDismissed: true }),
		);
	});

	it("已收起(server 状态):整卡不渲染", async () => {
		await mount({ ...GRADUATED, globals: { onboardingDismissed: true } });
		// 等 globals query 落定再断言"什么都没有"
		await new Promise((r) => setTimeout(r, 20));
		expect(screen.queryByText(/配置完成/)).toBeNull();
		expect(screen.queryByText("登录 B 站账号")).toBeNull();
	});

	it("每步带教程链接指向 /guide 对应章节", async () => {
		await mount({});
		const links = await screen.findAllByRole("link", { name: /教程/ });
		const hrefs = links.map((l) => l.getAttribute("href"));
		expect(hrefs).toContain("/guide/login");
		expect(hrefs).toContain("/guide/push");
	});
});
