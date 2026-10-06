/**
 * `POST /api/stats/roast/run` —— 面板上「试一次」按下去走的路。
 *
 * 它**不是模拟**:调的就是 cron 到点调的那个函数,所以审批关着的时候会真的把周报
 * 发进群里。测试守两件事:
 *   1. 每种结局都如实转述给前端(点了之后总得知道发生了什么);
 *   2. 调度器还没起来时给一句人话,而不是 500 或一片空白;
 *   3. 这一轮里抛出来的是 bug —— 不回原话(可能带路径),原话进错误日志。
 */

// biome-ignore-all lint/suspicious/noExplicitAny: 断言 JSON 响应体,不为测试再造一遍 wire 类型
import { Hono } from "hono";
import { describe, expect, it, vi } from "vite-plus/test";
import type { RoastRunOutcome } from "../../runtime/roast-scheduler.js";
import { requestErrorHandler, UNHANDLED_ERROR_MESSAGE } from "../respond-failure.js";
import { createStatsRoute } from "../stats.js";
import type { RouteDeps } from "../types.js";

const logger = { debug() {}, info() {}, warn() {}, error: vi.fn() };
const deps = {
	store: { getSubscriptions: () => [], getGlobals: () => ({ defaults: { ai: {} } }) },
	runtime: { serviceCtx: { logger } },
} as unknown as RouteDeps;

function appWith(outcome: RoastRunOutcome | null) {
	const runRoastNow = vi.fn(async (_subscriptionId?: string) => outcome as RoastRunOutcome);
	// null = 调度器还没建好(启动早期 / 引擎没起来)。
	const app = createStatsRoute(deps, outcome === null ? {} : { runRoastNow });
	return { app, runBoardNow: runRoastNow, runRoastNow };
}

const post = (app: ReturnType<typeof createStatsRoute>) =>
	app.request("/roast/run", { method: "POST" });

describe("POST /roast/run", () => {
	it("发出去了 → 如实带上条数与投递形态(200 + { ok: true, outcome })", async () => {
		const { app, runBoardNow } = appWith({
			kind: "sent",
			mode: "image",
			sent: 2,
			skipped: [],
			failed: [],
		});
		const res = await post(app);
		expect(res.status).toBe(200);
		expect((await res.json()) as any).toEqual({
			ok: true,
			outcome: { kind: "sent", mode: "image", sent: 2, skipped: [], failed: [] },
		});
		expect(runBoardNow).toHaveBeenCalledTimes(1);
	});

	it("部分目标失败 → 照样 ok,但失败明细要带出来(不能只报喜)", async () => {
		const { app } = appWith({
			kind: "sent",
			mode: "text",
			sent: 1,
			skipped: [],
			failed: [{ targetId: "t2", message: "机器人不在群里" }],
		});
		const body = (await (await post(app)).json()) as any;
		expect(body.ok).toBe(true);
		expect(body.outcome.failed).toEqual([{ targetId: "t2", message: "机器人不在群里" }]);
	});

	it("审批开着 → 说清楚在等主人回 y,别让人以为发过了", async () => {
		const { app } = appWith({ kind: "pending-approval", draftId: "a3" });
		const body = (await (await post(app)).json()) as any;
		expect(body.outcome).toEqual({ kind: "pending-approval", draftId: "a3" });
	});

	it("生成失败 → ok:true 但结局是 gen-failed —— HTTP 层没出错,是业务没成", async () => {
		const { app } = appWith({ kind: "gen-failed", code: "not_configured", message: "AI 还没开" });
		const res = await post(app);
		// 200 + 结构化结局:4xx/5xx 会让前端的 error 分支吞掉原因(锐评卡踩过)。
		expect(res.status).toBe(200);
		expect(((await res.json()) as any).outcome).toEqual({
			kind: "gen-failed",
			code: "not_configured",
			message: "AI 还没开",
		});
	});

	it("没配目标 → no-targets", async () => {
		const { app } = appWith({ kind: "no-targets" });
		expect(((await (await post(app)).json()) as any).outcome).toEqual({ kind: "no-targets" });
	});

	it("调度器还没起来 → 503 unavailable + 一句人话,不是 500", async () => {
		const { app } = appWith(null);
		const res = await post(app);
		expect(res.status).toBe(503);
		const body = (await res.json()) as any;
		expect(body.code).toBe("unavailable");
		expect(String(body.message)).toMatch(/准备好|稍后/);
		// 错误体是平铺的 { code, message },没有 ok / err。
		expect(Object.keys(body).sort()).toEqual(["code", "message"]);
	});

	it("跑这一轮时抛异常是 bug → 503 + 固定一句话;原话进错误日志,不回给面板(可能带路径)", async () => {
		logger.error.mockClear();
		const boom = new Error("EACCES: permission denied, open 'state/roast-drafts.json'");
		const runRoastNow = vi.fn(async () => {
			throw boom;
		});
		// 抛错交给全局出错处理(统计子路由自己不再挂一份):照 app.ts 的样子挂进带它的父实例再请求。
		const app = new Hono();
		app.onError(requestErrorHandler(logger));
		app.route("/api/stats", createStatsRoute(deps, { runRoastNow }));
		const res = await app.request("/api/stats/roast/run", { method: "POST" });
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ code: "unavailable", message: UNHANDLED_ERROR_MESSAGE });
		expect(logger.error).toHaveBeenCalledWith("unhandled request error", boom);
	});
});

describe("POST /roast/run/:subscriptionId — 单人那条", () => {
	it("带上订阅 id → 跑的是这条订阅的那条排程,不是榜单(两支订阅都按订阅 id,ADR-0020 决策 18)", async () => {
		const { app, runRoastNow } = appWith({
			kind: "sent",
			mode: "text",
			sent: 1,
			skipped: [],
			failed: [],
		});
		const id = "e0000000-0000-4000-8000-000000000001";
		const res = await app.request(`/roast/run/${encodeURIComponent(id)}`, { method: "POST" });
		expect(res.status).toBe(200);
		// 传错(或压根没传)订阅 id 的话,主人点「试一次」会收到一份全站榜单 —— 完全
		// 不是他要试的东西,而且真发进群。
		expect(runRoastNow).toHaveBeenCalledWith(id);
	});

	it("不带订阅 id → 跑榜单那条", async () => {
		const { app, runRoastNow } = appWith({
			kind: "sent",
			mode: "text",
			sent: 1,
			skipped: [],
			failed: [],
		});
		await app.request("/roast/run", { method: "POST" });
		expect(runRoastNow).toHaveBeenCalledWith(undefined);
	});
});
