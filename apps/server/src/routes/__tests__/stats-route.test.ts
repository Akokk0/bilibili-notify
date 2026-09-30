/**
 * 单元测试 — `/api/stats` 路由的缓存口径与错误信封。
 *
 * 这里不测统计数值本身(那是 stats/aggregate 的单测),只钉两条路由层契约:
 *   - 缓存键必须覆盖**响应里所有会变的输入**,否则页面会自我矛盾;
 *   - 内部代理调用失败时要给出可读的失败(`{ code, message }`),而不是把异常抛出去;
 *   - 子实例被进程内直接 `request` 时(定时锐评的调度器就是这么取数的),它抛的错也是失败的形状,
 *     不是 Hono 默认处理回的纯文本 500。
 */

// biome-ignore-all lint/suspicious/noExplicitAny: 断言 JSON 响应体,不为测试再造一遍 wire 类型
import { Hono } from "hono";
import { describe, expect, it, vi } from "vite-plus/test";
import { requestErrorHandler } from "../respond-failure.js";
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
			fansPoller: {
				getLastEntries: () => [{ subscriptionId: "s1", uid: "1", current: state.fans }],
			},
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
	it("/overview 抛错 → 返回可读的失败(503 unavailable),而不是把 SyntaxError 抛出去", async () => {
		// 代理调用原本直接 `.json()` 而不看状态码。/overview 一抛错,Hono 默认的
		// onError 回的是纯文本 "Internal Server Error",`.json()` 于是 reject 出
		// SyntaxError,逃出 handler 变成一个没有 body 的裸 500 —— 用户点「生成 AI
		// 锐评」只看到卡片里一行生硬的 `POST /api/stats/roast → 500`。
		const { deps } = makeDeps({ failOverview: true });
		const app = createStatsRoute(deps);

		const res = await app.request("/roast?days=7", { method: "POST" });
		const body = (await res.json()) as any;

		expect(res.status).toBe(503);
		expect(body.code).toBe("unavailable");
		expect(typeof body.message).toBe("string");
		expect(body.message.length).toBeGreaterThan(0);
		// 平铺的 { code, message },没有 ok / err。
		expect(Object.keys(body).sort()).toEqual(["code", "message"]);
	});

	it("单 UP 锐评同样给出可读错误", async () => {
		const { deps } = makeDeps({ failOverview: true });
		const app = createStatsRoute(deps);

		const res = await app.request("/roast/s1?days=7", { method: "POST" });
		const body = (await res.json()) as any;

		expect(res.status).toBe(503);
		expect(body.code).toBe("unavailable");
		// 越过了「这条订阅在不在」那道闸,落在取数失败上 —— 不是被当成查无此人挡回去的。
		expect(body.message).toContain("统计数据读取失败");
	});
});

describe("子实例被进程内直接 request —— 抛错也是失败的形状", () => {
	// 定时锐评的调度器与手动锐评都不经父实例,直接 `request("/overview")`。子实例自己不挂出错处理的话,
	// /overview 抛的错走 Hono 默认处理,回一份纯文本 500 —— 不是 { code, message }。
	it("/overview 抛错 → 503 + { code, message },原话进错误日志、不回给调用方", async () => {
		const { deps } = makeDeps({ failOverview: true });
		const error = vi.fn();
		(deps.runtime.serviceCtx as unknown as { logger: unknown }).logger = {
			debug() {},
			info() {},
			warn() {},
			error,
		};
		const app = createStatsRoute(deps);

		const res = await app.request("/overview?days=7&tz=0");

		expect(res.status).toBe(503);
		expect(res.headers.get("content-type")).toContain("application/json");
		const body = (await res.json()) as any;
		expect(body.code).toBe("unavailable");
		expect(JSON.stringify(body)).not.toContain("盘挂了");
		expect(error).toHaveBeenCalledWith("unhandled request error", expect.any(Error));
	});

	it("挂进带全局出错处理的父实例后,抛错的样子与直接 request 一模一样(子实例自带的 onError 优先,得是同一份)", async () => {
		const { deps } = makeDeps({ failOverview: true });
		const error = vi.fn();
		(deps.runtime.serviceCtx as unknown as { logger: unknown }).logger = {
			debug() {},
			info() {},
			warn() {},
			error,
		};
		const direct = await createStatsRoute(deps).request("/overview?days=7&tz=0");

		const parent = new Hono();
		parent.onError(requestErrorHandler({ error }));
		parent.route("/api/stats", createStatsRoute(deps));
		const mounted = await parent.request("/api/stats/overview?days=7&tz=0");

		expect(mounted.status).toBe(direct.status);
		expect(await mounted.json()).toEqual(await direct.json());
	});
});
