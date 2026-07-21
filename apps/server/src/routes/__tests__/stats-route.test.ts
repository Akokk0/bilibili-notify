/**
 * 单元测试 — `/api/stats` 路由的缓存口径与错误信封。
 *
 * 这里不测统计数值本身(那是 stats/aggregate 的单测),只钉两条路由层契约:
 *   - 缓存键必须覆盖**响应里所有会变的输入**,否则页面会自我矛盾;
 *   - 内部代理调用失败时要给出可读的 `{ok:false, err}`,而不是把异常抛出去。
 */

// biome-ignore-all lint/suspicious/noExplicitAny: 断言 JSON 响应体,不为测试再造一遍 wire 类型
import { describe, expect, it, vi } from "vite-plus/test";
import { createStatsRoute } from "../stats.js";
import type { RouteDeps } from "../types.js";

interface StubOpts {
	/** 当前在播的 uid 集合,可在两次请求之间改。 */
	liveUids?: string[];
	/** 让 /overview 内部抛错,用来验错误信封。 */
	failOverview?: boolean;
	aiEnabled?: boolean;
}

function makeDeps(opts: StubOpts = {}) {
	const state = { liveUids: opts.liveUids ?? [], fans: 100 };
	const deps = {
		store: {
			getSubscriptions: () => [{ id: "s1", uid: "1" }],
			getGlobals: () => ({ defaults: { ai: { enabled: opts.aiEnabled ?? true } } }),
		},
		runtime: {
			engines: {
				api: {},
				listLiveRooms: () => state.liveUids.map((uid) => ({ uid, isLive: true })),
			},
			fansPoller: { getLastEntries: () => [{ uid: "1", current: state.fans }] },
			fansStore: { listSamplesSince: async () => [] },
			statsStore: {
				recordingSince: async () => {
					if (opts.failOverview) throw new Error("盘挂了");
					return "1970-01-01T00:00:00.000Z";
				},
				listDynamics: async () => [],
				listLiveSessions: async () => [],
			},
			subRuntimeStore: { get: () => undefined },
			serviceCtx: { logger: { debug() {}, info() {}, warn() {}, error() {} } },
		},
	} as unknown as RouteDeps;
	return { deps, state };
}

describe("GET /overview — 缓存键覆盖所有会变的输入", () => {
	it("在播状态翻转后立刻反映,不吃 30s 缓存", async () => {
		// 缓存键原本只有 days:tz:订阅集合,而响应体里还嵌着引擎的在播状态。于是 UP
		// 一开播,统计页最长 30 秒仍报 live:false —— 同一个页面的「正在直播」面板走
		// WS 实时喂,早就亮了。用户点刷新也没用,两块面板就那样互相打脸。
		const { deps, state } = makeDeps({ liveUids: [] });
		const app = createStatsRoute(deps);

		const before = (await (await app.request("/overview?days=7&tz=0")).json()) as any;
		expect(before.rows[0].live).toBe(false);

		state.liveUids = ["1"];
		const after = (await (await app.request("/overview?days=7&tz=0")).json()) as any;
		expect(after.rows[0].live).toBe(true);
	});

	it("粉丝快照变化后也立刻反映", async () => {
		const { deps, state } = makeDeps();
		const app = createStatsRoute(deps);

		const before = (await (await app.request("/overview?days=7&tz=0")).json()) as any;
		expect(before.rows[0].fans).toBe(100);

		state.fans = 12_345;
		const after = (await (await app.request("/overview?days=7&tz=0")).json()) as any;
		expect(after.rows[0].fans).toBe(12_345);
	});

	it("输入全没变时照常命中缓存 —— 别把缓存改成摆设", async () => {
		const { deps } = makeDeps();
		const listDynamics = vi.spyOn(deps.runtime.statsStore, "listDynamics");
		const app = createStatsRoute(deps);

		await app.request("/overview?days=7&tz=0");
		await app.request("/overview?days=7&tz=0");
		expect(listDynamics).toHaveBeenCalledTimes(1);
	});
});

describe("POST /roast — 内部代理失败时的错误信封", () => {
	it("/overview 抛错 → 返回可读的 ok:false,而不是把 SyntaxError 抛出去", async () => {
		// 代理调用原本直接 `.json()` 而不看状态码。/overview 一抛错,Hono 默认的
		// onError 回的是纯文本 "Internal Server Error",`.json()` 于是 reject 出
		// SyntaxError,逃出 handler 变成一个没有 body 的裸 500 —— 用户点「生成 AI
		// 锐评」只看到卡片里一行生硬的 `POST /api/stats/roast → 500`。
		const { deps } = makeDeps({ failOverview: true });
		const app = createStatsRoute(deps);

		const res = await app.request("/roast?days=7", { method: "POST" });
		const body = (await res.json()) as any;

		expect(body.ok).toBe(false);
		expect(typeof body.err).toBe("string");
		expect(body.err.length).toBeGreaterThan(0);
	});

	it("单 UP 锐评同样给出可读错误", async () => {
		const { deps } = makeDeps({ failOverview: true });
		const app = createStatsRoute(deps);

		const res = await app.request("/roast/1?days=7", { method: "POST" });
		const body = (await res.json()) as any;

		expect(body.ok).toBe(false);
		expect(typeof body.err).toBe("string");
	});
});
