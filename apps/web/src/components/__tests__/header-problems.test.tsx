// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n";
import { GlassHeader } from "../header";

const get = vi.hoisted(() => vi.fn());
vi.mock("../../services/api", () => ({ api: { get } }));
beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
	get.mockImplementation(async (path: string) =>
		path === "/api/health"
			? { status: "ok", version: "dev", uptime: 1 }
			: path === "/api/problems"
				? {
						problems: [
							{
								reporter: "missing.source",
								code: "unknown_code",
								message: "<script>原文</script>",
								since: "2026-11-02T00:00:00Z",
								about: { subscriptionId: "gone-sub" },
							},
						],
					}
				: path === "/api/sources"
					? { sources: [] }
					: path === "/api/adapters"
						? { adapters: [] }
						: path === "/api/ext"
							? { extensions: [] }
							: [],
	);
});
afterEach(cleanup);
function mount(entry = "/") {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={[entry]}>
				<GlassHeader />
			</MemoryRouter>
		</QueryClientProvider>,
	);
	return qc;
}
it.each([
	[
		"ja",
		"ご主人様、送信処理のエラーは右上に残ります。エラーを閉じても、ここにある問題は解消されませんよ。",
		"送信処理のエラーは右上に別途表示されます。エラーを閉じても、ここにある問題は解消されません。",
	],
	[
		"zh-TW",
		"主人，推播流程的錯誤會留在右上角；關閉錯誤紀錄不會清除這裡的問題喔。",
		"推播流程的錯誤會另外保留在右上角；關閉錯誤不會清除這裡的問題。",
	],
] as const)(
	"%s maid problem explanation preserves original report and never clears or refetches it",
	async (locale, maid, plain) => {
		const requestsBefore = get.mock.calls.filter(([path]) => path === "/api/problems").length;
		mount();
		await userEvent.click(await screen.findByRole("button", { name: "待处理问题 1" }));
		const panel = screen.getByRole("dialog");
		const original = screen.getByText("<script>原文</script>");
		for (const [voice, expected] of [
			["maid", maid],
			["plain", plain],
		] as const) {
			act(() => i18n.set({ locale, voice }));
			expect(screen.getByRole("dialog")).toBe(panel);
			expect(within(panel).getByText(expected)).toBeTruthy();
			expect(screen.getByText("<script>原文</script>")).toBe(original);
			expect(screen.getByText("missing.source")).toBeTruthy();
		}
		expect(get.mock.calls.filter(([path]) => path === "/api/problems")).toHaveLength(
			requestsBefore + 1,
		);
	},
);

it("顶栏展示持续问题与安全原文，未知归属保留id且无清除入口", async () => {
	mount();
	await userEvent.click(await screen.findByRole("button", { name: "待处理问题 1" }));
	expect(await screen.findByText("<script>原文</script>")).toBeTruthy();
	expect(screen.getByText("missing.source")).toBeTruthy();
	expect(screen.getByText("gone-sub")).toBeTruthy();
	expect(screen.queryByRole("button", { name: "全部清除" })).toBeNull();
	expect(screen.getByRole("link", { name: "查看日志" }).getAttribute("href")).toBe("/logs");
});
it("读取失败时不把旧问题当现状，重试成功空表后才显示暂无问题", async () => {
	const qc = mount();
	await userEvent.click(await screen.findByRole("button", { name: "待处理问题 1" }));
	get.mockImplementation(async (path: string) => {
		if (path === "/api/problems") throw new Error("private reason");
		return [];
	});
	await qc.invalidateQueries({ queryKey: ["problems"] });
	expect(await screen.findByText("问题列表读取失败或后端失联，当前状态未知。")).toBeTruthy();
	expect(screen.queryByText("<script>原文</script>")).toBeNull();
	expect(screen.queryByText("private reason")).toBeNull();
	get.mockResolvedValue({ problems: [] });
	await userEvent.click(screen.getByRole("button", { name: "重试" }));
	expect(await screen.findByRole("button", { name: "暂无待处理问题" })).toBeTruthy();
	qc.clear();
});

it("直接打开问题深链接时也按阅读宽度定位", async () => {
	mount("/#problems");
	const panel = await screen.findByRole("dialog", { name: "待处理问题" });
	expect(panel.style.width).toBe("440px");
});

it("待处理问题与服务器状态、主题和刷新位于同一操作区", async () => {
	mount();
	const actions = screen.getByRole("group", { name: "顶栏操作" });
	expect(await within(actions).findByRole("button", { name: "待处理问题 1" })).toBeTruthy();
	expect(within(actions).getByText("服务器运行中")).toBeTruthy();
	expect(within(actions).getByRole("button", { name: /主题/ })).toBeTruthy();
	expect(within(actions).getByRole("button", { name: "刷新" })).toBeTruthy();
});

