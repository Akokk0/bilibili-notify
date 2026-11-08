// @vitest-environment jsdom
/**
 * 首页健康卡通过真实页面和HTTP边界读取核心、集成、账号与问题快照。
 * 详情失败、生命周期变化和缺失数据都不从登录态或旧模块字段猜测。
 *
 * 这里整页渲染首页,钉的是**接线**:卡片自己按 prop 怎么画由 `overview-plugin-matrix` 管,这条管
 * 「数据从哪来」—— 改回旧来源或遗漏接线时，这里应当报错。
 */

import type {
	AccountsResponse,
	HealthResponse,
	LiveListeningEntry,
	ModuleState,
	ProblemsResponse,
	SourceEntry,
} from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { HEALTH_DETAILS_QUERY_KEY } from "../../hooks/useHealthDetails";
import { i18n } from "../../i18n";

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
import { HISTORY_DAILY_QUERY_KEY } from "../../services/overview";
import {
	DEFAULT_FEATURE_FLAGS,
	makeEmptySubscription,
	type Subscription,
} from "../../types/domain";
import Overview from "../Overview";
import { integrationHealth, runningHealth } from "./support/health";

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

function mockApi(opts: {
	loggedIn: boolean;
	health?: () => Promise<HealthResponse>;
	accounts?: () => Promise<AccountsResponse>;
	sources?: () => Promise<{ sources: SourceEntry[] }>;
	problems?: () => Promise<ProblemsResponse>;
	details: () => Promise<unknown>;
	live?: () => Promise<LiveListeningEntry[]>;
	subscriptions?: () => Promise<Subscription[]>;
	settings?: () => Promise<unknown>;
}) {
	vi.mocked(api.get).mockImplementation(async (path: string) => {
		if (path === "/api/health") return opts.health ? opts.health() : SHORT;
		if (path === "/api/health/details") return opts.details();
		if (path === "/api/sources/bilibili/auth") {
			return {
				state: opts.loggedIn
					? { status: "logged-in", loggedInAt: "2026-10-28T00:00:00.000Z" }
					: { status: "logged-out" },
			};
		}
		if (path === "/api/settings") {
			return opts.settings
				? opts.settings()
				: {
						core: {
							logging: { level: "info", levels: {} },
							defaults: { features: DEFAULT_FEATURE_FLAGS },
						},
					};
		}
		if (path === "/api/subscriptions") return opts.subscriptions ? opts.subscriptions() : [];
		if (path === "/api/targets") return [];
		if (path === "/api/live/listening") return opts.live ? opts.live() : [];
		if (path.startsWith("/api/history/daily")) return { days: [] };
		if (path.startsWith("/api/history")) return { entries: [] };
		if (path === "/api/stats/followers") return { entries: [] };
		if (path === "/api/ext") return { extensions: [] };
		if (path === "/api/sources") return opts.sources ? opts.sources() : { sources: [] };
		if (path === "/api/accounts") return opts.accounts ? opts.accounts() : { accounts: [] };
		if (path === "/api/problems") return opts.problems ? opts.problems() : { problems: [] };
		return null;
	});
}

