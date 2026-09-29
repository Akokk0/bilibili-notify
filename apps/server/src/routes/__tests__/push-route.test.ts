/**
 * `POST /api/push/test` —— 试一次、回报结果。
 *
 * 投递的结果(送达 / 没送达)都回 200,体是 `Result<{ latencyMs }>`;请求本身不成才是非 2xx 的错误体。
 * 这条路由此前没有测试走到,它的旧形状不在守卫的白名单里 —— 这里补上。
 */

import { describe, expect, it, vi } from "vite-plus/test";
import { createPushRoute } from "../push.js";
import type { RouteDeps } from "../types.js";

const TARGET_ID = "33333333-3333-4333-8333-333333333333";

function makeApp(opts: { engines?: boolean; targets?: unknown[]; sendToTarget?: unknown } = {}) {
	const sendToTarget = vi.fn(async () => opts.sendToTarget ?? { ok: true, latencyMs: 7 });
	const app = createPushRoute({
		runtime: { engines: opts.engines === false ? null : { push: { sendToTarget } } },
		store: { getTargets: () => opts.targets ?? [{ id: TARGET_ID }] },
	} as unknown as RouteDeps);
	return { app, sendToTarget };
}

function post(app: ReturnType<typeof makeApp>["app"], body: unknown): Promise<Response> {
	return Promise.resolve(
		app.request("/test", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: typeof body === "string" ? body : JSON.stringify(body),
		}),
	);
}

describe("POST /api/push/test 请求级失败(非 2xx 的错误体)", () => {
	it("体不对 → 400 invalid,逐格原因进 issues", async () => {
		const { app } = makeApp();
		const res = await post(app, { targetId: "not-a-uuid" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string; message: string; issues: unknown[] };
		expect(body.code).toBe("invalid");
		expect(body.message).toContain("targetId");
		expect(body.issues).toEqual([expect.objectContaining({ path: ["targetId"] })]);
	});

	it("体不是 JSON → 同样 400 invalid", async () => {
		const { app } = makeApp();
		const res = await post(app, "{oops");
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "invalid" });
	});

	it("引擎还没起 → 503 unavailable", async () => {
		const { app } = makeApp({ engines: false });
		const res = await post(app, { targetId: TARGET_ID });
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({
			code: "unavailable",
			message: "服务还没准备好，请稍后重试",
		});
	});

	it("没这个目标 → 404 not_found,且不会去发", async () => {
		const { app, sendToTarget } = makeApp({ targets: [] });
		const res = await post(app, { targetId: TARGET_ID });
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ code: "not_found", message: "没有这个推送目标" });
		expect(sendToTarget).not.toHaveBeenCalled();
	});
});

describe("POST /api/push/test 投递的结果(照旧回 200,体是 Result)", () => {
	it("送达 → 200 { ok: true, latencyMs },发的是文字载荷", async () => {
		const { app, sendToTarget } = makeApp({ sendToTarget: { ok: true, latencyMs: 42 } });
		const res = await post(app, { targetId: TARGET_ID, kind: "sc" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, latencyMs: 42 });
		expect(sendToTarget).toHaveBeenCalledWith(TARGET_ID, {
			kind: "text",
			text: expect.stringContaining("SC"),
		});
	});

	it("没送达 → 200 { ok: false, code, message },没有假的 latencyMs", async () => {
		const { app } = makeApp({ sendToTarget: { ok: false, latencyMs: 0, err: "群不存在" } });
		const res = await post(app, { targetId: TARGET_ID });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ ok: false, code: "unavailable", message: "群不存在" });
		expect(body).not.toHaveProperty("latencyMs");
	});

	it("自带的文字优先于 kind 的预设", async () => {
		const { app, sendToTarget } = makeApp();
		await post(app, { targetId: TARGET_ID, text: "你好" });
		expect(sendToTarget).toHaveBeenCalledWith(TARGET_ID, { kind: "text", text: "你好" });
	});
});
