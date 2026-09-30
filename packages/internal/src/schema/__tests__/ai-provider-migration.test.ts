/**
 * AI 设置的服务商实例桶与老配置迁移。
 *
 * 模型:**连接与生成配置按「实例」存**(`ai.providers[实例id]`),同一家服务商
 * 可以有多份实例(两个 DeepSeek 号、一个测试用的百炼);每桶自带 `provider`
 * (方言归属)与 `label`(显示名)。`ai.activeProfile` 是「当前用哪份」的指针。
 *
 * 四条要紧的契约:
 *
 * ① **providers 是稀疏的 —— 没添加过的实例就是不存在,不是「存在但空着」。**
 *    设置页左栏据此只列已添加的那几块。
 * ② **方言归属只认桶里写明的 `provider`,绝不按 baseUrl 猜。** 猜错就是替主人
 *    往别家发方言参数,几乎必然 400。
 * ③ **两代老配置由迁移器改写,且键名一律原样保留**(`apps/server/src/migration/ai.ts`,
 *    用例在服务端的 `migration/__tests__/settings.test.ts`):更早的扁平连接字段整份落进
 *    `custom` 桶;上一代「一家一桶」的配置,桶键就是服务商名 —— 按键名盖
 *    `provider` 章、指针 `provider` 改名 `activeProfile`。键名不动意味着密钥
 *    加密袋(袋键=桶键)与老备份都无需搬迁。活 schema 只认当代形状,见文末那一组。
 * ④ **认不出方言归属的桶直接拒**:桶里没写 `provider`,说明数据被手改坏了(或是绕过了迁移的
 *    上一代形状)—— 悄悄吞掉或猜一个都比报错更糟。
 */

import { describe, expect, it } from "vite-plus/test";
import { EMPTY_AI_PROVIDER_PROFILE, resolveAIProfile } from "../../constants";
import { AIProviderProfileSchema, AISettingsSchema } from "../common";

