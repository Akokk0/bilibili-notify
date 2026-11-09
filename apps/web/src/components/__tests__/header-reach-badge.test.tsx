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
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n";
import { ThemeRoot } from "../theme-root";

const apiGet = vi.hoisted(() => vi.fn(async (_path: string) => null as unknown));

vi.mock("../../services/api", () => ({ api: { get: apiGet } }));

beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
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
		if (path === "/api/subscriptions" || path === "/api/targets") return [];
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
	it.each([
		[
			"ja",
			"ご主人様、バックエンドには接続できていますよ。通知の有効・無効とは別なので、そちらは各購読のルール設定で確認してくださいね。",
			"サーバー稼働中",
		],
		[
			"zh-TW",
			"主人，目前可連線至後端服務喔。這與推播開關無關；是否啟用推播，請查看各訂閱的規則設定。",
			"伺服器執行中",
		],
	] as const)("%s 女仆状态说明仍只代表后端可访问", async (locale, hint, status) => {
		await mount(true);
		const badge = (await screen.findByText("服务器运行中")).closest('[data-bn="badge"]');
		act(() => i18n.set({ locale, voice: "maid" }));
		expect(screen.getByTitle(hint)).toBe(badge);
		expect(screen.getByText(status).closest('[data-bn="badge"]')).toBe(badge);
		expect(badge?.className).toContain("bg-bn-success-soft");
	});

	it("通的时候是绿的,措辞落在「服务器」而不是「推送」", async () => {
		await mount(true);
		const badge = (await screen.findByText("服务器运行中")).closest<HTMLElement>(
			'[data-bn="badge"]',
		);
		if (!badge) throw new Error("Missing reach badge");
		expect([
			badge.className.includes("bg-bn-success-soft"),
			badge.className.includes("bg-bn-danger-soft"),
		]).toEqual([true, false]);
		// 前导圆点跟着同一档色走,不能一个绿一个红。点子本身是库里的 StatusDot,
		// 档位色走 inline style 里的 token(不是 class)—— 断言认那个变量名。
		expect((badge.firstElementChild as HTMLElement).style.background).toContain(
			"--color-bn-success",
		);
		// 皮肤挂点 —— 掉了皮肤就静默够不到这枚徽章(2026-08-23 主人真机指出后补的词表项)。
		expect(badge.getAttribute("data-bn")).toBe("badge");
	});

	it("失联的时候是红的 —— 两态合并后仍然分得开", async () => {
		await mount(false);
		const badge = (await screen.findByText("服务器失联")).closest<HTMLElement>('[data-bn="badge"]');
		if (!badge) throw new Error("Missing reach badge");
		expect([
			badge.className.includes("bg-bn-danger-soft"),
			badge.className.includes("bg-bn-success-soft"),
		]).toEqual([true, false]);
		expect((badge.firstElementChild as HTMLElement).style.background).toContain(
			"--color-bn-danger",
		);
	});
});

it("translates the mounted header without replacing its navigation or status badge", async () => {
	await mount(true);
	const previous = i18n.state();
	const badge = await screen.findByText("服务器运行中");
	const overview = screen.getByRole("link", { name: "概览" });
	try {
		for (const [locale, navLabel, library, status, refresh] of [
			["en", "Overview", "Library", "Server reachable", "Refresh"],
			["ja", "概要", "ライブラリー", "サーバー稼働中", "更新"],
			["zh-TW", "概覽", "資源庫", "伺服器執行中", "重新整理"],
		] as const) {
			await act(async () => {
				i18n.set({ locale, voice: "plain" });
			});
			expect(screen.getByRole("link", { name: navLabel })).toBe(overview);
			expect(screen.getByRole("link", { name: library }).getAttribute("href")).toBe("/library");
			expect(screen.getByText(status)).toBe(badge);
			expect(screen.getByRole("button", { name: refresh })).toBeTruthy();
		}
	} finally {
		await act(async () => {
			i18n.set(previous);
		});
	}
});
