import type { TestResponse } from "@bilibili-notify/contract";
import { fail, issuesFromZod, type NotificationPayload } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { z } from "zod";
import { ENGINES_NOT_READY_MESSAGE, respondFailure } from "./respond-failure.js";
import { testResultOfDelivery } from "./test-result.js";
import type { RouteDeps } from "./types.js";

/**
 * `POST /api/push/test` — drop a known-good payload onto a single PushTarget
 * via the live MultiplexNotificationSink, exercising the same code path as a
 * real-event delivery. Used by the Cards page's "发送测试推送" button and the
 * Targets page's "测试" button.
 *
 * 试一次、回报结果(ADR-0026):投递的结果**照旧回 200**,体是 `Result<{ latencyMs }>`(送达带耗时,
 * 没送达带码和原话,不带假的耗时)。请求本身不成 —— 体不对 400、引擎没起 503、没这个目标 404 ——
 * 是非 2xx 的错误体,经 `respondFailure`。
 */

const TestKindSchema = z.enum(["live", "dyn", "sc", "guard", "text"]);

const TestRequestSchema = z.object({
	targetId: z.uuid(),
	kind: TestKindSchema.default("text"),
	text: z.string().optional(),
});

// TestResponse 在 @bilibili-notify/contract(web 同源消费)。

const KIND_TEXTS: Record<z.infer<typeof TestKindSchema>, string> = {
	live: "[测试推送 · 直播开播] 老番茄 开播了！标题：测试直播",
	dyn: "[测试推送 · 动态] 老番茄 发布了一条测试动态",
	sc: "[测试推送 · SC] ¥30 来自 测试用户 — 主播加油！",
	guard: "[测试推送 · 上舰] 测试用户 成为了舰长！",
	text: "[bilibili-notify] 测试推送已送达 ✓",
};

export function createPushRoute(deps: RouteDeps): Hono {
	const app = new Hono();

	app.post("/test", async (c) => {
		const json = (await c.req.json().catch(() => null)) as unknown;
		const parsed = TestRequestSchema.safeParse(json);
		if (!parsed.success) {
			return respondFailure(
				c,
				fail(
					"invalid",
					`测试推送要带 targetId（uuid），kind 只能是 ${TestKindSchema.options.join(" / ")}`,
					{
						issues: issuesFromZod(parsed.error),
					},
				),
			);
		}

		const { targetId, kind, text } = parsed.data;
		const engines = deps.runtime.engines;
		if (!engines) return respondFailure(c, fail("unavailable", ENGINES_NOT_READY_MESSAGE));

		const target = deps.store.getTargets().find((t) => t.id === targetId);
		if (!target) return respondFailure(c, fail("not_found", "没有这个推送目标"));

		const payload: NotificationPayload = {
			kind: "text",
			text: text ?? KIND_TEXTS[kind],
		};
		// The push.sendToTarget path goes through the same retry / sink lookup
		// engines use, so the test exercises real behaviour.
		const result = await engines.push.sendToTarget(target.id, payload);
		// `DeliveryResult` 还是老形状(`err`,且落盘进历史 / testStatus),只在这个出口翻成线上的。
		return c.json<TestResponse>(testResultOfDelivery(result));
	});

	return app;
}