function renderDashboard() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={["/"]}>
				<Overview />
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
	i18n.set({ locale: "zh-CN", voice: "maid" });
	vi.stubGlobal("__WEB_VERSION__", "0.0.0-test");
	vi.stubGlobal("ResizeObserver", FakeRO);
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("首页各模块的状态读详情口", () => {
	it("系统资源先于系统状态呈现，窄屏和阅读顺序一致", async () => {
		mockApi({ loggedIn: false, details: async () => runningHealth() });
		renderDashboard();
		const health = await screen.findByRole("region", { name: "系统状态" });
		const resources = screen.getByText("系统资源");
		expect(
			resources.compareDocumentPosition(health) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("核心按详情显示五项及数量，不从登录与旧modules推测就绪", async () => {
		mockApi({ loggedIn: false, details: async () => runningHealth({ modules: ALL_ON }) });
		renderDashboard();
		expect(await screen.findByRole("button", { name: "图片 · 未就绪，查看详情" })).toBeTruthy();
		for (const label of ["存储", "订阅", "推送", "AI"])
			expect(screen.getByRole("button", { name: `${label} · 运行中，查看详情` })).toBeTruthy();
		expect(screen.queryByText("接口 · api")).toBeNull();
		expect(screen.getByText("1 条")).toBeTruthy();
		expect(screen.getByText("3 个目标")).toBeTruthy();
	});

	it("开机详情不显示运行格，运行快照回来后再显示五项", async () => {
		const startup = { phase: "starting", progress: null };
		mockApi({ loggedIn: true, details: async () => startup });
		const qc = renderDashboard();
		expect(await screen.findByText("服务正在启动")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "存储 · 运行中，查看详情" })).toBeNull();
		mockApi({ loggedIn: true, details: async () => runningHealth() });
		await qc.invalidateQueries({ queryKey: HEALTH_DETAILS_QUERY_KEY });
		expect(await screen.findByRole("button", { name: "存储 · 运行中，查看详情" })).toBeTruthy();
	});
	it("详情失败不根据登录态或旧缓存宣称就绪", async () => {
		mockApi({
			loggedIn: true,
			details: async () => {
				throw new Error("details 挂了");
			},
		});
		renderDashboard();
		expect(await screen.findByText("主人，运行详情没读到，请再试一次吧。")).toBeTruthy();
		expect(
			within(screen.getByRole("region", { name: "系统状态" })).getByRole("alert"),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "存储 · 运行中，查看详情" })).toBeNull();
	});
	it("每个集成一格，未运行或清单不可读的集成仍可查看", async () => {
		mockApi({
			loggedIn: false,
			details: async () =>
				runningHealth({
					integrations: [
						integrationHealth({ provides: ["subscription", "push"], connectionCount: 2 }),
						integrationHealth({
							key: "broken",
							descriptor: { label: "清单坏了" },
							status: "unreadable",
							light: "red",
							provides: undefined,
						}),
					],
				}),
		});
		renderDashboard();
		expect(await screen.findByRole("button", { name: "测试来源 · 运行中，查看详情" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "清单坏了 · 清单读不出来，查看详情" })).toBeTruthy();
		expect(screen.getByText("2 条推送连接")).toBeTruthy();
	});
	it("摘要失败仍显示运行中，账号按所属来源匹配，详情给出准确入口", async () => {
		mockApi({
			loggedIn: false,
			details: async () =>
				runningHealth({
					integrations: [
						integrationHealth({
							health: { ok: false, code: "unavailable", message: "摘要暂不可读" },
						}),
					],
				}),
			accounts: async () => ({
				accounts: [
					{
						sourceKey: "other",
						state: { status: "logged-in", loggedInAt: "2026-11-05T00:00:00Z" },
						account: { name: "别人的账号" },
					},
					{
						sourceKey: "acme.source",
						state: { status: "logged-in", loggedInAt: "2026-11-05T00:00:00Z" },
						account: { name: "正确账号" },
					},
				],
			}),
			sources: async () => ({
				sources: [
					{
						key: "acme.source",
						status: "running",
						descriptor: { label: "测试来源", supportedFeatures: [] },
						has: { auth: true, liveStatus: false, preview: false },
					},
				],
			}),
		});
		renderDashboard();
		const opener = await screen.findByRole("button", { name: "测试来源 · 运行中，查看详情" });
		await userEvent.click(opener);
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByText("摘要暂不可读")).toBeTruthy();
		expect(within(dialog).getByText("正确账号")).toBeTruthy();
		expect(within(dialog).queryByText("别人的账号")).toBeNull();
		expect(within(dialog).getByRole("link", { name: "账号" }).getAttribute("href")).toBe(
			"/system?account=acme.source#account",
		);
		expect(within(dialog).getByRole("link", { name: "集成设置" }).getAttribute("href")).toBe(
			"/extensions/acme.source",
		);
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(opener);
	});
	it("核心问题只归组，全部问题包含没有当前集成的报告", async () => {
		const core = runningHealth().core;
		mockApi({
			loggedIn: false,
			details: async () =>
				runningHealth({
					core: { ...core, problemCount: 1 },
					problemCount: 3,
					integrations: [integrationHealth({ problemCount: 1, light: "orange" })],
				}),
			problems: async () => ({
				problems: [
					{
						reporter: "core",
						code: "blocked",
						message: "核心任务待处理",
						since: "2026-11-05T00:00:00Z",
					},
					{
						reporter: "acme.source",
						code: "source",
						message: "来源待处理",
						since: "2026-11-05T00:00:00Z",
					},
					{
						reporter: "gone",
						code: "orphan",
						message: "遗留报告仍需处理",
						since: "2026-11-05T00:00:00Z",
					},
				],
			}),
		});
		renderDashboard();
		await userEvent.click(await screen.findByRole("button", { name: "核心问题 1" }));
		let dialog = screen.getByRole("dialog");
		expect(await within(dialog).findByText("核心任务待处理")).toBeTruthy();
		expect(within(dialog).queryByText("来源待处理")).toBeNull();
		expect(within(dialog).queryByText("遗留报告仍需处理")).toBeNull();
		await userEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
		await userEvent.click(screen.getByRole("button", { name: "查看问题 3" }));
		dialog = screen.getByRole("dialog");
		expect(await within(dialog).findByText("遗留报告仍需处理")).toBeTruthy();
		expect(within(dialog).getByText("来源待处理")).toBeTruthy();
		expect(within(dialog).queryByRole("button", { name: /清空/ })).toBeNull();
	});
	it("同身份遗留订阅逐条提供检查入口，不自动合并或删除", async () => {
		mockApi({
			loggedIn: false,
			details: async () =>
				runningHealth({
					identityDuplicates: [
						{
							identity: { sourceKey: "acme.source", externalId: "a/42" },
							name: "同一个人",
							subscriptionIds: ["sub/a", "sub?b"],
						},
					],
				}),
		});
		renderDashboard();
		expect(await screen.findByText("发现 1 组同身份遗留订阅")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "查看" }));
		expect(screen.getByText("同一个人")).toBeTruthy();
		expect(screen.getByRole("link", { name: "sub/a" }).getAttribute("href")).toBe(
			"/subs?open=sub%2Fa",
		);
		expect(screen.getByRole("link", { name: "sub?b" }).getAttribute("href")).toBe(
			"/subs?open=sub%3Fb",
		);
		expect(screen.queryByRole("button", { name: /合并|删除/ })).toBeNull();
	});
	it("默认显示五个集成，超过五个才折叠且可以展开完整列表", async () => {
		mockApi({
			loggedIn: false,
			details: async () =>
				runningHealth({
					integrations: Array.from({ length: 6 }, (_, index) =>
						integrationHealth({ key: `source-${index}`, descriptor: { label: `来源${index}` } }),
					),
				}),
		});
		renderDashboard();
		expect(await screen.findByRole("button", { name: "来源4 · 运行中，查看详情" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "来源5 · 运行中，查看详情" })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "其余 1 个集成" }));
		expect(screen.getByRole("button", { name: "来源5 · 运行中，查看详情" })).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "收起集成" }));
		expect(screen.queryByRole("button", { name: "来源5 · 运行中，查看详情" })).toBeNull();
	});

	it("直播提示依据运行数据，不被单个来源的登录态阻断", async () => {
		mockApi({ loggedIn: false, details: async () => runningHealth() });
		renderDashboard();
		expect(
			await screen.findByText(new RegExp(i18n.t("sourceUi.pages.Dashboard.Dashboard.56").trim())),
		).toBeTruthy();
		expect(screen.queryByText(/尚未登录 B 站/)).toBeNull();
	});
	it("空集成给出拓展管理入口", async () => {
		mockApi({ loggedIn: false, details: async () => runningHealth() });
		renderDashboard();
		expect(await screen.findByRole("link", { name: "查看拓展" })).toHaveProperty(
			"href",
			expect.stringContaining("/extensions"),
		);
	});

	it("问题快照已变化时，空分组给出空态而非空白列表", async () => {
		mockApi({
			loggedIn: false,
			details: async () =>
				runningHealth({ core: { ...runningHealth().core, problemCount: 1 }, problemCount: 1 }),
			problems: async () => ({
				problems: [
					{
						reporter: "other",
						code: "later",
						message: "另一组的问题",
						since: "2026-11-05T00:00:00Z",
					},
				],
			}),
		});
		renderDashboard();
		await userEvent.click(await screen.findByRole("button", { name: "核心问题 1" }));
		expect(
			await within(screen.getByRole("dialog")).findByText(i18n.t("problems.empty")),
		).toBeTruthy();
	});
	it("失联后的重新读取同时探测服务，恢复后立即显示最新状态", async () => {
		let up = false;
		mockApi({
			loggedIn: false,
			health: async () => {
				if (!up) throw new Error("offline");
				return SHORT;
			},
			details: async () => runningHealth(),
		});
		const qc = renderDashboard();
		await waitFor(() => expect(qc.getQueryState(["health"])?.status).toBe("error"));
		expect(screen.getByText("主人，暂时连不上服务，当前状态还不能确认哦。")).toBeTruthy();
		up = true;
		await userEvent.click(screen.getByRole("button", { name: "重新读取" }));
		expect(await screen.findByRole("button", { name: "存储 · 运行中，查看详情" })).toBeTruthy();
	});
	it("运行详情缺少单项时仍保留五项，缺项明确显示未知", async () => {
		mockApi({
			loggedIn: false,
			details: async () => runningHealth({ core: { items: [], problemCount: 0 } }),
		});
		renderDashboard();
		for (const name of ["存储", "订阅", "推送", "图片", "AI"])
			expect(
				await screen.findByRole("button", { name: `${name} · 状态未知，查看详情` }),
			).toBeTruthy();
		expect(screen.queryByText("0 条")).toBeNull();
		expect(screen.queryByText("0 个目标")).toBeNull();
	});

	it.each(["missing", "failed", "expired"] as const)(
		"账号%s时如实显示，不把缺记录或读取失败说成未登录",
		async (mode) => {
			mockApi({
				loggedIn: false,
				details: async () => runningHealth({ integrations: [integrationHealth()] }),
				sources: async () => ({
					sources: [
						{
							key: "acme.source",
							status: "running",
							descriptor: { label: "测试来源", supportedFeatures: [] },
							has: { auth: true, liveStatus: false, preview: false },
						},
					],
				}),
				accounts: async () => {
					if (mode === "failed") throw new Error("accounts unavailable");
					return {
						accounts:
							mode === "missing"
								? []
								: [
										{
											sourceKey: "acme.source",
											state: { status: "expired", message: "认证已过期" },
										},
									],
					};
				},
			});
			renderDashboard();
			await userEvent.click(
				await screen.findByRole("button", { name: "测试来源 · 运行中，查看详情" }),
			);
			const dialog = screen.getByRole("dialog");
			expect(
				await within(dialog).findByText(
					mode === "missing"
						? "账号状态尚未确认"
						: mode === "failed"
							? "账号读取失败"
							: "认证已过期",
				),
			).toBeTruthy();
			expect(within(dialog).queryByText("未登录")).toBeNull();
		},
	);
	it("问题读取失败保留错误，重试后显示真实列表", async () => {
		let failed = true;
		mockApi({
			loggedIn: false,
			details: async () => runningHealth({ problemCount: 1 }),
			problems: async () => {
				if (failed) throw new Error("problems unavailable");
				return {
					problems: [
						{
							reporter: "gone",
							code: "pending",
							message: "重试后的问题",
							since: "2026-11-05T00:00:00Z",
						},
					],
				};
			},
		});
		renderDashboard();
		await userEvent.click(await screen.findByRole("button", { name: "查看问题 1" }));
		const dialog = screen.getByRole("dialog");
		expect(await within(dialog).findByText(i18n.t("problems.failed"))).toBeTruthy();
		expect(within(dialog).queryByText(i18n.t("problems.empty"))).toBeNull();
		failed = false;
		await userEvent.click(within(dialog).getByRole("button", { name: "重试" }));
		expect(await within(dialog).findByText("重试后的问题")).toBeTruthy();
	});
	it("详情缓存刷新失败时不保留旧的运行断言，包括打开的详情", async () => {
		mockApi({
			loggedIn: false,
			details: async () => runningHealth({ integrations: [integrationHealth()] }),
		});
		const qc = renderDashboard();
		await userEvent.click(
			await screen.findByRole("button", { name: "测试来源 · 运行中，查看详情" }),
		);
		mockApi({
			loggedIn: false,
			details: async () => {
				throw new Error("details failed");
			},
		});
		await qc.invalidateQueries({ queryKey: HEALTH_DETAILS_QUERY_KEY });
		expect(await screen.findByText("主人，运行详情没读到，请再试一次吧。")).toBeTruthy();
		expect(within(screen.getByRole("dialog")).getByText("状态待确认")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "测试来源 · 运行中，查看详情" })).toBeNull();
		expect(within(screen.getByRole("dialog")).queryByText("运行中")).toBeNull();
	});
	it("集成离开当前列表后，已开的详情不保留旧状态和操作", async () => {
		mockApi({
			loggedIn: false,
			details: async () => runningHealth({ integrations: [integrationHealth()] }),
		});
		const qc = renderDashboard();
		await userEvent.click(
			await screen.findByRole("button", { name: "测试来源 · 运行中，查看详情" }),
		);
		mockApi({ loggedIn: false, details: async () => runningHealth() });
		await qc.invalidateQueries({ queryKey: HEALTH_DETAILS_QUERY_KEY });
		const dialog = screen.getByRole("dialog");
		expect(await within(dialog).findByText("状态待确认")).toBeTruthy();
		expect(within(dialog).queryByRole("link", { name: "集成设置" })).toBeNull();
	});
	it("已开问题框失联后重试也重新探测服务", async () => {
		let up = true;
		mockApi({
			loggedIn: false,
			health: async () => {
				if (!up) throw new Error("offline");
				return SHORT;
			},
			details: async () => runningHealth({ problemCount: 1 }),
			problems: async () => ({
				problems: [
					{
						reporter: "gone",
						code: "pending",
						message: "服务恢复后的问题",
						since: "2026-11-05T00:00:00Z",
					},
				],
			}),
		});
		const qc = renderDashboard();
		await userEvent.click(await screen.findByRole("button", { name: "查看问题 1" }));
		up = false;
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1000);
		await qc.invalidateQueries({ queryKey: ["health"], exact: true });
		expect(
			await within(screen.getByRole("dialog")).findByText(i18n.t("problems.failed")),
		).toBeTruthy();
		up = true;
		await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "重试" }));
		expect(await within(screen.getByRole("dialog")).findByText("服务恢复后的问题")).toBeTruthy();
	});
});

