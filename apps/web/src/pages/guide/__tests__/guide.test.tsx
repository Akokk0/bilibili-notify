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
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../../i18n";

const apiGet = vi.hoisted(() => vi.fn(async (_path: string) => null as unknown));
const apiPatch = vi.hoisted(() => vi.fn(async (_p: string, _b?: unknown) => ({})));

vi.mock("../../../services/api", () => ({ api: { get: apiGet, patch: apiPatch } }));

function Location() {
	const location = useLocation();
	return <output aria-label="当前位置">{location.pathname}</output>;
}

async function mount(path: string, accounts?: unknown[]) {
	apiGet.mockImplementation(async (p: string) => {
		if (p === "/api/accounts") {
			return {
				accounts: accounts ?? [
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
	i18n.set({ locale: "zh-CN", voice: "plain" });
	apiGet.mockReset();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("关于页 · 新手指引 section", () => {
	it.each([
		["push", "推播目標", "/targets"],
		["render", "卡片繪製 · 樣式", "/cards"],
		["ai", "智慧女僕", "/ai"],
	] as const)(
		"Taiwanese guide %s names the destination as it appears in navigation",
		async (chapter, name, href) => {
			i18n.set({ locale: "zh-TW", voice: "plain" });
			await mount(`/about/guide/${chapter}`);
			const links = await screen.findAllByRole("link", { name });
			expect(links.every((link) => link.getAttribute("href") === href)).toBe(true);
			expect(apiPatch).not.toHaveBeenCalled();
		},
	);

	it.each([
		["zh-CN", "导览中适用的步骤全绿"],
		["en", "all applicable guide steps are complete"],
		["ja", "該当するガイドのステップが完了します"],
		["zh-TW", "指引中適用的步驟即完成"],
	] as const)(
		"%s does not promise five steps when no source offers sign-in",
		async (locale, completion) => {
			i18n.set({ locale, voice: "plain" });
			await mount("/about/guide/subs", []);
			expect(await screen.findByText("1/4")).toBeTruthy();
			expect(screen.getByText((content) => content.includes(completion))).toBeTruthy();
		},
	);

	it.each([
		["en", "AI is an optional addition to BN:", "AI"],
		["ja", "AIはBNの任意機能です。", "AI"],
		["zh-TW", "AI 是 BN 的選用功能，", "智慧女僕"],
	] as const)(
		"%s translates optional AI guidance without changing the setup link",
		async (locale, opening, link) => {
			i18n.set({ locale, voice: "plain" });
			await mount("/about/guide/ai");
			expect(await screen.findByText((content) => content.startsWith(opening))).toBeTruthy();
			expect(screen.getByRole("link", { name: link }).getAttribute("href")).toBe("/ai");
			expect(screen.getByLabelText("当前位置").textContent).toBe("/about/guide/ai");
			await act(async () => i18n.set({ locale: "zh-CN", voice: "plain" }));
			expect(screen.getByText((content) => content.startsWith("AI 是 BN 的可选增强"))).toBeTruthy();
			expect(screen.getByLabelText("当前位置").textContent).toBe("/about/guide/ai");
		},
	);

	it.each([
		["en", "Enable rendering for your deployment", "Cards"],
		["ja", "デプロイ方法に合わせて有効にする", "カード"],
		["zh-TW", "依部署方式啟用", "卡片繪製 · 樣式"],
	] as const)(
		"%s translates rendering guidance while preserving browser configuration names",
		async (locale, heading, link) => {
			i18n.set({ locale, voice: "plain" });
			await mount("/about/guide/render");
			expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
			expect(screen.getByRole("link", { name: link }).getAttribute("href")).toBe("/cards");
			expect(screen.getByText("BN_CHROME_ENDPOINT")).toBeTruthy();
			expect(screen.getByText("-slim")).toBeTruthy();
		},
	);

	it.each([
		[
			"en",
			"Add subscriptions",
			"Subscriptions",
			"Subscriptions decide which creators BN follows for you.",
		],
		["ja", "購読を追加", "購読", "購読では、BNで確認するクリエイターを選びます。"],
		["zh-TW", "新增訂閱", "訂閱", "訂閱決定 BN 要追蹤哪些創作者。"],
	] as const)(
		"%s switches to translated subscription guidance through the real chapter tab",
		async (locale, tab, link, opening) => {
			i18n.set({ locale, voice: "plain" });
			await mount("/about/guide");
			fireEvent.click(await screen.findByRole("tab", { name: tab }));
			expect(screen.getByLabelText("当前位置").textContent).toBe("/about/guide/subs");
			expect(screen.getByText((content) => content.startsWith(opening))).toBeTruthy();
			expect(screen.getByRole("link", { name: link }).getAttribute("href")).toBe("/subs");
		},
	);

	it.each([
		[
			"en",
			"Route A: QQ official bot (qq-official)",
			"Route B: OneBot client (NapCat)",
			"Channel check",
		],
		[
			"ja",
			"ルートA：QQ公式ボット（qq-official）",
			"ルートB：OneBotクライアント（NapCat）",
			"通知経路の確認",
		],
		[
			"zh-TW",
			"路線 A：QQ 官方機器人（qq-official）",
			"路線 B：OneBot 協定端（NapCat）",
			"通道驗收",
		],
	] as const)(
		"%s keeps both QQ setup routes and executable deployment examples",
		async (locale, official, onebot, check) => {
			i18n.set({ locale, voice: "plain" });
			await mount("/about/guide/push");
			expect(await screen.findByRole("heading", { name: official })).toBeTruthy();
			expect(screen.getByRole("heading", { name: onebot })).toBeTruthy();
			expect(screen.getByRole("heading", { name: check })).toBeTruthy();
			expect(document.querySelector("pre code")?.textContent).toBe(
				'services:\n  napcat:\n    image: mlikiowa/napcat-docker:latest\n    container_name: napcat\n    restart: unless-stopped\n    environment:\n      - NAPCAT_UID=1000\n      - NAPCAT_GID=1000\n    ports:\n      - "6099:6099"   # WebUI\n    volumes:\n      - ./napcat/config:/app/napcat/config\n      - ./napcat/qq:/app/.config/QQ\n',
			);
			expect(screen.getByRole("link", { name: /NapCat/ }).getAttribute("href")).toBe(
				"https://github.com/NapNeko/NapCatQQ",
			);
			expect(
				screen
					.getAllByRole("link")
					.some((link) => link.getAttribute("href") === "/about/guide/subs"),
			).toBe(true);
			expect(screen.getByText("accessToken")).toBeTruthy();
		},
	);

	it.each([
		["en", "Which account appears in the header?", "System → Accounts"],
		["ja", "ヘッダーに表示されるアカウント", "システム → アカウント"],
		["zh-TW", "頂欄顯示哪個帳號？", "系統 → 帳號"],
	] as const)(
		"%s localizes source sign-in instructions and preserves the account destination",
		async (locale, heading, accountLink) => {
			i18n.set({ locale, voice: "plain" });
			await mount("/about/guide/login");
			expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
			expect(screen.getByRole("link", { name: accountLink }).getAttribute("href")).toBe(
				"/system#account",
			);
			expect(screen.getByLabelText("当前位置").textContent).toBe("/about/guide/login");
			expect(await screen.findByText("2/5")).toBeTruthy();
		},
	);

	it.each([
		[
			"en",
			[
				"Overview and options",
				"Source sign-in",
				"Push channels",
				"Add subscriptions",
				"Image rendering",
				"AI features",
			],
			"QQ connection options: choosing a route",
			"Group notifications",
		],
		[
			"ja",
			["概要と選び方", "配信元にログイン", "通知経路", "購読を追加", "画像描画", "AI機能"],
			"QQ接続方式の選び方",
			"グループへの通知",
		],
		[
			"zh-TW",
			["總覽與選擇", "登入來源帳號", "推播通道", "新增訂閱", "圖片繪製", "AI 功能"],
			"QQ 連線方式：如何選擇",
			"群組推播",
		],
	] as const)(
		"%s translates chapter navigation and overview without changing routes or progress",
		async (locale, labels, heading, group) => {
			await mount("/about/guide/nonsense");
			await screen.findByText("2/5");
			await act(async () => i18n.set({ locale, voice: "plain" }));
			expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(labels);
			expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
			expect(screen.getByText(group)).toBeTruthy();
			expect(screen.getByText("2/5")).toBeTruthy();
			expect(screen.getByLabelText("当前位置").textContent).toBe("/about/guide/nonsense");
			expect(screen.getByRole("link", { name: labels[2] }).getAttribute("href")).toBe(
				"/about/guide/push",
			);
			expect(apiPatch).not.toHaveBeenCalled();
		},
	);

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
