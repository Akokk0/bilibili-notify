// @vitest-environment jsdom

/**
 * 新手指引面板(五轮定稿:独立路由撤销,教程并进关于页的 guide section,
 * `/about/guide/:chapter?` 深链直达)。
 *
 * 钉住的结构性约定:
 * - 深链 `/about/guide/<章节>` 直达对应章节,未知章节回退总览不白屏 ——
 *   导览尾巴与文内互链都靠这条;
 * - 总览开头是选型表(定案:两条 QQ 路都写全,开头帮选型);
 * - push 章双路都在(NapCat/onebot 与 qq-official 扫码),内容完整内嵌不依赖外链;
 * - 面板常驻进度(与左缘导览同一份判据)。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const apiGet = vi.hoisted(() => vi.fn(async (_path: string) => null as unknown));
const apiPatch = vi.hoisted(() => vi.fn(async (_p: string, _b?: unknown) => ({})));

vi.mock("../../../services/api", () => ({ api: { get: apiGet, patch: apiPatch } }));

function Location() {
	const location = useLocation();
	return <output aria-label="当前位置">{location.pathname}</output>;
}

async function mount(path: string) {
	apiGet.mockImplementation(async (p: string) => {
		if (p === "/api/accounts") {
			return {
				accounts: [
					{
						sourceKey: "library",
						state: { status: "logged-in", loggedInAt: "2026-10-11T00:00:00Z" },
					},
				],
			};
		}
		if (p === "/api/subscriptions") return [{ id: "s1" }];
		if (p === "/api/connections") return [];
		if (p === "/api/targets") return [];
		// 短版只有四格;毕业卡两条尾巴读的模块开关在详情口。
		if (p === "/api/health")
			return {
				status: "ok",
				version: "0.0.0-test",
				startedAt: "2026-10-28T00:00:00.000Z",
				uptime: 1,
			};
		if (p === "/api/health/details")
			return { phase: "running", modules: { dynamic: true, live: false, image: false, ai: false } };
		return null;
	});
	const { default: About } = await import("../../About");
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={[path]}>
				<Location />
				<Routes>
					<Route path="/about/:section?/:chapter?" element={<About />} />
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
	vi.restoreAllMocks();
});

describe("关于页 · 新手指引 section", () => {
	it("章节使用横向Tab，深链选中与切换后的正文同步", async () => {
		await mount("/about/guide/login");
		expect(
			(await screen.findByRole("tab", { name: "登录来源账号" })).getAttribute("aria-selected"),
		).toBe("true");
		fireEvent.click(screen.getByRole("tab", { name: "总览与选型" }));
		expect(screen.getByLabelText("当前位置").textContent).toBe("/about/guide");
		expect(screen.getByRole("tab", { name: "总览与选型" }).getAttribute("aria-selected")).toBe(
			"true",
		);
		expect(await screen.findByText(/群推送/)).toBeTruthy();
	});

	it("/about/guide 渲染总览:开头是 QQ 通道选型表", async () => {
		await mount("/about/guide");
		// 选型表的判据维度(grilling 定案四维)至少出现「群推送」这一最硬分流
		expect(await screen.findByText(/群推送/)).toBeTruthy();
		expect(screen.getByText(/有登录能力的来源逐个登录/)).toBeTruthy();
		expect(screen.queryByText(/登录 B 站账号/)).toBeNull();
	});

	it("/about/guide/push 双路都在:NapCat 教程与官方扫码一键建都出现", async () => {
		await mount("/about/guide/push");
		expect((await screen.findAllByText(/NapCat/)).length).toBeGreaterThan(0);
		expect(screen.getAllByText(/扫码连接/).length).toBeGreaterThan(0);
	});

	it("/about/guide/login 渲染来源登录与排序说明", async () => {
		await mount("/about/guide/login");
		// 用登录章独有的正文锚点,不依赖标题元素的 heading 角色
		expect(await screen.findByText(/不同来源的账号分别管理/)).toBeTruthy();
	});

	it("未知章节回退总览,不白屏", async () => {
		await mount("/about/guide/nonsense");
		expect(await screen.findByText(/群推送/)).toBeTruthy();
	});

	it("面板常驻进度:已登录+有订阅 → 2/5", async () => {
		await mount("/about/guide");
		expect(await screen.findByText("2/5")).toBeTruthy();
	});
});