describe("首页直播读数的未知态", () => {
	it.each(["live", "subscriptions", "settings"] as const)(
		"%s 首次读取失败时不假装空表或出厂值,只给固定未知提示",
		async (input) => {
			const sub = makeEmptySubscription({ sourceKey: "acme.test", externalId: "closed" });
			sub.overrides = { features: { liveStart: false, liveEnd: false } };
			mockApi({
				loggedIn: false,
				details: async () => runningHealth({ modules: ALL_ON }),
				live:
					input === "live"
						? async () => {
								throw new Error("private-test-error");
							}
						: undefined,
				subscriptions: async () => {
					if (input === "subscriptions") throw new Error("private-test-error");
					return [sub];
				},
				settings:
					input === "settings"
						? async () => {
								throw new Error("private-test-error");
							}
						: undefined,
			});
			const qc = renderDashboard();
			try {
				const key = input === "live" ? ["live", "listening"] : [input];
				await waitFor(() => expect(qc.getQueryState(key)?.status).toBe("error"));
				expect(
					await screen.findByText(
						input === "live"
							? "主人，女仆没能读到直播状态，现在还不知道是否有人在播哦。"
							: "主人，女仆没能读全订阅或直播开关，暂时还数不准未开启监听的订阅哦。",
					),
				).toBeTruthy();
				expect(screen.queryByText("private-test-error")).toBeNull();
				expect(screen.queryByRole("link", { name: /没开直播监听/ })).toBeNull();
				if (input === "live") expect(screen.queryByText("● 0 人在播")).toBeNull();
			} finally {
				qc.clear();
			}
		},
	);

	it("设置成功回应缺少默认开关时仍未知,不静默改用出厂值", async () => {
		mockApi({
			loggedIn: false,
			details: async () => runningHealth({ modules: ALL_ON }),
			subscriptions: async () => [
				makeEmptySubscription({ sourceKey: "acme.test", externalId: "one" }),
			],
			settings: async () => ({ core: { logging: { level: "info", levels: {} } } }),
		});
		const qc = renderDashboard();
		try {
			expect(
				await screen.findByText(
					"主人，女仆没能读全订阅或直播开关，暂时还数不准未开启监听的订阅哦。",
				),
			).toBeTruthy();
			expect(qc.getQueryState(["settings"])?.status).toBe("success");
			expect(screen.queryByRole("link", { name: /没开直播监听/ })).toBeNull();
		} finally {
			qc.clear();
		}
	});

	it.each(["pending", "error"] as const)(
		"成功读到空订阅后,settings %s 也明确是空集,提供添加入口而不报未知计数",
		async (status) => {
			mockApi({
				loggedIn: false,
				details: async () => runningHealth({ modules: ALL_ON }),
				settings: () =>
					status === "pending"
						? new Promise<unknown>(() => {})
						: Promise.reject(new Error("only-test-settings-empty")),
			});
			const qc = renderDashboard();
			try {
				await waitFor(() => expect(qc.getQueryState(["settings"])?.status).toBe(status));
				await waitFor(() => expect(qc.getQueryState(["subscriptions"])?.status).toBe("success"));
				const link = await screen.findByRole("link", {
					name: "主人，还没有订阅哦，去订阅页添加吧 →",
				});
				expect(link.getAttribute("href")).toBe("/subs");
				expect(screen.queryByText("主人，女仆正在核对订阅和直播开关，请稍等哦。")).toBeNull();
				expect(
					screen.queryByText("主人，女仆没能读全订阅或直播开关，暂时还数不准未开启监听的订阅哦。"),
				).toBeNull();
				expect(screen.queryByRole("link", { name: /没开直播监听/ })).toBeNull();
				expect(screen.getByText("● 0 人在播")).toBeTruthy();
				expect(screen.getAllByText("正在直播")[0]?.parentElement?.textContent).toBe("正在直播0/ 0");
			} finally {
				qc.clear();
			}
		},
	);

	it.each(["subscriptions", "settings"] as const)(
		"%s 刷新失败后即使留有旧缓存也不报未监听数量,恢复后重新计算",
		async (input) => {
			let failed = false;
			const sub = makeEmptySubscription({ sourceKey: "acme.test", externalId: "closed" });
			mockApi({
				loggedIn: false,
				details: async () => runningHealth({ modules: ALL_ON }),
				subscriptions: async () => {
					if (input === "subscriptions" && failed)
						throw new Error("only-test-subscriptions-failure");
					return [sub];
				},
				settings: async () => {
					if (input === "settings" && failed) throw new Error("only-test-settings-failure");
					return {
						core: {
							logging: { level: "info", levels: {} },
							defaults: {
								features: { ...DEFAULT_FEATURE_FLAGS, liveStart: false, liveEnd: false },
							},
						},
					};
				},
			});
			const qc = renderDashboard();
			try {
				expect(
					await screen.findByRole("link", { name: /有 1 项启用中的订阅没开直播监听/ }),
				).toBeTruthy();
				failed = true;
				await qc.invalidateQueries({ queryKey: [input] });
				await waitFor(() => expect(qc.getQueryState([input])?.status).toBe("error"));
				expect(
					screen.getByText("主人，女仆没能读全订阅或直播开关，暂时还数不准未开启监听的订阅哦。"),
				).toBeTruthy();
				expect(screen.queryByRole("link", { name: /没开直播监听/ })).toBeNull();
				expect(screen.queryByText(/only-test-(subscriptions|settings)-failure/)).toBeNull();
				expect(screen.getAllByText("正在直播")[0]?.parentElement?.textContent).toBe(
					input === "subscriptions" ? "正在直播0/ —" : "正在直播0/ 1",
				);
				failed = false;
				await qc.invalidateQueries({ queryKey: [input] });
				expect(
					await screen.findByRole("link", { name: /有 1 项启用中的订阅没开直播监听/ }),
				).toBeTruthy();
			} finally {
				qc.clear();
			}
		},
	);

	it.each(["subscriptions", "settings"] as const)(
		"%s 未读全时不以空订阅或出厂开关计算未监听数量",
		async (input) => {
			const sub = makeEmptySubscription({ sourceKey: "bilibili", externalId: "closed" });
			sub.overrides = { features: { liveStart: false, liveEnd: false } };
			mockApi({
				loggedIn: false,
				details: async () => runningHealth({ modules: ALL_ON }),
				subscriptions:
					input === "subscriptions"
						? () => new Promise<Subscription[]>(() => {})
						: async () => [sub],
				settings: input === "settings" ? () => new Promise<unknown>(() => {}) : undefined,
			});
			const qc = renderDashboard();
			try {
				await waitFor(() =>
					expect(qc.getQueryState(["live", "listening"])?.status).toBe("success"),
				);
				expect(qc.getQueryState([input])?.status).toBe("pending");
				expect(screen.getByText("主人，女仆正在核对订阅和直播开关，请稍等哦。")).toBeTruthy();
				expect(screen.queryByRole("link", { name: /没开直播|未开启直播/ })).toBeNull();
				expect(screen.getAllByText("正在直播")[0]?.parentElement?.textContent).toBe(
					input === "subscriptions" ? "正在直播0/ —" : "正在直播0/ 1",
				);
			} finally {
				qc.clear();
			}
		},
	);

	it("在播刷新失败后不把旧快照当当前状态,恢复成功才重新显示人数", async () => {
		let failed = false;
		const entry: LiveListeningEntry = {
			subscriptionId: "s-old",
			identity: { sourceKey: "acme.test", externalId: "old" },
			isLive: true,
			title: "上次成功的直播记录",
		};
		mockApi({
			loggedIn: false,
			details: async () => runningHealth({ modules: ALL_ON }),
			live: async () => {
				if (failed) throw new Error("only-test-live-failure");
				return [entry];
			},
		});
		const qc = renderDashboard();
		try {
			expect(await screen.findByText("上次成功的直播记录")).toBeTruthy();
			failed = true;
			await qc.invalidateQueries({ queryKey: ["live", "listening"] });
			await waitFor(() => expect(qc.getQueryState(["live", "listening"])?.status).toBe("error"));
			expect(
				screen.getByText("主人，女仆没能读到直播状态，现在还不知道是否有人在播哦。"),
			).toBeTruthy();
			expect(screen.queryByText("上次成功的直播记录")).toBeNull();
			expect(screen.queryByText("only-test-live-failure")).toBeNull();
			expect(screen.getAllByText("正在直播")[0]?.parentElement?.textContent).toBe("正在直播—/ 0");
			failed = false;
			await qc.invalidateQueries({ queryKey: ["live", "listening"] });
			expect(await screen.findByText("上次成功的直播记录")).toBeTruthy();
			expect(screen.getByText("● 1 人在播")).toBeTruthy();
		} finally {
			qc.clear();
		}
	});

	it("在播请求仍在等待时明确读取中,直播卡与顶部人数都不冒充 0", async () => {
		mockApi({
			loggedIn: false,
			details: async () => runningHealth({ modules: ALL_ON }),
			live: () => new Promise<LiveListeningEntry[]>(() => {}),
		});
		const qc = renderDashboard();
		try {
			await waitFor(() =>
				expect(qc.getQueryState(["live", "listening"])?.fetchStatus).toBe("fetching"),
			);
			expect(qc.getQueryState(["live", "listening"])?.status).toBe("pending");
			expect(screen.getByText("主人，女仆正在读取直播状态，请稍等哦。")).toBeTruthy();
			expect(screen.queryByText("● 0 人在播")).toBeNull();
			// 直播请求仍挂着,分母的0只在订阅读口成功后才成立。
			await waitFor(() => expect(qc.getQueryState(["subscriptions"])?.status).toBe("success"));
			await waitFor(() =>
				expect(screen.getAllByText("正在直播")[0]?.parentElement?.textContent).toBe("正在直播—/ 0"),
			);
		} finally {
			qc.clear();
		}
	});
});

