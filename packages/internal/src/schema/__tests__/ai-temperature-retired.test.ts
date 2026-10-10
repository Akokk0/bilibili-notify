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
 *
 * 最老一代的扁平连接字段现在由迁移器搬进 `providers.custom`(`apps/server/src/migration/ai.ts`),
 * 迁移器刻意把 `temperature` 留在 ai 这一层、由 schema 剥掉;那一条连同迁移一起在服务端的
 * `migration/__tests__/settings.test.ts`,这里只留活 schema 直接读到的两处。
 */

import { describe, expect, it } from "vite-plus/test";
import { GlobalConfigSchema, makeDefaultGlobalConfig } from "../globals";
import { makeEmptySubscription, SubscriptionSchema } from "../subscriptions";

/** 一份默认 globals 的纯 JSON 副本,拿来就地改成盘上的老形状。 */
function rawGlobals(): { ai: Record<string, unknown> } {
	return JSON.parse(JSON.stringify(makeDefaultGlobalConfig()));
}

describe("temperature 退役 —— 老配置照样装得进来", () => {
	it("实例桶里带着 temperature → 解析成功,桶里没有它,其余字段原样", () => {
		const raw = rawGlobals();
		raw.ai.activeProfile = "deepseek";
		raw.ai.providers = {
			deepseek: {
				provider: "deepseek",
				apiKey: "sk-ds",
				model: "deepseek-v4-pro",
				temperature: 1.3,
			},
		};

		const r = GlobalConfigSchema.safeParse(raw);
		expect(r.success).toBe(true);
		const bucket = r.data?.ai.providers.deepseek;
		expect(bucket).toMatchObject({
			provider: "deepseek",
			apiKey: "sk-ds",
			model: "deepseek-v4-pro",
		});
		expect(bucket && "temperature" in bucket).toBe(false);
	});

	it("per-UP 的 AI 覆盖带着 temperature → 解析成功,覆盖里只剩挑的那份人格", () => {
		const raw = {
			...makeEmptySubscription({
				id: "550e8400-e29b-41d4-a716-446655440000",
				identity: { sourceKey: "bilibili", externalId: "12345" },
			}),
			overrides: { ai: { preset: "tsundere", temperature: 1.5 } },
		};

		const r = SubscriptionSchema.safeParse(raw);
		expect(r.success).toBe(true);
		expect(r.data?.overrides.ai).toEqual({ preset: "tsundere" });
	});
});
