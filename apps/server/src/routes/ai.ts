import { CommentaryGenerator } from "@bilibili-notify/ai";
import type { AiTestPushResponse } from "@bilibili-notify/contract";
import { AISettingsSchema, type NotificationPayload } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { z } from "zod";
import { REDACTED_API_KEY } from "./globals.js";
import type { RouteDeps } from "./types.js";

/**
 * 智能女仆的「试一句」。
 *
 * 拿 AI 页**当前草稿**的人格(可能还没保存)当 system prompt,用户递一句话 / 一个问题,
 * 让她回一句 → 真实推到指定的 PushTarget → 顺带把回复文本带回页面,调人格时不必跑去
 * QQ 里翻。与 `/api/cards/test-push`(草稿样式 + 真实推送)同形。
 */
const TestPushRequestSchema = z.object({
	targetId: z.uuid(),
	message: z.string().min(1).max(500),
	/** AI 页的草稿配置 —— 未保存的人格改动就靠它进来。 */
	ai: AISettingsSchema,
});

// AiTestPushResponse 在 @bilibili-notify/contract(web 同源消费)。

export function createAiRoute(deps: RouteDeps): Hono {
	const app = new Hono();

	app.post("/test-push", async (c) => {
		const body = (await c.req.json().catch(() => null)) as unknown;
		const parsed = TestPushRequestSchema.safeParse(body);
		if (!parsed.success) {
			return c.json<AiTestPushResponse>({ ok: false, latencyMs: 0, err: "invalid_request" }, 400);
		}
		const { targetId, message, ai } = parsed.data;

		const engines = deps.runtime.engines;
		if (!engines) {
			return c.json<AiTestPushResponse>(
				{ ok: false, latencyMs: 0, err: "engines not yet attached" },
				503,
			);
		}
		const target = deps.store.getTargets().find((t) => t.id === targetId);
		if (!target) {
			return c.json<AiTestPushResponse>({ ok: false, latencyMs: 0, err: "target not found" }, 404);
		}

		// 用草稿配置**临时**造一个 generator,用完即弃 —— 绝不碰正在跑的 commentary 实例,
		// 否则「试一句」会把未保存的人格泄进真实推送。
		const generator = new CommentaryGenerator({
			serviceCtx: deps.runtime.serviceCtx,
			api: engines.api,
			config: toGeneratorConfig({
				...ai,
				apiKey: resolveDraftApiKey(ai.apiKey, deps.store.getGlobals().defaults.ai.apiKey),
			}),
		});

		let reply: string;
		try {
			const r = await generator.chat(message, `test-push-${targetId}`);
			reply = r.result;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return c.json<AiTestPushResponse>({ ok: false, latencyMs: 0, err: msg }, 500);
		}

		const payload: NotificationPayload = { kind: "text", text: reply };
		const result = await engines.push.sendToTarget(target.id, payload);
		return c.json<AiTestPushResponse>({ ...result, reply });
	});

	return app;
}

/**
 * 草稿里的 apiKey → 真正拿去调 OpenAI 的那把 key。
 *
 * 前端 GET /api/globals 拿到的 apiKey 是 REDACTED 占位(真 key 从不出后端)。用户只要
 * 没动过那一栏,草稿回传的就是占位串本身 —— 原样拿去当 key 必然 401。占位 = 「没改」,
 * 回落到已存的真 key;否则用草稿里的新值(这样还没保存就能先试一把)。
 *
 * 与 `globals.ts` 的 `stripRedactedSecrets` 同一约定,共用同一个哨兵常量 —— 这个
 * magic string 只能有一个定义处。
 */
export function resolveDraftApiKey(draft: string | undefined, stored: string | undefined): string {
	if (draft === REDACTED_API_KEY) return stored ?? "";
	return draft ?? "";
}

/**
 * 草稿 AI 配置 → CommentaryGeneratorConfig。
 *
 * 字段名映射与 `engines.ts` 的 buildAiConfig 一致:schema 用面向用户的 `baseRole` /
 * `extraSystemPrompt`,引擎的 PersonaConfig 用历史命名 `customBase` / `extraPrompt`。
 * preset 固定 `custom` —— 页面上的人格字段就是最终人格,不再二次套内置模板。
 */
export function toGeneratorConfig(ai: z.infer<typeof AISettingsSchema>) {
	return {
		apiKey: ai.apiKey ?? "",
		baseURL: ai.baseUrl ?? "",
		model: ai.model,
		temperature: ai.temperature,
		persona: {
			preset: "custom" as const,
			name: ai.persona.name,
			addressUser: ai.persona.addressUser,
			addressSelf: ai.persona.addressSelf,
			traits: ai.persona.traits,
			catchphrase: ai.persona.catchphrase,
			customBase: ai.persona.baseRole,
			extraPrompt: ai.persona.extraSystemPrompt,
		},
		dynamicPrompt: ai.dynamicPrompt,
		liveSummaryPrompt: ai.liveSummaryPrompt,
		enableConversation: false,
		maxHistory: 6,
		enableThinking: false,
		enableSearch: false,
		enableVision: false,
	};
}
