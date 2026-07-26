/**
 * AI 服务商注册表 —— 两端共享的那份词表。
 *
 * 这里只测「认得出是哪一家」这件事。**把「开思考」翻译成各家写法**是另一层
 * (`@bilibili-notify/ai#buildProviderParams`),测试也在那边。
 */

import { describe, expect, it } from "vite-plus/test";
import { AI_PROVIDER_IDS, AI_PROVIDERS, providerMeta } from "./constants";

describe("能力门控 —— 决定设置页上哪些项该露面", () => {
	it("DeepSeek 不声称支持看图 —— 官方接口里一个视觉模型都没有", () => {
		// 这不只是少显示一个开关:发图守卫也据此判断。只看 enableVision 就放行的话,
		// DeepSeek 用户开着那个开关发图会一路走到模型那儿才被拒,白烧一次请求。
		expect(providerMeta("deepseek").supportsVision).toBe(false);
	});

	it("聚合网关与多模型平台都有视觉模型", () => {
		for (const id of ["openrouter", "volcengine", "siliconflow"] as const) {
			expect(providerMeta(id).supportsVision).toBe(true);
		}
	});

	it("兜底档一律按「支持」放行 —— 能力未知时不替主人做减法", () => {
		expect(providerMeta("custom").supportsVision).toBe(true);
	});

	it("DeepSeek 开思考时会静默忽略 temperature", () => {
		// 官方文档明说 temperature / top_p / presence_penalty / frequency_penalty
		// 在思考模式下不报错也不生效。摆着让人调,只会以为是设置没存上。
		expect(providerMeta("deepseek").temperatureIgnoredWhenThinking).toBe(true);
	});

	it("其余各家开思考照样吃 temperature", () => {
		for (const id of ["openrouter", "volcengine", "siliconflow", "custom"] as const) {
			expect(providerMeta(id).temperatureIgnoredWhenThinking).toBe(false);
		}
	});
});

describe("注册表本体", () => {
	it("每个 id 都有一条 meta,不多不少", () => {
		expect(AI_PROVIDERS.map((p) => p.id)).toEqual([...AI_PROVIDER_IDS]);
	});

	it("兜底档不声称支持思考 —— 声称了就会给未适配的服务商乱发方言参数", () => {
		expect(providerMeta("custom").supportsThinking).toBe(false);
	});
});
