/**
 * 单元测试 — `/api/stats` 路由的缓存口径与错误信封。
 *
 * 这里不测统计数值本身(那是 stats/aggregate 的单测),只钉两条路由层契约:
 *   - 缓存键必须覆盖**响应里所有会变的输入**,否则页面会自我矛盾;
 *   - 取数失败时锐评要给出可读的失败(`{ code, message }`),而不是把异常抛出去;
 *   - 路由与两处锐评都**直接调**注入的取数函数(接线):剪断哪一根都有一条测试红。
 */

// biome-ignore-all lint/suspicious/noExplicitAny: 断言 JSON 响应体,不为测试再造一遍 wire 类型
import { Hono } from "hono";
import { describe, expect, it, vi } from "vite-plus/test";
import { requestErrorHandler } from "../respond-failure.js";
import { createStatsRoute, roastOverviewFetcher } from "../stats.js";
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
			getSubscriptions: () => [{ id: "s1", identity: { sourceKey: "bilibili", externalId: "1" } }],
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
			fansStore: { listSamplesSince: async () => [], findNearestBefore: async () => undefined },
			statsStore: {
				listRecording: async () => {
					if (opts.failOverview) throw new Error("盘挂了");
					return [];
				},
				listPosts: async () => [],
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
		expect(before.rows[0].followers).toBe(100);

		state.fans = 12_345;
		const after = (await (await app.request("/overview?days=7&tz=0")).json()) as any;
		expect(after.rows[0].followers).toBe(12_345);
	});

	it("输入全没变时照常命中缓存 —— 别把缓存改成摆设", async () => {
		const { deps } = makeDeps();
		const listPosts = vi.spyOn(deps.runtime.statsStore, "listPosts");
		const app = createStatsRoute(deps);

		await app.request("/overview?days=7&tz=0");
		await app.request("/overview?days=7&tz=0");
		expect(listPosts).toHaveBeenCalledTimes(1);
	});
});

describe("POST /roast — 取数失败时的错误信封", () => {
	it("取数抛错 → 返回可读的失败(503 unavailable),而不是把异常抛出去", async () => {
		// 取数原本是进程内代理一次 /overview、直接 `.json()` 而不看状态码:/overview 一抛错,回的是纯文本
		// 500,`.json()` 于是 reject 出 SyntaxError,逃出 handler 变成一个没有 body 的裸 500 —— 用户点「生成 AI
		// 锐评」只看到卡片里一行生硬的 `POST /api/stats/roast → 500`。现在直接调取数函数,抛错在
		// `roastOverviewFetcher` 收成 null,生成那头翻成可读的失败。
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

describe("取数抛错 —— 挂进带全局出错处理的父实例后是失败的形状", () => {
	it("/overview 抛错 → 503 + { code, message },原话进错误日志、不回给调用方", async () => {
		const { deps } = makeDeps({ failOverview: true });
		const error = vi.fn();
		(deps.runtime.serviceCtx as unknown as { logger: unknown }).logger = {
			debug() {},
			info() {},
			warn() {},
			error,
		};
		const parent = new Hono();
		parent.onError(requestErrorHandler({ error }));
		parent.route("/api/stats", createStatsRoute(deps));

		const res = await parent.request("/api/stats/overview?days=7&tz=0");

		expect(res.status).toBe(503);
		expect(res.headers.get("content-type")).toContain("application/json");
		const body = (await res.json()) as any;
		expect(body.code).toBe("unavailable");
		expect(JSON.stringify(body)).not.toContain("盘挂了");
		expect(error).toHaveBeenCalledWith("unhandled request error", expect.any(Error));
	});

	it("锐评取数抛错:原话进错误日志,锐评那头只拿到失败(统计数据读取失败)", async () => {
		const { deps } = makeDeps({ failOverview: true });
		const error = vi.fn();
		(deps.runtime.serviceCtx as unknown as { logger: unknown }).logger = {
			debug() {},
			info() {},
			warn() {},
			error,
		};
		const res = await createStatsRoute(deps).request("/roast?days=7", { method: "POST" });

		expect(res.status).toBe(503);
		expect(((await res.json()) as any).message).toContain("统计数据读取失败");
		expect(error).toHaveBeenCalledWith("unhandled request error", expect.any(Error));
	});
});

describe("取数函数是注入的那一个 —— 路由与两处锐评直接调它(接线)", () => {
	/** 回一份空榜的取数函数;每次调用记下它收到的(已校验的)天数与时区偏移。 */
	const makeReader = () =>
		vi.fn(async (days: number, _tzOffsetMin: number) => ({ days, rows: [] }));

	it("GET /overview:天数与时区先在路由层校验(夹到 1..90、±840),再交给取数函数;回的就是它给的", async () => {
		const { deps } = makeDeps();
		const overview = makeReader();
		const app = createStatsRoute(deps, { overview });

		const res = await app.request("/overview?days=999&tz=99999");

		expect(await res.json()).toEqual({ days: 90, rows: [] });
		expect(overview).toHaveBeenCalledTimes(1);
		expect(overview).toHaveBeenCalledWith(90, 0);
	});

	it("手动锐评(榜单与单人)取数走它:收到的是路由校验过的值,路由自己不再另读盘", async () => {
		const { deps } = makeDeps();
		const listPosts = vi.spyOn(deps.runtime.statsStore, "listPosts");
		const overview = makeReader();
		const app = createStatsRoute(deps, { overview });

		const board = await app.request("/roast?days=7&tz=-480", { method: "POST" });
		const solo = await app.request("/roast/s1?days=14&tz=60", { method: "POST" });

		// 空榜:榜单要至少 2 位、单人找不到他的行 —— 都是取到数之后才有的失败,证明确实取了。
		expect(((await board.json()) as any).code).toBe("not_configured");
		expect(((await solo.json()) as any).code).toBe("not_found");
		expect(overview.mock.calls).toEqual([
			[7, -480],
			[14, 60],
		]);
		expect(listPosts).not.toHaveBeenCalled();
	});

	it("定时锐评用的取数(roastOverviewFetcher)包的就是传给它的函数,失败收成 null", async () => {
		const { deps } = makeDeps();
		const overview = makeReader();
		const fetcher = roastOverviewFetcher(overview, deps);
		expect(await fetcher(30, 480)).toEqual({ days: 30, rows: [] });
		expect(overview).toHaveBeenCalledWith(30, 480);

		const failing = roastOverviewFetcher(async () => {
			throw new Error("盘挂了");
		}, deps);
		expect(await failing(30, 480)).toBeNull();
	});
});
