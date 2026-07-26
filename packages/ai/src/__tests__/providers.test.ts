/**
 * Provider 方言适配层。
 *
 * 这一层存在的唯一理由:**「开思考」这件事没有通用写法**。四家四种形状,
 * 而且分成两派 —— OpenRouter / DeepSeek 用等级枚举,火山 / 硅基用 token 预算。
 * 配置面上统一成低/中/高三档,各家在这里各自映射,主人换 provider 时已有的
 * 设置不作废。
 *
 * 另一件被这层顺手修掉的事:原先参数是塞在 `extra_body` 里发出去的。那是
 * **Python SDK 独有的写法** —— Node 的 openai 包对它一无所知,会把它当成一个
 * 普通字段原样序列化,于是线上真正发出去的是一个嵌套的 `"extra_body": {...}`,
 * 没有任何服务商认得。所以此前 enableThinking 从来没有真正生效过一次。
 * 这里产出的一律是**请求体顶层**的字段。
 */

import type { ThinkingLevel } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { buildProviderParams } from "../providers";

describe("OpenRouter — reasoning 统一对象", () => {
	it("开思考带上等级", () => {
		expect(
			buildProviderParams({
				provider: "openrouter",
				enableThinking: true,
				thinkingLevel: "high",
			}),
		).toEqual({ reasoning: { enabled: true, effort: "high" } });
	});

	it("三档原样透传 —— 这家的等级词表本来就跟我们对得上", () => {
		const effortOf = (thinkingLevel: ThinkingLevel) =>
			(
				buildProviderParams({ provider: "openrouter", enableThinking: true, thinkingLevel })
					.reasoning as { effort: string }
			).effort;
		expect([effortOf("low"), effortOf("medium"), effortOf("high")]).toEqual([
			"low",
			"medium",
			"high",
		]);
	});

	it("关思考什么都不发 —— 这家默认不思考,发 enabled:false 是多余的往返风险", () => {
		expect(
			buildProviderParams({
				provider: "openrouter",
				enableThinking: false,
				thinkingLevel: "high",
			}),
		).toEqual({});
	});
});

describe("DeepSeek — thinking 开关 + reasoning_effort 等级", () => {
	it("开思考", () => {
		expect(
			buildProviderParams({ provider: "deepseek", enableThinking: true, thinkingLevel: "high" }),
		).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "max" });
	});

	it("低/中都压到 high —— 这家只认 high 与 max 两档,官方自己也是这么映射的", () => {
		for (const thinkingLevel of ["low", "medium"] as const) {
			expect(
				buildProviderParams({ provider: "deepseek", enableThinking: true, thinkingLevel }),
			).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "high" });
		}
	});

	it("关思考必须显式发 disabled —— 这家默认就开着,不发等于关不掉", () => {
		expect(
			buildProviderParams({ provider: "deepseek", enableThinking: false, thinkingLevel: "high" }),
		).toEqual({ thinking: { type: "disabled" } });
	});
});

describe("火山方舟 — thinking 开关 + token 预算", () => {
	it("开思考,等级换算成 budget_tokens", () => {
		expect(
			buildProviderParams({ provider: "volcengine", enableThinking: true, thinkingLevel: "low" }),
		).toEqual({ thinking: { type: "enabled", budget_tokens: 4096 } });
	});

	it("三档预算严格递增 —— 换算表若被写反,高档反而思考得更浅", () => {
		const budgetOf = (thinkingLevel: ThinkingLevel) =>
			(
				buildProviderParams({ provider: "volcengine", enableThinking: true, thinkingLevel })
					.thinking as { budget_tokens: number }
			).budget_tokens;
		expect(budgetOf("low")).toBeLessThan(budgetOf("medium"));
		expect(budgetOf("medium")).toBeLessThan(budgetOf("high"));
	});

	it("关思考显式禁用 —— 豆包 thinking 系列默认是开的", () => {
		expect(
			buildProviderParams({
				provider: "volcengine",
				enableThinking: false,
				thinkingLevel: "high",
			}),
		).toEqual({ thinking: { type: "disabled" } });
	});
});

describe("硅基流动 — 扁平的 enable_thinking + thinking_budget", () => {
	it("开思考", () => {
		expect(
			buildProviderParams({
				provider: "siliconflow",
				enableThinking: true,
				thinkingLevel: "medium",
			}),
		).toEqual({ enable_thinking: true, thinking_budget: 16384 });
	});

	it("关思考发 false —— reasoning 类模型默认会吐一长串思维链", () => {
		expect(
			buildProviderParams({
				provider: "siliconflow",
				enableThinking: false,
				thinkingLevel: "high",
			}),
		).toEqual({ enable_thinking: false });
	});
});

describe("自定义 — 兜底档不替主人乱发方言", () => {
	it("开也好关也好,一个字段都不发", () => {
		for (const enableThinking of [true, false]) {
			expect(
				buildProviderParams({ provider: "custom", enableThinking, thinkingLevel: "high" }),
			).toEqual({});
		}
	});
});