it("compact problem and theme triggers retain their full names and decorative icons", async () => {
	mount();
	const problem = await screen.findByRole("button", { name: "待处理问题 1" });
	expect(problem.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
	expect(problem.title).toBe("待处理问题 1");
	expect(
		screen.getByRole("button", { name: /主题/ }).querySelector('svg[aria-hidden="true"]'),
	).not.toBeNull();
});

it("账号放在标题下方，按聚合首项显示，未登录不借后续账号资料", async () => {
	const fallback = get.getMockImplementation();
	get.mockImplementation(async (path: string) =>
		path === "/api/accounts"
			? {
					accounts: [
						{
							sourceKey: "library",
							state: { status: "logged-out" },
							account: { name: "旧资料", avatar: `${"a".repeat(64)}.png` },
						},
						{
							sourceKey: "later",
							state: { status: "logged-in", loggedInAt: "2026-11-05T00:00:00Z" },
							account: { name: "后面的账号" },
						},
					],
				}
			: path === "/api/sources"
				? {
						sources: [
							{
								key: "library",
								descriptor: { label: "书库", shortLabel: "书", color: "#888", icon: "globe" },
								has: { auth: true },
								status: "running",
							},
						],
					}
				: fallback?.(path),
	);
	mount();
	const trigger = await screen.findByRole("button", { name: "来源账号：书库 · 未登录" });
	expect(trigger.closest(".bn-header-brand")).not.toBeNull();
	expect(trigger.closest("fieldset")).toBeNull();
	expect(trigger.querySelector("img")).toBeNull();
	expect(screen.queryByText("旧资料")).toBeNull();
	expect(screen.queryByText("后面的账号")).toBeNull();
	await userEvent.click(trigger);
	expect(await screen.findByRole("menuitem", { name: "查看书库账号" })).toBeTruthy();
	expect(screen.getByRole("menuitem", { name: "管理账号与顺序" })).toBeTruthy();
});

it("顶栏刷新会重读账号聚合，读取失败不继续显示旧资料", async () => {
	const fallback = get.getMockImplementation();
	let offline = false;
	get.mockImplementation(async (path: string) => {
		if (path === "/api/accounts") {
			if (offline) throw Error("temporary offline");
			return {
				accounts: [
					{
						sourceKey: "library",
						state: { status: "logged-in", loggedInAt: "2026-11-05T00:00:00Z" },
						account: { name: "北窗" },
					},
				],
			};
		}
		return fallback?.(path);
	});
	mount();
	await screen.findByRole("button", { name: "来源账号：北窗" });
	offline = true;
	await userEvent.click(screen.getByRole("button", { name: "刷新" }));
	expect(await screen.findByRole("button", { name: "来源账号：账号读取失败" })).toBeTruthy();
	expect(screen.queryByText("北窗")).toBeNull();
});

it.each([
	["en", "Issues", "Close issues", "Source account: 北窗", "Manage accounts and order"],
	[
		"ja",
		"対応が必要な問題",
		"問題パネルを閉じる",
		"ソースアカウント：北窗",
		"アカウントと順序を管理",
	],
	["zh-TW", "待處理問題", "關閉問題視窗", "來源帳號：北窗", "管理帳號與順序"],
] as const)(
	"%s redraws open issues and account controls without rewriting received content",
	async (locale, title, close, account, manage) => {
		const fallback = get.getMockImplementation();
		get.mockImplementation(async (path: string) =>
			path === "/api/accounts"
				? {
						accounts: [
							{
								sourceKey: "library",
								state: { status: "logged-in", loggedInAt: "2026-11-05T00:00:00Z" },
								account: { name: "北窗" },
							},
						],
					}
				: fallback?.(path),
		);
		const qc = mount();
		await userEvent.click(await screen.findByRole("button", { name: "待处理问题 1" }));
		const raw = await screen.findByText("<script>原文</script>");
		await act(async () => {
			i18n.set({ locale, voice: "plain" });
		});
		expect(screen.getByRole("dialog", { name: title })).toBeTruthy();
		expect(screen.getByText("<script>原文</script>")).toBe(raw);
		expect(screen.getByText("gone-sub")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: close }));
		await userEvent.click(screen.getByRole("button", { name: account }));
		expect(screen.getByRole("menuitem", { name: manage })).toBeTruthy();
		expect(screen.getAllByText("北窗").length).toBeGreaterThan(0);
		qc.clear();
	},
);
