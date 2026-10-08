/**
 * `POST /api/targets/:id/test` —— 试一次、回报结果(目标 id 在路径里,ADR-0036;此前在 push 路由的请求体里,叫 `targetId`)。
 *
 * 投递的结果(送达 / 没送达)都回 200,体是 `Result<{ latencyMs }>`;请求本身不成才是非 2xx 的错误体。
 * 这条路由此前没有测试走到,它的旧形状不在守卫的白名单里 —— 这里补上。
 */

import { fail } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { createTargetsRoute } from "../targets.js";
import type { RouteDeps } from "../types.js";

const TARGET_ID = "33333333-3333-4333-8333-333333333333";

function makeApp(opts: { engines?: boolean; targets?: unknown[]; sendToTarget?: unknown } = {}) {
	const sendToTarget = vi.fn(async () => opts.sendToTarget ?? { ok: true, latencyMs: 7 });
	const app = createTargetsRoute({
		runtime: {
			engines: opts.engines === false ? null : { push: { sendToTarget } },
			serviceCtx: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
		},
		store: { getTargets: () => opts.targets ?? [{ id: TARGET_ID }] },
	} as unknown as RouteDeps);
	return { app, sendToTarget };
}

/** 打 `POST /:id/test`。`body` 缺省就是整个体都不带。 */
function post(
	app: ReturnType<typeof makeApp>["app"],
	body?: unknown,
	id: string = TARGET_ID,
): Promise<Response> {
	return Promise.resolve(
		app.request(`/${id}/test`, {
			method: "POST",
			...(body === undefined
				? {}
				: {
						headers: { "content-type": "application/json" },
						body: typeof body === "string" ? body : JSON.stringify(body),
					}),
		}),
	);
}

describe("POST /api/targets/:id/test 请求级失败(非 2xx 的错误体)", () => {
	it("体不对 → 400 invalid,逐格原因进 issues,不会去发", async () => {
		const { app, sendToTarget } = makeApp();
		const res = await post(app, { kind: "nope" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string; message: string; issues: unknown[] };
		expect(body.code).toBe("invalid");
		expect(body.message).toContain("kind");
		expect(body.issues).toEqual([expect.objectContaining({ path: ["kind"] })]);
		expect(sendToTarget).not.toHaveBeenCalled();
	});

	it("路径里的 id 不是 uuid → 400 invalid(与从前体里的 targetId 同一道),不会去发", async () => {
		const { app, sendToTarget } = makeApp();
		const res = await post(app, {}, "not-a-uuid");
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "invalid" });
		expect(sendToTarget).not.toHaveBeenCalled();
	});

	it("体不是 JSON → 同样 400 invalid", async () => {
		const { app } = makeApp();
		const res = await post(app, "{oops");
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "invalid" });
	});

	it("引擎还没起 → 503 unavailable", async () => {
		const { app } = makeApp({ engines: false });
		const res = await post(app);
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({
			code: "unavailable",
			message: "服务还没准备好，请稍后重试",
		});
	});

	it("没这个目标 → 404 not_found,且不会去发", async () => {
		const { app, sendToTarget } = makeApp({ targets: [] });
		const res = await post(app);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ code: "not_found", message: "没有这个推送目标" });
		expect(sendToTarget).not.toHaveBeenCalled();
	});
});

describe("POST /api/targets/:id/test 投递的结果(照旧回 200,体是 Result)", () => {
	it("送达 → 200 { ok: true, latencyMs },发的是文字载荷", async () => {
		const { app, sendToTarget } = makeApp({ sendToTarget: { ok: true, latencyMs: 42 } });
		const res = await post(app, { kind: "superchat" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, latencyMs: 42 });
		expect(sendToTarget).toHaveBeenCalledWith(TARGET_ID, {
			kind: "text",
			text: expect.stringContaining("SC"),
		});
	});

	it("没送达 → 200 { ok: false, code, message },没有假的 latencyMs", async () => {
		const { app } = makeApp({ sendToTarget: fail("unavailable", "群不存在") });
		const res = await post(app);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ ok: false, code: "unavailable", message: "群不存在" });
		expect(body).not.toHaveProperty("latencyMs");
	});

	it("kind 用特性键:liveStart / post / superchat / membership 各发各的样板句", async () => {
		const expected = {
			liveStart: "直播开播",
			post: "动态",
			superchat: "SC",
			membership: "上舰",
		} as const;
		for (const [kind, word] of Object.entries(expected)) {
			const { app, sendToTarget } = makeApp();
			const res = await post(app, { kind });
			expect(res.status, kind).toBe(200);
			expect(sendToTarget, kind).toHaveBeenCalledWith(TARGET_ID, {
				kind: "text",
				text: expect.stringContaining(word),
			});
		}
	});

	it("老的种类名(live / dyn / sc / guard)不再收 → 400 invalid,不会去发", async () => {
		for (const kind of ["live", "dyn", "sc", "guard"]) {
			const { app, sendToTarget } = makeApp();
			const res = await post(app, { kind });
			expect(res.status, kind).toBe(400);
			expect(await res.json(), kind).toMatchObject({ code: "invalid" });
			expect(sendToTarget, kind).not.toHaveBeenCalled();
		}
	});

	it("整个体都不带 → 按缺省的 text 种类发,不是 400", async () => {
		const { app, sendToTarget } = makeApp();
		const res = await post(app);
		expect(res.status).toBe(200);
		expect(sendToTarget).toHaveBeenCalledWith(TARGET_ID, {
			kind: "text",
			text: "[bilibili-notify] 测试推送已送达 ✓",
		});
	});

	it("请求体里多带的 targetId 不再有人认:要测的是路径里那个", async () => {
		const { app, sendToTarget } = makeApp();
		await post(app, { targetId: "44444444-4444-4444-8444-444444444444" });
		expect(sendToTarget).toHaveBeenCalledWith(TARGET_ID, expect.anything());
	});

	it("自带的文字优先于 kind 的预设", async () => {
		const { app, sendToTarget } = makeApp();
		await post(app, { text: "你好" });
		expect(sendToTarget).toHaveBeenCalledWith(TARGET_ID, { kind: "text", text: "你好" });
	});
});