/** 当代形状的骨架(桶里写明 `provider`、指针叫 `activeProfile`);`over` 覆盖各条测试关心的那几项。 */
function modern(over: Record<string, unknown> = {}) {
	return {
		enabled: true,
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

describe("当代:实例桶", () => {
	it("同一家可以有多份实例 —— 这正是分实例的意义", () => {
		const ai = AISettingsSchema.parse(
			modern({
				activeProfile: "deepseek-2",
				providers: {
					deepseek: { provider: "deepseek", apiKey: "sk-a" },
					"deepseek-2": { provider: "deepseek", label: "备用号", apiKey: "sk-b" },
				},
			}),
		);
		expect(ai.activeProfile).toBe("deepseek-2");
		expect(ai.providers.deepseek?.apiKey).toBe("sk-a");
		expect(ai.providers["deepseek-2"]).toMatchObject({ label: "备用号", apiKey: "sk-b" });
	});

	it("写明 provider 的桶,键名可以随便叫 —— 键只是实例 id", () => {
		const ai = AISettingsSchema.parse(
			modern({ providers: { "my-bailian": { provider: "bailian", apiKey: "sk" } } }),
		);
		expect(ai.providers["my-bailian"]?.provider).toBe("bailian");
	});

	it("已是当代形状的配置原样通过,不被迁移逻辑二次改写", () => {
		const input = modern({
			activeProfile: "deepseek",
			providers: { deepseek: { provider: "deepseek", label: "主号", apiKey: "sk-ds" } },
		});
		const ai = AISettingsSchema.parse(input);
		expect(ai.activeProfile).toBe("deepseek");
		expect(ai.providers.deepseek).toMatchObject({ provider: "deepseek", label: "主号" });
	});
});

describe("桶内字段的默认值与拒收", () => {
	it("只填了 provider 和 apiKey 的桶,其余项自动补齐", () => {
		const ai = AISettingsSchema.parse(
			modern({ providers: { deepseek: { provider: "deepseek", apiKey: "sk-ds" } } }),
		);
		expect(ai.providers.deepseek).toMatchObject({
			label: "",
			baseUrl: "",
			model: "",
			enableThinking: false,
			thinkingLevel: "medium",
			extraParams: "",
			enableVision: false,
			vision: { baseUrl: "", apiKey: "", model: "" },
		});
	});

	it("provider 写了个不认识的名字 → 直接拒", () => {
		expect(
			AISettingsSchema.safeParse(modern({ providers: { x: { provider: "openai", apiKey: "sk" } } }))
				.success,
		).toBe(false);
	});

	it("非法的思考等级直接拒", () => {
		const r = AISettingsSchema.safeParse(
			modern({ providers: { deepseek: { provider: "deepseek", thinkingLevel: "ultra" } } }),
		);
		expect(r.success).toBe(false);
		// 拒的得是「等级不合法」,不是别的格子。
		expect(r.error?.issues.map((i) => i.path.join("."))).toContain(
			"providers.deepseek.thinkingLevel",
		);
	});
});

describe("取当前生效的那一套", () => {
	it("按 activeProfile 指针取对应的桶", () => {
		const ai = AISettingsSchema.parse(
			modern({
				activeProfile: "deepseek-2",
				providers: {
					deepseek: { provider: "deepseek", apiKey: "sk-a", model: "m-a" },
					"deepseek-2": { provider: "deepseek", apiKey: "sk-b", model: "m-b" },
				},
			}),
		);
		expect(resolveAIProfile(ai)).toMatchObject({ apiKey: "sk-b", model: "m-b" });
	});

	it("指针指向一个已不存在的实例 → 返回一套空默认值,而不是 undefined", () => {
		// 主人可能刚把当前这份删掉。调用方拿到空 model 会照既有规矩判定「还没配齐」
		// 并停用 AI;返回 undefined 则会在各处炸出读属性的 TypeError。
		const ai = AISettingsSchema.parse(modern({ activeProfile: "gone", providers: {} }));
		expect(resolveAIProfile(ai).model).toBe("");
		expect(resolveAIProfile(ai).provider).toBe("custom");
	});
});

describe("零依赖的空档案与 schema 默认值同步", () => {
	it("EMPTY_AI_PROVIDER_PROFILE 与 parse 出的最小桶逐字段相同", () => {
		// 两份默认值分居两处是**刻意**的:`resolveAIProfile` 要给前端用,不能把 zod
		// 拖进浏览器 bundle(见 constants.ts 顶部的零依赖约定)。代价是有走偏的风险,
		// 这条测试就是那道锁 —— 一处改了另一处忘改,这里当场红。
		expect(EMPTY_AI_PROVIDER_PROFILE).toEqual(
			AIProviderProfileSchema.parse({ provider: "custom" }),
		);
	});
});

describe("活 schema 不再认老形状(那是迁移器的事)", () => {
	// schema 上没有 preprocess:喂老形状进来得到的是「不认」或「剥掉老键」,而不是「悄悄帮你迁」。
	// 这正是老形状绕过迁移的后果 —— 0.x 的老形状只在开新代时由迁移器改写一次。谁把老数据的兜底加回 schema,
	// 这几条就红(那会让同一份迁移逻辑在 schema 和迁移器里各住一份)。

	it("最老一代的扁平连接字段(没有 providers)→ 扁平键被剥掉,不会造出 custom 桶,指针也不会被选上", () => {
		const ai = AISettingsSchema.parse(
			modern({
				baseUrl: "https://api.deepseek.com",
				apiKey: "sk-old",
				model: "deepseek-v4-pro",
				enableThinking: true,
			}),
		);
		expect(ai.providers).toEqual({});
		expect(ai.activeProfile).toBe("");
		for (const key of ["baseUrl", "apiKey", "model", "enableThinking"]) {
			expect(ai, `扁平键 ${key} 应当被剥掉`).not.toHaveProperty(key);
		}
	});

	it("上一代「一家一桶」:桶里没写 provider → 拒收,不会按键名盖章", () => {
		const r = AISettingsSchema.safeParse(
			modern({ provider: "deepseek", providers: { deepseek: { apiKey: "sk-ds" } } }),
		);
		expect(r.success).toBe(false);
		expect(r.error?.issues.map((i) => i.path.join("."))).toContain("providers.deepseek.provider");
	});

	it("上一代的 provider 指针不会被改名成 activeProfile:老键被剥掉,指针留空", () => {
		const ai = AISettingsSchema.parse(
			modern({
				provider: "deepseek",
				providers: { deepseek: { provider: "deepseek", apiKey: "sk-ds" } },
			}),
		);
		expect(ai.activeProfile).toBe("");
		expect(ai).not.toHaveProperty("provider");
	});
});
