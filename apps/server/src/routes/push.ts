import type { NotificationPayload } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { z } from "zod";
import type { RouteDeps } from "./types.js";

/**
 * `POST /api/push/test` — drop a known-good payload onto a single PushTarget
 * via the live MultiplexNotificationSink, exercising the same code path as a
 * real-event delivery. Used by the Cards page's "发送测试推送" button and the
 * Targets page's "测试" button.
 */

const TestKindSchema = z.enum(["live", "dyn", "sc", "guard", "text"]);

const TestRequestSchema = z.object({
	targetId: z.uuid(),
	kind: TestKindSchema.default("text"),
	text: z.string().optional(),
});

export interface TestResponse {
	ok: boolean;
	latencyMs: number;
	err?: string;
}

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
			return c.json({ ok: false, error: "invalid_request", issues: parsed.error.issues }, 400);
		}

		const { targetId, kind, text } = parsed.data;
		const engines = deps.runtime.engines;
		if (!engines) {
			return c.json<TestResponse>(
				{ ok: false, latencyMs: 0, err: "engines not yet attached" },
				503,
			);
		}

		const target = deps.store.getTargets().find((t) => t.id === targetId);
		if (!target)
			return c.json<TestResponse>({ ok: false, latencyMs: 0, err: "target not found" }, 404);

		const payload: NotificationPayload = {
			kind: "text",
			text: text ?? KIND_TEXTS[kind],
		};
		// The push.sendToTarget path goes through the same retry / sink lookup
		// engines use, so the test exercises real behaviour.
		const result = await engines.push.sendToTarget(target.id, payload);
		return c.json<TestResponse>(result);
	});

	return app;
}
