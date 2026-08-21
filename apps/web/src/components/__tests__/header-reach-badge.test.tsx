// @vitest-environment jsdom

/**
 * 顶栏那枚「服务器通不通」的徽章。
 *
 * 两个分支此前各写一遍同一串 60 字符的类名,收成 `ReachBadge` 之后需要钉住的是
 * **合并没有把两态染成一个色** —— 真串了的话,后端掉线时页面上看不出任何变化,
 * 而那正是最需要它说话的时刻。
 *
 * 措辞也一起钉:这枚徽章只回答 `/api/health` 通不通。它曾经写着「推送服务运行中」,
 * 被读成了推送的启停开关 —— 而推送开没开是每位 UP 各自的 features。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ThemeRoot } from "../theme-root";

const apiGet = vi.hoisted(() => vi.fn(async (_path: string) => null as unknown));

vi.mock("../../services/api", () => ({ api: { get: apiGet } }));

beforeEach(() => {
	apiGet.mockReset();
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => ({
			matches: false,
			media: "(prefers-color-scheme: dark)",
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		})),
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** `healthy=false` 时让 /api/health 抛错 —— useBackendReachable 据此判失联。 */
async function mount(healthy: boolean) {
	apiGet.mockImplementation(async (path: string) => {
		if (path === "/api/health") {
			if (!healthy) throw new Error("unreachable");
			return { status: "ok", uptime: 1 };
		}
		if (path === "/api/subs" || path === "/api/targets") return [];
		return null;
	});
	const { GlassHeader } = await import("../header");
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<ThemeRoot>
				<MemoryRouter>
					<GlassHeader />
				</MemoryRouter>
			</ThemeRoot>
		</QueryClientProvider>,
	);
}

describe("服务器可达徽章", () => {
	it("通的时候是绿的,措辞落在「服务器」而不是「推送」", async () => {
		await mount(true);
		const badge = await screen.findByText("服务器运行中");
		expect([
			badge.className.includes("bg-bn-success-soft"),
			badge.className.includes("bg-bn-danger-soft"),
		]).toEqual([true, false]);
		// 前导圆点跟着同一档色走,不能一个绿一个红。
		expect((badge.firstElementChild as HTMLElement).className).toContain("bg-bn-success");
	});

	it("失联的时候是红的 —— 两态合并后仍然分得开", async () => {
		await mount(false);
		const badge = await screen.findByText("服务器失联");
		expect([
			badge.className.includes("bg-bn-danger-soft"),
			badge.className.includes("bg-bn-success-soft"),
		]).toEqual([true, false]);
		expect((badge.firstElementChild as HTMLElement).className).toContain("bg-bn-danger");
	});
});
