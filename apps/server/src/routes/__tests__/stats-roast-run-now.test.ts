/**
 * `POST /api/stats/roast/run-now` —— 面板上「试一次」按下去走的路。
 *
 * 它**不是模拟**:调的就是 cron 到点调的那个函数,所以审批关着的时候会真的把周报
 * 发进群里。测试守两件事:
 *   1. 每种结局都如实转述给前端(点了之后总得知道发生了什么);
 *   2. 调度器还没起来时给一句人话,而不是 500 或一片空白。
 */

// biome-ignore-all lint/suspicious/noExplicitAny: 断言 JSON 响应体,不为测试再造一遍 wire 类型
import { describe, expect, it, vi } from "vite-plus/test";
import type { RoastRunOutcome } from "../../runtime/roast-scheduler.js";
import { createStatsRoute } from "../stats.js";
import type { RouteDeps } from "../types.js";

const deps = {
	store: { getSubscriptions: () => [], getGlobals: () => ({ defaults: { ai: {} } }) },
	runtime: { serviceCtx: { logger: { debug() {}, info() {}, warn() {}, error() {} } } },
} as unknown as RouteDeps;

function appWith(outcome: RoastRunOutcome | null) {
	const runBoardNow = vi.fn(async () => outcome as RoastRunOutcome);
	// null = 调度器还没建好(启动早期 / 引擎没起来)。
	const app = createStatsRoute(deps, outcome === null ? {} : { runBoardNow });
	return { app, runBoardNow };
}

const post = (app: ReturnType<typeof createStatsRoute>) =>
	app.request("/roast/run-now", { method: "POST" });

describe("POST /roast/run-now", () => {
	it("发出去了 → 如实带上条数与投递形态", async () => {
		const { app, runBoardNow } = appWith({ kind: "sent", mode: "image", sent: 2, failed: [] });
		const res = await post(app);
		expect(res.status).toBe(200);
		expect((await res.json()) as any).toEqual({
			ok: true,
			outcome: { kind: "sent", mode: "image", sent: 2, failed: [] },
		});
		expect(runBoardNow).toHaveBeenCalledTimes(1);
	});

	it("部分目标失败 → 照样 ok,但失败明细要带出来(不能只报喜)", async () => {
		const { app } = appWith({
			kind: "sent",
			mode: "text",
			sent: 1,
			failed: [{ targetId: "t2", err: "机器人不在群里" }],
		});
		const body = (await (await post(app)).json()) as any;
		expect(body.ok).toBe(true);
		expect(body.outcome.failed).toEqual([{ targetId: "t2", err: "机器人不在群里" }]);
	});

	it("审批开着 → 说清楚在等主人回 y,别让人以为发过了", async () => {
		const { app } = appWith({ kind: "pending-approval", draftId: "a3" });
		const body = (await (await post(app)).json()) as any;
		expect(body.outcome).toEqual({ kind: "pending-approval", draftId: "a3" });
	});

	it("生成失败 → ok:true 但结局是 gen-failed —— HTTP 层没出错,是业务没成", async () => {
		const { app } = appWith({ kind: "gen-failed", why: "AI 还没开" });
		const res = await post(app);
		// 200 + 结构化结局:4xx/5xx 会让前端的 error 分支吞掉原因(锐评卡踩过)。
		expect(res.status).toBe(200);
		expect(((await res.json()) as any).outcome).toEqual({ kind: "gen-failed", why: "AI 还没开" });
	});

	it("没配目标 → no-targets", async () => {
		const { app } = appWith({ kind: "no-targets" });
		expect(((await (await post(app)).json()) as any).outcome).toEqual({ kind: "no-targets" });
	});

	it("调度器还没起来 → 503 + 一句人话,不是 500", async () => {
		const { app } = appWith(null);
		const res = await post(app);
		expect(res.status).toBe(503);
		const body = (await res.json()) as any;
		expect(body.ok).toBe(false);
		expect(String(body.err)).toMatch(/就绪|稍后/);
	});

	it("跑这一轮时抛异常 → 502 + 原因,不把异常漏成未处理拒绝", async () => {
		const runBoardNow = vi.fn(async () => {
			throw new Error("盘挂了");
		});
		const app = createStatsRoute(deps, { runBoardNow });
		const res = await app.request("/roast/run-now", { method: "POST" });
		expect(res.status).toBe(502);
		expect(String(((await res.json()) as any).err)).toContain("盘挂了");
	});
});