it("overview totals use translated whole sentences and quantity-aware units without changing daily data", async () => {
	mockApi({ loggedIn: false, details: async () => runningHealth() });
	const fallback = vi.mocked(api.get).getMockImplementation();
	let total = 1;
	vi.mocked(api.get).mockImplementation(async (path) => {
		if (path.startsWith("/api/history/daily"))
			return {
				days: [
					{
						d: "2026-11-08",
						total,
						failures: 0,
						counts: {
							post: total,
							liveStart: 0,
							liveStreaming: 0,
							liveEnd: 0,
							membership: 0,
							superchat: 0,
							viewerChat: 0,
							viewerEnter: 0,
						},
					},
				],
			};
		return fallback?.(path);
	});
	i18n.set({ locale: "en", voice: "plain" });
	const qc = renderDashboard();
	expect(await screen.findByText("1 push in the last 7 days")).toBeTruthy();
	expect(screen.getByText("time")).toBeTruthy();
	expect(screen.getByText("times")).toBeTruthy();
	for (const [locale, title, summary] of [
		["ja", "今週の送信推移", "直近7日間の送信回数：1回"],
		["zh-TW", "本週推播趨勢", "最近 7 天共 1 次"],
	] as const) {
		await act(async () => {
			i18n.set({ locale, voice: "plain" });
		});
		expect(screen.getByText(title)).toBeTruthy();
		expect(screen.getByText(summary)).toBeTruthy();
	}
	total = 2;
	await act(async () => {
		i18n.set({ locale: "en", voice: "plain" });
		await qc.invalidateQueries({ queryKey: HISTORY_DAILY_QUERY_KEY });
	});
	expect(await screen.findByText("2 pushes in the last 7 days")).toBeTruthy();
	qc.clear();
});
