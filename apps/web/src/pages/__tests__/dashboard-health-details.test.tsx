// @vitest-environment jsdom
/**
 * 首页「系统状态 · 各模块」那四个模块(动态 / 直播 / 卡片 / AI)开没开,读的是详情口
 * `/api/health/details` 的 `modules`(ADR-0025 决策 12):短版 `/api/health` 只剩四格,不再带它。
 *
 * 这里整页渲染首页,钉的是**接线**:卡片自己按 prop 怎么画由 `dashboard-plugin-matrix` 管,这条管
 * 「prop 从哪来」—— 把首页改回读短版,或者干脆不传,卡片测试照绿,这里红。
 */

import type { HealthResponse, LiveListeningEntry, ModuleState } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
import {
	DEFAULT_FEATURE_FLAGS,
	makeEmptySubscription,
	type Subscription,
} from "../../types/domain";
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

function mockApi(opts: {
	loggedIn: boolean;
	details: () => Promise<unknown>;
	live?: () => Promise<LiveListeningEntry[]>;
	subscriptions?: () => Promise<Subscription[]>;
	settings?: () => Promise<unknown>;
}) {
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
	i18n.set({ locale: "zh-CN", voice: "maid" });
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

describe("首页直播读数的未知态", () => {
	it.each(["live", "subscriptions", "settings"] as const)(
		"%s 首次读取失败时不假装空表或出厂值,只给固定未知提示",
		async (input) => {
			const sub = makeEmptySubscription({ sourceKey: "acme.test", externalId: "closed" });
			sub.overrides = { features: { liveStart: false, liveEnd: false } };
			mockApi({
				loggedIn: false,
				details: async () => ({ phase: "running", modules: ALL_ON }),
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
			details: async () => ({ phase: "running", modules: ALL_ON }),
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
				details: async () => ({ phase: "running", modules: ALL_ON }),
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
				details: async () => ({ phase: "running", modules: ALL_ON }),
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
				details: async () => ({ phase: "running", modules: ALL_ON }),
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
			details: async () => ({ phase: "running", modules: ALL_ON }),
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
			details: async () => ({ phase: "running", modules: ALL_ON }),
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
