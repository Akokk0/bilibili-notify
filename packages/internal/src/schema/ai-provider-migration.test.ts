/**
 * AI 设置的服务商分桶与老配置迁移。
 *
 * 模型:**每家服务商各存一套自己的连接与生成配置**(`ai.providers[id]`),
 * `ai.provider` 是「当前用哪家」的指针。换家不再需要把 key 重敲一遍。
 *
 * 三条要紧的契约:
 *
 * ① **providers 是稀疏的 —— 没添加过的家就是不存在,不是「存在但空着」。**
 *    设置页左栏据此只列已添加的那几块;若是固定五键恒在,一打开就会列出五家,
 *    与「点添加才出现」的交互直接冲突。
 * ② **服务商只认主人明确选过的那一个,绝不按 baseUrl 猜。** 曾经这里会拿 baseUrl
 *    去匹配域名特征 —— 那是错的:主人选了「自定义」却被地址悄悄改回去,怎么改都
 *    改不掉;而猜错的代价是替主人往别家发方言参数,几乎必然 400。
 * ③ **老配置(一套扁平的 apiKey/baseUrl/model)整份落进 `custom` 桶并选中它。**
 *    那一档不发任何方言参数,等价于这套功能上线之前的行为 —— 升级零行为变化,
 *    也不必替主人猜他用的是哪家。
 */

import { describe, expect, it } from "vite-plus/test";
import { EMPTY_AI_PROVIDER_PROFILE, resolveAIProfile } from "../constants";
import { AIProviderProfileSchema, AISettingsSchema } from "./common";

/** 老配置的形状:扁平的连接字段,没有 provider / providers。 */
function legacy(over: Record<string, unknown> = {}) {
	return {
		enabled: true,
		baseUrl: "https://api.deepseek.com",
		apiKey: "sk-old",
		model: "deepseek-v4-pro",
		temperature: 0.3,
		persona: {
			name: "",
			addressUser: "",
			addressSelf: "",
			traits: "",
			catchphrase: "",
			baseRole: "",
			extraSystemPrompt: "",
		},
		dynamicPrompt: "",
		liveSummaryPrompt: "",
		presets: [],
		...over,
	};
}

/** 新配置的形状。 */
function modern(over: Record<string, unknown> = {}) {
	const { baseUrl, apiKey, model, temperature, ...rest } = legacy();
	return { ...rest, ...over };
}

describe("老配置迁移", () => {
	it("扁平的连接字段整份落进 custom 桶", () => {
		const ai = AISettingsSchema.parse(legacy());
		expect(ai.providers.custom).toMatchObject({
			apiKey: "sk-old",
			baseUrl: "https://api.deepseek.com",
			model: "deepseek-v4-pro",
			temperature: 0.3,
		});
	});

	it("并选中 custom —— 哪怕地址一眼就能认出是哪家", () => {
		// baseUrl 明明写着 api.deepseek.com,也**不**替主人选 DeepSeek。
		expect(AISettingsSchema.parse(legacy()).provider).toBe("custom");
	});

	it("迁移只造这一个桶,别家仍是「没添加过」", () => {
		// 五个桶恒在的话,设置页左栏一打开就列出五家,与「点添加才出现」冲突。
		expect(Object.keys(AISettingsSchema.parse(legacy()).providers)).toEqual(["custom"]);
	});

	it("上一版的思考三件套也跟着进 custom 桶,不丢", () => {
		const ai = AISettingsSchema.parse(
			legacy({ enableThinking: true, thinkingLevel: "high", extraParams: '{"top_k":40}' }),
		);
		expect(ai.providers.custom).toMatchObject({
			enableThinking: true,
			thinkingLevel: "high",
			extraParams: '{"top_k":40}',
		});
	});

	it("看图那两条路也一并搬进桶里", () => {
		const ai = AISettingsSchema.parse(
			legacy({ enableVision: true, vision: { baseUrl: "", apiKey: "sk-v", model: "qwen-vl" } }),
		);
		expect(ai.providers.custom?.enableVision).toBe(true);
		expect(ai.providers.custom?.vision).toMatchObject({ apiKey: "sk-v", model: "qwen-vl" });
	});

	it("已经是新格式的配置原样通过,不被迁移逻辑二次改写", () => {
		const ai = AISettingsSchema.parse(
			modern({
				provider: "deepseek",
				providers: { deepseek: { apiKey: "sk-ds", model: "deepseek-v4-pro" } },
			}),
		);
		expect(ai.provider).toBe("deepseek");
		expect(Object.keys(ai.providers)).toEqual(["deepseek"]);
		expect(ai.providers.deepseek?.apiKey).toBe("sk-ds");
	});

	it("全新配置什么桶都没有 —— 左栏该是空的", () => {
		expect(AISettingsSchema.parse(modern()).providers).toEqual({});
	});
});

describe("桶内字段的默认值", () => {
	it("只填了 apiKey 的桶,其余项自动补齐", () => {
		const ai = AISettingsSchema.parse(
			modern({ provider: "deepseek", providers: { deepseek: { apiKey: "sk-ds" } } }),
		);
		expect(ai.providers.deepseek).toMatchObject({
			baseUrl: "",
			model: "",
			temperature: 0.7,
			enableThinking: false,
			thinkingLevel: "medium",
			extraParams: "",
			enableVision: false,
			vision: { baseUrl: "", apiKey: "", model: "" },
		});
	});

	it("认不得的服务商名直接拒,而不是悄悄吞掉那个桶", () => {
		expect(
			AISettingsSchema.safeParse(modern({ providers: { openai: { apiKey: "sk" } } })).success,
		).toBe(false);
	});

	it("非法的思考等级直接拒", () => {
		expect(
			AISettingsSchema.safeParse(modern({ providers: { deepseek: { thinkingLevel: "ultra" } } }))
				.success,
		).toBe(false);
	});
});

describe("取当前生效的那一套", () => {
	it("按 provider 指针取对应的桶", () => {
		const ai = AISettingsSchema.parse(
			modern({
				provider: "deepseek",
				providers: {
					deepseek: { apiKey: "sk-ds", model: "deepseek-v4-pro" },
					openrouter: { apiKey: "sk-or", model: "anthropic/claude-sonnet-4" },
				},
			}),
		);
		expect(resolveAIProfile(ai)).toMatchObject({ apiKey: "sk-ds", model: "deepseek-v4-pro" });
	});

	it("指针指向一个还没添加的家 → 返回一套空默认值,而不是 undefined", () => {
		// 主人可能刚把当前这家删掉。调用方(引擎 / 路由)拿到空 model 会照既有规矩
		// 判定「还没配齐」并停用 AI —— 那是它们本来就处理得了的情形;
		// 返回 undefined 则会在各处炸出读属性的 TypeError。
		const ai = AISettingsSchema.parse(modern({ provider: "deepseek", providers: {} }));
		expect(resolveAIProfile(ai).model).toBe("");
		expect(resolveAIProfile(ai).apiKey).toBe("");
	});
});

describe("零依赖的空档案与 schema 默认值同步", () => {
	it("EMPTY_AI_PROVIDER_PROFILE 与 parse({}) 逐字段相同", () => {
		// 两份默认值分居两处是**刻意**的:`resolveAIProfile` 要给前端用,不能把 zod
		// 拖进浏览器 bundle(见 constants.ts 顶部的零依赖约定)。代价是有走偏的风险,
		// 这条测试就是那道锁 —— 一处改了另一处忘改,这里当场红。
		expect(EMPTY_AI_PROVIDER_PROFILE).toEqual(AIProviderProfileSchema.parse({}));
	});
});
