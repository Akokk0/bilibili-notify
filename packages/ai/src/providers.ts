/**
 * Provider 方言适配 —— 把「开思考 + 想思考多深」翻译成各家自己的请求体字段。
 *
 * 注册表本身(有哪几家、各家什么能力)住在 `@bilibili-notify/internal` 的零依赖
 * 常量层,因为设置页也要读它;这里只放翻译逻辑,服务端专属。
 *
 * 产出的一律是**请求体顶层**字段。此前这些参数是包在 `extra_body` 里发的,
 * 那是 Python SDK 独有的糖(它会把 extra_body 摊平进请求体);Node 的 openai
 * 包对它一无所知,原样序列化成一个谁都不认识的嵌套字段 —— 所以旧的
 * enableThinking 从来没有真正生效过。各家官方文档里满屏的 `extra_body=...`
 * 说的都是 Python 的写法,不是线上协议。
 *
 * 四家分两派:OpenRouter / DeepSeek 用**等级枚举**,火山 / 硅基用 **token 预算**。
 * 配置面上统一成低/中/高三档,映射全部收在这一个文件里 —— 主人换 provider
 * 时已有的档位设置不作废。
 */

import { type AIProviderId, providerMeta, type ThinkingLevel } from "@bilibili-notify/internal";

/**
 * 预算派(火山 / 硅基)的三档对应多少 token。数字是拍出来的经验值,取整到 4K 的
 * 倍数:够低档快速过一遍,够高档啃完一道长推理,又都远在各家上限之内。
 */
const BUDGET_BY_LEVEL: Record<ThinkingLevel, number> = {
	low: 4096,
	medium: 16384,
	high: 32768,
};

export interface BuildProviderParamsInput {
	provider: AIProviderId;
	enableThinking: boolean;
	thinkingLevel: ThinkingLevel;
}

/**
 * 造出该 provider 的思考相关请求体字段。**只管思考这一件事** —— 额外参数的
 * 合并是另一层(见 `./extra-params`),这样降级重试时可以只摘掉我们自己加的
 * 这部分,保留主人手写的那部分。
 */
export function buildProviderParams(input: BuildProviderParamsInput): Record<string, unknown> {
	const { provider, enableThinking, thinkingLevel } = input;
	const meta = providerMeta(provider);
	if (!meta.supportsThinking) return {};

	// 「关」位。默认就不思考的家不必多发一条禁用 —— 少一个可能被网关拒的字段;
	// 默认开着的家则**必须**显式发,否则这个开关根本关不掉。
	if (!enableThinking) {
		if (!meta.thinkingDefaultsOn) return {};
		switch (provider) {
			case "deepseek":
			case "volcengine":
				return { thinking: { type: "disabled" } };
			case "siliconflow":
				return { enable_thinking: false };
			default:
				return {};
		}
	}

	// 「开」位。
	switch (provider) {
		case "openrouter":
			// 等级词表跟我们的三档天然对齐,原样透传。
			return { reasoning: { enabled: true, effort: thinkingLevel } };

		case "deepseek":
			// 只认 high / max 两档;官方自己也把 low / medium 折到 high。
			return {
				thinking: { type: "enabled" },
				reasoning_effort: thinkingLevel === "high" ? "max" : "high",
			};

		case "volcengine":
			return { thinking: { type: "enabled", budget_tokens: BUDGET_BY_LEVEL[thinkingLevel] } };

		case "siliconflow":
			return { enable_thinking: true, thinking_budget: BUDGET_BY_LEVEL[thinkingLevel] };

		default:
			return {};
	}
}
