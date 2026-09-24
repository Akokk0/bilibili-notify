/**
 * temperature 退役:老配置照样装得进来,值直接丢。
 *
 * 退役是因为它一律不再发、走服务商默认 —— Claude Opus 4.7 起的模型与 OpenAI 推理模型
 * 收到它直接 400,DeepSeek 开思考时静默忽略它。想调的主人从「额外请求参数」写。
 *
 * 盘上有三处可能还留着它:当代的实例桶、最老一代的扁平连接字段、per-UP 的 AI 覆盖。
 * 三处所在的 schema 都是裸 `z.object`(未知键 strip),不是 `.strict()` 那种「多一个键
 * 整份拒收」—— 所以字段直接删、不做迁移:老存档照样解析成功,那个键在下次写盘时消失。
 * 这里钉的是两半:**解析成功**(装不进来 = 启动期 throw),且**结果里没有它**。
 */

import { describe, expect, it } from "vite-plus/test";
import { GlobalConfigSchema, makeDefaultGlobalConfig } from "./globals";
import { makeEmptySubscription, SubscriptionSchema } from "./subscriptions";

/** 一份默认 globals 的纯 JSON 副本,拿来就地改成盘上的老形状。 */
function rawGlobals(): { defaults: { ai: Record<string, unknown> } } {
	return JSON.parse(JSON.stringify(makeDefaultGlobalConfig()));
}

describe("temperature 退役 —— 老配置照样装得进来", () => {
	it("实例桶里带着 temperature → 解析成功,桶里没有它,其余字段原样", () => {
		const raw = rawGlobals();
		raw.defaults.ai.activeProfile = "deepseek";
		raw.defaults.ai.providers = {
			deepseek: {
				provider: "deepseek",
				apiKey: "sk-ds",
				model: "deepseek-v4-pro",
				temperature: 1.3,
			},
		};

		const r = GlobalConfigSchema.safeParse(raw);
		expect(r.success).toBe(true);
		const bucket = r.data?.defaults.ai.providers.deepseek;
		expect(bucket).toMatchObject({
			provider: "deepseek",
			apiKey: "sk-ds",
			model: "deepseek-v4-pro",
		});
		expect(bucket && "temperature" in bucket).toBe(false);
	});

	it("最老一代的扁平字段带着 temperature → 解析成功,哪一层都没留下它", () => {
		const raw = rawGlobals();
		delete raw.defaults.ai.providers;
		delete raw.defaults.ai.activeProfile;
		Object.assign(raw.defaults.ai, {
			apiKey: "sk-old",
			baseUrl: "https://api.deepseek.com",
			model: "deepseek-v4-pro",
			temperature: 0.3,
		});

		const r = GlobalConfigSchema.safeParse(raw);
		expect(r.success).toBe(true);
		const ai = r.data?.defaults.ai;
		// 连接字段照旧搬进 custom 桶 —— 退役的只是 temperature 这一格。
		expect(ai?.providers.custom).toMatchObject({ apiKey: "sk-old", model: "deepseek-v4-pro" });
		expect(ai && "temperature" in ai).toBe(false);
		expect(ai?.providers.custom && "temperature" in ai.providers.custom).toBe(false);
	});

	it("per-UP 的 AI 覆盖带着 temperature → 解析成功,覆盖里只剩挑的那份人格", () => {
		const raw = {
			...makeEmptySubscription({ id: "550e8400-e29b-41d4-a716-446655440000", uid: "12345" }),
			overrides: { ai: { preset: "tsundere", temperature: 1.5 } },
		};

		const r = SubscriptionSchema.safeParse(raw);
		expect(r.success).toBe(true);
		expect(r.data?.overrides.ai).toEqual({ preset: "tsundere" });
	});
});
