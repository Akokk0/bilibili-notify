/**
 * AI 服务商注册表 —— 两端共享的那份词表。
 *
 * 这里只测「认得出是哪一家」这件事。**把「开思考」翻译成各家写法**是另一层
 * (`@bilibili-notify/ai#buildProviderParams`),测试也在那边。
 */

import { describe, expect, it } from "vite-plus/test";
import {
	AI_PROVIDER_IDS,
	AI_PROVIDERS,
	aiProfileAt,
	EMPTY_AI_PROVIDER_PROFILE,
	providerMeta,
	resolveAIProfile,
} from "../ai";
import { DEFAULT_LOCALE } from "../i18n";

import { builtinPresetsFor } from "../texts/builtin";

describe("能力门控 —— 决定设置页上哪些项该露面", () => {
	it("DeepSeek 不声称支持看图 —— 官方接口里一个视觉模型都没有", () => {
		// 这不只是少显示一个开关:发图守卫也据此判断。只看 enableVision 就放行的话,
		// DeepSeek 用户开着那个开关发图会一路走到模型那儿才被拒,白烧一次请求。
		expect(providerMeta("deepseek").supportsVision).toBe(false);
	});

	it("聚合网关与多模型平台都有视觉模型", () => {
		for (const id of ["openrouter", "volcengine", "siliconflow", "bailian"] as const) {
			expect(providerMeta(id).supportsVision).toBe(true);
		}
	});

	it("百炼:支持思考,且「关」位要显式发 —— 新款商业版与开源版默认就开着", () => {
		// qwen-plus / qwen-flash / qwen3-max 默认关,qwen3.7+ 商业版与开源版默认开。
		// defaultsOn 填 true:对默认开的模型这是唯一能关掉的路,对默认关的模型
		// enable_thinking:false 也是合法参数,不构成风险。
		expect(providerMeta("bailian").supportsThinking).toBe(true);
		expect(providerMeta("bailian").thinkingDefaultsOn).toBe(true);
	});

	it("兜底档一律按「支持」放行 —— 能力未知时不替主人做减法", () => {
		expect(providerMeta("custom").supportsVision).toBe(true);
	});
});

describe("能力门控 —— 流式用量要不要显式开 include_usage(只影响请求形状,不上设置页)", () => {
	it("百炼、火山方舟:不开就不给 —— 两家文档都写明流式默认不带 usage", () => {
		expect(providerMeta("bailian").streamUsageNeedsOptIn).toBe(true);
		expect(providerMeta("volcengine").streamUsageNeedsOptIn).toBe(true);
	});

	it("DeepSeek(不开也给)、OpenRouter(总是给,参数已废弃)、硅基流动(文档里没这个参数)不发", () => {
		expect(providerMeta("deepseek").streamUsageNeedsOptIn).toBe(false);
		expect(providerMeta("openrouter").streamUsageNeedsOptIn).toBe(false);
		expect(providerMeta("siliconflow").streamUsageNeedsOptIn).toBe(false);
	});

	it("兜底档不发 —— 网关未知,被拒就白撞一次回落非流式", () => {
		// 与「能力未知不替主人做减法」方向相反:那边少发一个开关是减法,这边多发
		// 一个参数是加法 —— 未知的网关对陌生参数可能直接 400。
		expect(providerMeta("custom").streamUsageNeedsOptIn).toBe(false);
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

describe("aiProfileAt —— 按 id 取表里自己的那一家", () => {
	const mine = { ...EMPTY_AI_PROVIDER_PROFILE, model: "m" };

	it("表里有就交回那一家,没有回 undefined", () => {
		expect(aiProfileAt({ mine }, "mine")).toBe(mine);
		expect(aiProfileAt({ mine }, "nope")).toBeUndefined();
	});

	it.each(["constructor", "toString", "__proto__"])(
		"原型名 %s 且表里没有这一家:回 undefined,不交回原型上的东西",
		(name) => {
			expect(aiProfileAt({ mine }, name)).toBeUndefined();
		},
	);

	it("表整个缺席也回 undefined", () => {
		expect(aiProfileAt(undefined, "mine")).toBeUndefined();
	});
});

describe("内置 AI 人格", () => {
	it("四份预设的全部文字都不写死平台或创作者叫法", () => {
		const presetText = JSON.stringify(builtinPresetsFor(DEFAULT_LOCALE));

		expect(presetText).not.toContain("UP");
		expect(presetText).not.toContain("B 站");
	});
});

describe("resolveAIProfile —— 指针指着表里没有的名字", () => {
	const providers = { mine: { ...EMPTY_AI_PROVIDER_PROFILE, model: "m" } };

	it("普通的不存在的名字回空档案", () => {
		expect(resolveAIProfile({ activeProfile: "nope", providers })).toEqual(
			EMPTY_AI_PROVIDER_PROFILE,
		);
	});

	it.each(["constructor", "toString", "__proto__"])(
		"指针是原型名 %s 且表里没有这一家:与普通的不存在的名字一样回空档案,不交回原型上的东西",
		(name) => {
			const got = resolveAIProfile({ activeProfile: name, providers });
			expect(got).toEqual(resolveAIProfile({ activeProfile: "nope", providers }));
			expect(got).toEqual(EMPTY_AI_PROVIDER_PROFILE);
		},
	);

	it("表里自己有这一家时照常取(哪怕名字像原型名)", () => {
		const own = { ...EMPTY_AI_PROVIDER_PROFILE, model: "own" };
		// 不写 `table.constructor = own`:类型上那一格是 `Object` 的 `constructor`(`Function`),赋不进去。
		const table: Record<string, typeof own> = Object.assign(Object.create(null), {
			constructor: own,
		});
		expect(resolveAIProfile({ activeProfile: "constructor", providers: table })).toBe(own);
	});
});
