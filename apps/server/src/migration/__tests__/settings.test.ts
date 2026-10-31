/**
 * 全局设置里剩下的 0.x 老形状 → 最新形状,迁移这一头的用例:
 *
 * - **AI 设置**(`defaults.ai`,`migration/ai.ts`):三代老数据 ——
 *   最老一代扁平的连接字段(`apiKey` / `baseUrl` / `model` …,没有 `providers`)整份落进 `providers.custom`、指针选 `custom`;
 *   上一代「一家一桶」(桶键就是服务商名、桶里没写 `provider`,指针还叫 `provider`)按键名盖 `provider` 章、指针改名
 *   `activeProfile`,**键名原样保留**;预设上线前的 `presets: []` 与手改过的 `persona`(没有 `activePreset`)
 *   把顶层人格造一份主人自己的预设并指过去,不拿运行时的内置文案补清单;指针悬空则收回第一份。
 * - **链接解析**(`linkParsing`,`migration/link-parsing.ts`):0.9.1 的 `scope` + `targets` → `defaults` + `groups`。
 * - **历代旧默认模板**(`defaults.templates`,`migration/templates.ts`):值对得上任何一代旧默认的改写成当前默认。
 *   这一项在 internal 里没有 schema 层的用例(它原先住在配置仓开机上,走接缝的那几条在 `./zero-generation-settings.test.ts`),
 *   下面的表驱动用例把冻结的那张旧默认表逐条过一遍。
 *
 * 这批用例原先住在 `packages/internal`(`ai-provider-migration.test.ts` / `ai-persona-pointer.test.ts` /
 * `ai-search-settings.test.ts` / `ai-temperature-retired.test.ts` / `link-parsing.test.ts`),当时老数据的兜底挂在 schema
 * 的 preprocess 上、用例是「`XxxSchema.parse(老形状)`」。兜底搬到迁移器(preprocess 随后删掉)以后它们跟着搬过来:
 * 「先过迁移函数、再过 `XxxSchema.parse(…)`」,**期望值一个字没改**(它们是独立的真源)。测试名沿用原名,
 * 想找原件的出处 grep 名字就行。活 schema 现在只认新形状(那边的反面用例在 internal 各自文件的末尾)。
 *
 * 下面的 `parseAi` / `parseLink` 除了先迁移、再过 schema,还钉三件事 —— 这才是「迁移器自己把活干完了」:
 * - 迁出来的东西里没有老键,且新形状的关键部分已经就位(桶盖了章、人格指针落在预设里、`defaults` 在)。活 schema 对老键
 *   是剥掉或拒收,漏迁的老键在 parse 出来的值里只会悄悄不见(或整份被拒、又看不出是漏了哪一步),所以这几条要
 *   **直接看迁出来的东西**;
 * - 迁出来的东西再迁一遍不变(幂等);
 * - `temperature` 不在老键清单里:它是退役键,迁移器刻意留在 ai 这一层、由 schema 剥掉(见 `ai.ts`),「哪一层都没有它」
 *   只能在 parse 出来的值上看(`ai-temperature-retired` 那条)。
 *
 * `migrateGlobals` 吐的是 0.x 最新的形状(特性键仍是 0.x 的名字);整份过 `GlobalConfigSchema` 的几处要走完整条
 * `migrateGlobalsToCurrent` 流水线(改名、搬家、拆键、上提),文件级迁移里也是这条,活 schema 只认 1.0 的键。
 */

import {
	AI_PROVIDER_IDS,
	AISettingsSchema,
	GlobalConfigSchema,
	LinkPreviewSettingsSchema,
} from "@bilibili-notify/internal";
import { builtinPresetsFor } from "@bilibili-notify/internal/texts/builtin";
import { describe, expect, it } from "vite-plus/test";
import { migrateAiSettings } from "../ai.js";
import { migrateLegacyLinkParsing, renameLinkParsing } from "../link-parsing.js";
import { migrateGlobals, migrateGlobalsToCurrent, moveHistoryRetention } from "../settings.js";
import { migrateOldTemplateDefaults } from "../templates.js";
import { makeZeroGlobals } from "./zero-fixtures.js";

// 非空的 0.x 清单可能带着四份内置原文;1.0 的活 schema 里它们不再落盘,这里拿内置原文当输入
const FACTORY_PRESETS = builtinPresetsFor("zh-CN");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

// ── 「迁移自己把活干完」的钉子 ───────────────────────────────────────────────────────

/** ai 这一层顶层的扁平连接字段(`temperature` 退役,不在此列)与上一代的 `provider` 指针。 */
const LEGACY_AI_KEYS = [
	"apiKey",
	"baseUrl",
	"model",
	"enableThinking",
	"thinkingLevel",
	"extraParams",
	"enableVision",
	"vision",
	"provider",
] as const;

type MigratedAi = {
	providers?: Record<string, Record<string, unknown> | undefined>;
	presets?: { id: string }[];
	activePreset?: string;
};

/** ai 这一层:顶层不许留老键;认得的服务商名作键的桶都盖了章;人格指针落在非空的预设清单里。 */
function expectMigratedAiShape(migrated: unknown): void {
	for (const key of LEGACY_AI_KEYS) {
		expect(migrated, `ai 顶层还留着老键 ${key}`).not.toHaveProperty(key);
	}
	const ai = migrated as MigratedAi;
	expect(ai.providers, "迁出来的 ai 没有 providers").toBeDefined();
	for (const [key, bucket] of Object.entries(ai.providers ?? {})) {
		if ((AI_PROVIDER_IDS as readonly string[]).includes(key)) {
			expect(bucket?.provider, `桶 ${key} 没盖 provider 章`).toBeDefined();
		}
	}
	expect(ai.presets?.length, "迁出来的 presets 是空的").toBeGreaterThan(0);
	expect(
		ai.presets?.map((p) => p.id),
		"activePreset 没落在 presets 里",
	).toContain(ai.activePreset);
}

/** AI 设置:先迁移(并钉住迁出来的形状与幂等),交出迁出来的那份。 */
function migrateAi(old: unknown): unknown {
	const migrated = migrateAiSettings(old);
	expectMigratedAiShape(migrated);
	expect(migrateAiSettings(migrated)).toEqual(migrated);
	return migrated;
}

/** AI 设置:先迁移、再过 schema。 */
function parseAi(old: unknown) {
	return AISettingsSchema.parse(migrateAi(old));
}

/** 链接设置整条迁移:0.x 的 `linkParsing` 先到 0.x 最新形状,再改成 `linkPreview` 五格(盘上的 core.json 经过的就是这两步)。 */
function linkPreviewOf(old: unknown): unknown {
	const renamed = renameLinkParsing({ linkParsing: migrateLegacyLinkParsing(old) }) as Record<
		string,
		unknown
	>;
	expect(renamed, "迁完不该还留着 linkParsing").not.toHaveProperty("linkParsing");
	expect(renameLinkParsing(renamed)).toEqual(renamed);
	return renamed.linkPreview;
}

/**
 * 链接设置(只喂带老键的输入):0.9.1 的 `scope` / `targets` 迁出来不许留;整条迁完没有 `defaults` / `groups` /
 * `cooldownSeconds` 这些 0.x 的键;幂等;再过 schema。
 */
function parseLink(old: unknown) {
	const migrated = migrateLegacyLinkParsing(old);
	for (const key of ["scope", "targets"]) {
		expect(migrated, `linkParsing 还留着老键 ${key}`).not.toHaveProperty(key);
	}
	expect(migrated).toHaveProperty("defaults");
	expect(migrated).toHaveProperty("groups");
	expect(migrateLegacyLinkParsing(migrated)).toEqual(migrated);
	const preview = linkPreviewOf(old);
	for (const key of ["defaults", "groups", "cooldownSeconds"]) {
		expect(preview, `linkPreview 还留着 0.x 的键 ${key}`).not.toHaveProperty(key);
	}
	return LinkPreviewSettingsSchema.parse(preview);
}

// ── AI · 服务商实例桶(原 ai-provider-migration.test.ts)──────────────────────────────

/** 最老一代配置的形状:扁平的连接字段,没有 provider / providers。 */
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

/** 桶已分家的形状(上一代按服务商一家一桶,或当代按实例)。 */
function modern(over: Record<string, unknown> = {}) {
	const { baseUrl, apiKey, model, temperature, ...rest } = legacy();
	return { ...rest, ...over };
}

describe("AI 迁移 · 最老一代:扁平连接字段", () => {
	it("整份落进 custom 桶,并盖上 provider 章", () => {
		const ai = parseAi(legacy());
		expect(ai.providers.custom).toMatchObject({
			provider: "custom",
			apiKey: "sk-old",
			baseUrl: "https://api.deepseek.com",
			model: "deepseek-v4-pro",
		});
	});

	it("指针指向 custom —— 哪怕地址一眼就能认出是哪家", () => {
		expect(parseAi(legacy()).activeProfile).toBe("custom");
	});

	it("迁移只造这一个桶,别家仍是「没添加过」", () => {
		expect(Object.keys(parseAi(legacy()).providers)).toEqual(["custom"]);
	});

	it("上一版的思考三件套也跟着进 custom 桶,不丢", () => {
		const ai = parseAi(
			legacy({ enableThinking: true, thinkingLevel: "high", extraParams: '{"top_k":40}' }),
		);
		expect(ai.providers.custom).toMatchObject({
			enableThinking: true,
			thinkingLevel: "high",
			extraParams: '{"top_k":40}',
		});
	});

	it("看图那两条路也一并搬进桶里", () => {
		const ai = parseAi(
			legacy({ enableVision: true, vision: { baseUrl: "", apiKey: "sk-v", model: "qwen-vl" } }),
		);
		expect(ai.providers.custom?.enableVision).toBe(true);
		expect(ai.providers.custom?.vision).toMatchObject({ apiKey: "sk-v", model: "qwen-vl" });
	});
});

describe("AI 迁移 · 上一代:一家一桶、provider 指针", () => {
	it("桶键原样保留、按键名盖 provider 章,指针改名 activeProfile", () => {
		// 键名不动是③的核心:密钥加密袋的袋键就是桶键,搬键名等于重启后密钥对不上号。
		const ai = parseAi(
			modern({
				provider: "deepseek",
				providers: { deepseek: { apiKey: "sk-ds", model: "deepseek-v4-pro" } },
			}),
		);
		expect(ai.activeProfile).toBe("deepseek");
		expect(Object.keys(ai.providers)).toEqual(["deepseek"]);
		expect(ai.providers.deepseek).toMatchObject({ provider: "deepseek", apiKey: "sk-ds" });
	});

	it("多家并存时每桶各盖各的章", () => {
		const ai = parseAi(
			modern({
				provider: "siliconflow",
				providers: { deepseek: { apiKey: "sk-ds" }, siliconflow: { apiKey: "sk-sf" } },
			}),
		);
		expect(ai.providers.deepseek?.provider).toBe("deepseek");
		expect(ai.providers.siliconflow?.provider).toBe("siliconflow");
		expect(ai.activeProfile).toBe("siliconflow");
	});

	it("全新配置什么桶都没有 —— 左栏该是空的,指针悬空", () => {
		const ai = parseAi(modern());
		expect(ai.providers).toEqual({});
		expect(ai.activeProfile).toBe("");
	});
});

describe("AI 迁移 · 当代:实例桶(迁移不该动它)", () => {
	it("同一家可以有多份实例 —— 这正是分实例的意义", () => {
		const ai = parseAi(
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
		const ai = parseAi(
			modern({ providers: { "my-bailian": { provider: "bailian", apiKey: "sk" } } }),
		);
		expect(ai.providers["my-bailian"]?.provider).toBe("bailian");
	});

	it("已是当代形状的配置原样通过,不被迁移逻辑二次改写", () => {
		const input = modern({
			activeProfile: "deepseek",
			providers: { deepseek: { provider: "deepseek", label: "主号", apiKey: "sk-ds" } },
		});
		const ai = parseAi(input);
		expect(ai.activeProfile).toBe("deepseek");
		expect(ai.providers.deepseek).toMatchObject({ provider: "deepseek", label: "主号" });
		// 迁出来的桶就是进去的桶 —— 指针没被改名、桶没被重盖。
		const migrated = migrateAi(input) as { activeProfile?: string; providers?: unknown };
		expect(migrated.activeProfile).toBe("deepseek");
		expect(migrated.providers).toEqual((input as { providers?: unknown }).providers);
	});
});

describe("AI 迁移 · 桶内字段的默认值与拒收", () => {
	it("只填了 provider 和 apiKey 的桶,其余项自动补齐", () => {
		const ai = parseAi(modern({ providers: { deepseek: { apiKey: "sk-ds" } } }));
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

	it("键认不出、桶里又没写 provider → 直接拒,不猜也不吞", () => {
		// 迁移器不替它盖章 —— 猜一个方言归属比报错更糟;拒收是 schema 的事。
		const migrated = migrateAi(modern({ providers: { openai: { apiKey: "sk" } } })) as MigratedAi;
		expect(migrated.providers?.openai).not.toHaveProperty("provider");
		expect(AISettingsSchema.safeParse(migrated).success).toBe(false);
	});

	it("非法的思考等级直接拒", () => {
		const migrated = migrateAi(modern({ providers: { deepseek: { thinkingLevel: "ultra" } } }));
		const r = AISettingsSchema.safeParse(migrated);
		expect(r.success).toBe(false);
		// 拒的得是「等级不合法」,不是「桶没盖章」—— 盖章那一步迁移器已经做了(上面 migrateAi 钉过)。
		expect(r.error?.issues.map((i) => i.path.join("."))).toContain(
			"providers.deepseek.thinkingLevel",
		);
	});
});

// ── AI · 人格指针(原 ai-persona-pointer.test.ts)────────────────────────────────────

/** 新格式的骨架;`presets` / `persona` 由各条测试自己给。 */
function personaBase(over: Record<string, unknown> = {}) {
	return {
		enabled: true,
		persona: FACTORY_PRESETS[0]?.persona,
		dynamicPrompt: "",
		liveSummaryPrompt: "",
		providers: {},
		presets: FACTORY_PRESETS,
		...over,
	};
}

const HAND_WRITTEN = {
	name: "阿绫",
	addressUser: "老板",
	addressSelf: "我",
	traits: "话少、干脆",
	catchphrase: "",
	baseRole: "简洁汇报,不寒暄。",
	extraSystemPrompt: "",
};

describe("AI 迁移 · 人格指针 · 首次带上指针", () => {
	it("全新配置 → 指向第一份「温柔女仆」", () => {
		const ai = parseAi(personaBase());
		expect(ai.activePreset).toBe("gentle-maid");
		expect(ai.presets[0]?.label).toBe("温柔女仆");
	});

	it("persona 与某份预设一模一样 → 指向它,不平白多造一份重复的", () => {
		const ai = parseAi(
			personaBase({ persona: FACTORY_PRESETS[1]?.persona }), // 傲娇毒舌
		);
		expect(ai.activePreset).toBe("tsundere");
		expect(ai.presets).toHaveLength(FACTORY_PRESETS.length);
	});

	it("persona 是手改过的 → 造一份预设装着它并指过去,一个字都不丢", () => {
		// 这是最要紧的一条:不这么做的话,主人手写的人格在新界面上就彻底点不到了。
		const ai = parseAi(personaBase({ persona: HAND_WRITTEN }));
		const active = ai.presets.find((p) => p.id === ai.activePreset);
		expect(active?.persona).toEqual(HAND_WRITTEN);
	});

	it("手改的那份用 persona.name 当名字,认得出来是自己的", () => {
		const ai = parseAi(personaBase({ persona: HAND_WRITTEN }));
		expect(ai.presets.find((p) => p.id === ai.activePreset)?.label).toBe("阿绫");
	});

	it("手改且没起名 → 有个能看的兜底名字,不是一条空白行", () => {
		const ai = parseAi(personaBase({ persona: { ...HAND_WRITTEN, name: "" } }));
		expect(ai.presets.find((p) => p.id === ai.activePreset)?.label).toBe("我的性格");
	});

	it("新造那份的 id 不与已有的撞", () => {
		const ai = parseAi(personaBase({ persona: HAND_WRITTEN }));
		const ids = ai.presets.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("指针已选定某份、而 persona 恰好像另一份 → **指针说了算**", () => {
		// 最阴的一条:主人选了「傲娇毒舌」,但 ai.persona 还留着女仆那份内容(指针本来
		// 就不改写 persona)。迁移若不先认指针,每次读配置都会按 persona 把选择重置回
		// 「温柔女仆」—— 主人换来换去发现「怎么重启又变回去了」。
		const ai = parseAi(
			personaBase({ persona: FACTORY_PRESETS[0]?.persona, activePreset: "tsundere" }),
		);
		expect(ai.activePreset).toBe("tsundere");
	});

	it("已有的 id 就叫 custom-persona 时,新造那份要换个名字", () => {
		const ai = parseAi(
			personaBase({
				persona: HAND_WRITTEN,
				presets: [{ id: "custom-persona", label: "占位的", persona: FACTORY_PRESETS[0]?.persona }],
			}),
		);
		const ids = ai.presets.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ai.presets.find((p) => p.id === ai.activePreset)?.persona).toEqual(HAND_WRITTEN);
	});

	it("已经有指针 → 一动不动(迁移只跑一次,不会反复往里塞)", () => {
		const once = parseAi(personaBase({ persona: HAND_WRITTEN }));
		const twice = parseAi(once);
		expect(twice.presets).toHaveLength(once.presets.length);
		expect(twice.activePreset).toBe(once.activePreset);
	});
});

describe("AI 迁移 · 人格指针 · 不变量:恒有一份人格可用", () => {
	it("presets 空 → 不拿运行时的内置表补齐", () => {
		// `presets: []` 是预设功能上线前的旧盘。内置人格的内容属于当前语言与当前版本,
		// 不该把迁移那一版的四份原文写进主人设置;下一步只按冻住的 id 记删过哪几份。
		const ai = parseAi(personaBase({ presets: [], persona: HAND_WRITTEN }));
		for (const b of FACTORY_PRESETS) {
			expect(ai.presets.some((p) => p.id === b.id)).toBe(false);
		}
	});

	it("presets 空且 persona 是手改过的 → 只造他自己那份,并选中它", () => {
		const ai = parseAi(personaBase({ presets: [], persona: HAND_WRITTEN }));
		expect(ai.presets).toHaveLength(1);
		expect(ai.presets.find((p) => p.id === ai.activePreset)?.persona).toEqual(HAND_WRITTEN);
	});

	it("presets 空且 persona 就是内置那份 → 也把顶层副本另存为他自己的一份", () => {
		const ai = parseAi(personaBase({ presets: [], persona: FACTORY_PRESETS[0]?.persona }));
		expect(ai.presets).toEqual([
			expect.objectContaining({
				id: "custom-persona",
				persona: FACTORY_PRESETS[0]?.persona,
			}),
		]);
		expect(ai.activePreset).toBe("custom-persona");
	});

	it("指针指着一份不存在的预设 → 收回到第一份,不留悬空", () => {
		const ai = parseAi(personaBase({ activePreset: "gone" }));
		expect(ai.activePreset).toBe(ai.presets[0]?.id);
	});
});

// ── AI · 走过 provider 迁移链的老配置(原 ai-search-settings.test.ts)───────────────

describe("AI 迁移 · 补齐 search 段", () => {
	it("走过 provider 迁移链的老配置同样补齐 search 段", () => {
		// 上一代「一家一桶」形状:桶键即服务商名,指针字段还叫 provider。
		const ai = parseAi({
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
			provider: "deepseek",
			providers: { deepseek: { apiKey: "k", baseUrl: "https://api.deepseek.com" } },
		});
		expect(ai.activeProfile).toBe("deepseek");
		expect(ai.search.backend).toBe("bocha");
	});
});

// ── AI · temperature 退役(原 ai-temperature-retired.test.ts)────────────────────────

/** 一份 0.12 出厂 globals 的副本(冻住的字面量,见 `./zero-fixtures.ts`),拿来就地改成盘上的老形状。 */
function rawGlobals(): { defaults: { ai: Record<string, unknown> } } {
	return makeZeroGlobals();
}

describe("AI 迁移 · temperature 退役 —— 老配置照样装得进来", () => {
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

		// 整份 globals 先过迁移:扁平字段在 ai 这一层已经搬干净,temperature 留给 schema 剥(不在老键清单里)。
		const migrated = migrateGlobals(raw) as { defaults: { ai: unknown } };
		expectMigratedAiShape(migrated.defaults.ai);
		expect(migrateGlobals(migrated)).toEqual(migrated);

		// 整条流水线走完(`migrateGlobalsToCurrent`,含 AI 上提到顶层)才是 schema 认的形状。
		const r = GlobalConfigSchema.safeParse(migrateGlobalsToCurrent(migrated));
		expect(r.success).toBe(true);
		const ai = r.data?.ai;
		// 连接字段照旧搬进 custom 桶 —— 退役的只是 temperature 这一格。
		expect(ai?.providers.custom).toMatchObject({ apiKey: "sk-old", model: "deepseek-v4-pro" });
		expect(ai && "temperature" in ai).toBe(false);
		expect(ai?.providers.custom && "temperature" in ai.providers.custom).toBe(false);
	});
});

// ── 链接解析(原 link-parsing.test.ts)──────────────────────────────────────────────

/** 全新安装的那一份:总开关关、默认回、回图片、没有例外、冷却 60 秒。 */
const FRESH_LINK = {
	enabled: false,
	isOnByDefault: true,
	replyForm: "image",
	byTarget: {},
	cooldownSec: 60,
};

describe("链接预览迁移 · 0.x 的 linkParsing 配置段", () => {
	// 白名单进来之前发出去的版本只有 enabled / cooldownSeconds。升上来的实例必须落在
	// 「所有群都回」—— 行为一字不变,主人开过的功能不能因为升级悄悄缩到零个群。
	// 这一代没有老键可迁到 0.x 最新形状:`migrateLegacyLinkParsing` 原样放过;改成五格那一步只搬
	// 总开关与冷却两格,默认行由 schema 补。
	it("白名单之前的版本(只有 enabled / cooldownSeconds)→ 所有群回", () => {
		const old = { enabled: true, cooldownSeconds: 30 };
		expect(migrateLegacyLinkParsing(old)).toEqual(old);
		expect(linkPreviewOf(old)).toEqual({ enabled: true, cooldownSec: 30 });
		expect(LinkPreviewSettingsSchema.parse(linkPreviewOf(old))).toEqual({
			...FRESH_LINK,
			enabled: true,
			cooldownSec: 30,
		});
	});
});

describe("链接预览迁移 · linkParsing → linkPreview 五格", () => {
	it("全格对应:enabled 原样;defaults.parse → isOnByDefault;defaults.form → replyForm(miniapp 叫 nativeShare);groups → byTarget(parse → isOn、form → replyForm);cooldownSeconds → cooldownSec", () => {
		expect(
			renameLinkParsing({
				linkParsing: {
					enabled: true,
					cooldownSeconds: 120,
					defaults: { parse: false, form: "miniapp" },
					groups: { [A]: { parse: true, form: "image" }, [B]: { form: "miniapp" } },
				},
			}),
		).toEqual({
			linkPreview: {
				enabled: true,
				cooldownSec: 120,
				isOnByDefault: false,
				replyForm: "nativeShare",
				byTarget: { [A]: { isOn: true, replyForm: "image" }, [B]: { replyForm: "nativeShare" } },
			},
		});
	});

	// 0.x 的门先看总开关、再看逐群答案(0.9.0–0.12.0 的 link-parser.ts 一致),所以总开关关着时例外再怎么写也一张不回;
	// 面板在总开关关着时例外表照样能改,0.9.1 迁出来的白名单也是这个形状。迁过来总开关必须仍是总开关,
	// 不能折进默认行 —— 折进去的话显式开的例外会从「不回」变成「回」。
	it("总开关关着、例外里有群显式开 → enabled 仍关、那条例外原样带过来;默认回不回只看 defaults.parse", () => {
		const preview = linkPreviewOf({
			enabled: false,
			cooldownSeconds: 60,
			defaults: { parse: false, form: "image" },
			groups: { [A]: { parse: true } },
		});
		expect(preview).toEqual({
			enabled: false,
			cooldownSec: 60,
			isOnByDefault: false,
			replyForm: "image",
			byTarget: { [A]: { isOn: true } },
		});
	});

	it("总开关开着、默认行关 → 两格各自独立,不互相带", () => {
		const preview = linkPreviewOf({
			enabled: true,
			cooldownSeconds: 60,
			defaults: { parse: false, form: "image" },
			groups: {},
		}) as { enabled: boolean; isOnByDefault: boolean };
		expect(preview.enabled).toBe(true);
		expect(preview.isOnByDefault).toBe(false);
	});

	it("新旧两把键都在 → linkPreview 说了算,linkParsing 丢掉", () => {
		expect(
			renameLinkParsing({
				other: 1,
				linkParsing: { enabled: true },
				linkPreview: { enabled: false, cooldownSec: 5 },
			}),
		).toEqual({ other: 1, linkPreview: { enabled: false, cooldownSec: 5 } });
	});

	it("没有 linkParsing(只有 linkPreview、或两者都没有)原样放过;其余键一个不动", () => {
		const fresh = { linkPreview: { enabled: true }, x: 1 };
		expect(renameLinkParsing(fresh)).toBe(fresh);
		const none = { x: 1 };
		expect(renameLinkParsing(none)).toBe(none);
	});

	it("旧键里缺的格照缺:只有 defaults.parse 就只出 isOnByDefault,其余由 schema 补", () => {
		const preview = linkPreviewOf({ defaults: { parse: false } });
		expect(preview).toEqual({ isOnByDefault: false });
		expect(LinkPreviewSettingsSchema.parse(preview)).toEqual({
			...FRESH_LINK,
			isOnByDefault: false,
		});
	});

	it("认不得的值原样搬,由配置仓开机报:form 不是两档之一、条目不是对象", () => {
		const preview = linkPreviewOf({
			defaults: { parse: true, form: "both" },
			groups: { [A]: 3 },
		});
		expect(preview).toEqual({ isOnByDefault: true, replyForm: "both", byTarget: { [A]: 3 } });
		expect(LinkPreviewSettingsSchema.safeParse(preview).success).toBe(false);
	});

	it("linkParsing 不是对象(3 / 数组 / null)→ 原样搬到 linkPreview,由配置仓开机报", () => {
		for (const bad of [3, [1], null]) {
			const out = renameLinkParsing({ linkParsing: bad }) as Record<string, unknown>;
			expect(out).toEqual({ linkPreview: bad });
		}
	});

	it("整份核心设置不是对象 → 原样放过", () => {
		expect(renameLinkParsing(null)).toBe(null);
		expect(renameLinkParsing(7)).toBe(7);
		const arr: unknown[] = [];
		expect(renameLinkParsing(arr)).toBe(arr);
	});
});

/**
 * 0.9.1 存的是 `scope: all | selected` + `targets: [{ targetId }]`。现在没有「范围」这个
 * 概念了:所有群 = 默认行解析开;仅以下群 = 默认行解析关 + 列出的群显式开。读的时候
 * 按形状认出来迁,盘上那份不动。
 */
describe("链接解析迁移 · 0.9.1 的范围 + 白名单按形迁移", () => {
	it("scope=all → 默认行解析开、没有例外;all 下的 targets 本来就不起作用,不带过来", () => {
		expect(
			parseLink({
				enabled: true,
				cooldownSeconds: 30,
				scope: "all",
				targets: [{ targetId: A }],
			}),
		).toEqual({ ...FRESH_LINK, enabled: true, cooldownSec: 30 });
	});

	it("scope=selected + 两个群(其中一个写了两遍)→ 默认行解析关、两群显式开", () => {
		expect(
			parseLink({
				enabled: true,
				scope: "selected",
				targets: [{ targetId: A }, { targetId: B }, { targetId: A }],
			}),
		).toEqual({
			...FRESH_LINK,
			enabled: true,
			isOnByDefault: false,
			byTarget: { [A]: { isOn: true }, [B]: { isOn: true } },
		});
	});

	it("scope=selected 且列表为空 → 默认关、没有例外 = 一个群都不解析", () => {
		expect(parseLink({ scope: "selected", targets: [] })).toEqual({
			...FRESH_LINK,
			isOnByDefault: false,
		});
	});

	it("新旧键同时出现(补丁合并进老数据)→ 认新的,老键丢掉", () => {
		expect(
			parseLink({
				scope: "selected",
				targets: [{ targetId: A }],
				defaults: { parse: true, form: "miniapp" },
				groups: { [B]: { form: "image" } },
			}),
		).toEqual({
			...FRESH_LINK,
			replyForm: "nativeShare",
			byTarget: { [B]: { replyForm: "image" } },
		});
	});
});

// ── 历代旧默认模板 ───────────────────────────────────────────────────────────────────
//
// 这一组没有 internal 里的对应用例(配置仓开机上的那三条走接缝,见 `./zero-generation-settings.test.ts`,它们只用到表里的
// 一部分旧默认)。旧默认的原文在这里独立抄一份当真源;「当前默认」取 `makeZeroGlobals()` 里冻着的 0.12 出厂文案 ——
// 与迁移器自己那份(`zero-vocabulary.ts` 的 `ZERO_DEFAULT_TEMPLATES`)是各抄各的两份,用例拿这份去比迁移器写出来的。

describe("历代旧默认模板迁移(templates)", () => {
	const fresh = makeZeroGlobals().defaults.templates;
	const freshByKey = fresh as unknown as Record<string, unknown>;

	/** 占位符语法统一前(alpha.x)的旧变量默认,与消息版式引入前「链接内嵌模板」的 `{url}` / `{link}` 默认。 */
	const OLD_DEFAULTS: Array<[key: string, old: string]> = [
		["liveStart", "{name} 开播了！\n直播间标题：{title}\n直播间链接：{link}"],
		["liveStart", "{name} 开播啦，当前粉丝数：{follower}\n{link}"],
		["liveOngoing", "{name} 仍在直播中（已直播 {duration}）\n标题：{title}\n看过：{watched}"],
		["liveOngoing", "{name} 正在直播，已播 {time}，累计观看：{watched}\n{link}"],
		["liveEnd", "{name} 下播了，直播时长 {duration}"],
		["dynamic", "{name}发布了一条动态：{url}"],
		["dynamicVideo", "{name}发布了新视频：{url}"],
	];
	const OLD_GUARD = {
		captain: "{user} 成为了 {mastername} 的舰长！",
		commander: "{user} 成为了 {mastername} 的提督！",
		governor: "{user} 成为了 {mastername} 的总督！",
	} as const;

	it.each(OLD_DEFAULTS)("%s 的旧默认 %j → 当前默认,其余键一个不动", (key, old) => {
		const input = { ...fresh, [key]: old };
		const migrated = migrateOldTemplateDefaults(input) as Record<string, unknown>;
		expect(migrated[key]).toBe(freshByKey[key]);
		expect({ ...migrated, [key]: null }).toEqual({ ...fresh, [key]: null });
		expect(migrateOldTemplateDefaults(migrated)).toEqual(migrated);
	});

	it.each(Object.entries(OLD_GUARD) as Array<[role: keyof typeof OLD_GUARD, old: string]>)(
		"上舰 %s 的旧默认 → 当前默认,另外两档不动",
		(role, old) => {
			const input = {
				...fresh,
				guardBuy: { ...fresh.guardBuy, [role]: { ...fresh.guardBuy[role], template: old } },
			};
			const migrated = migrateOldTemplateDefaults(input) as typeof input;
			expect(migrated.guardBuy[role]).toEqual(fresh.guardBuy[role]);
			expect({ ...migrated.guardBuy, [role]: null }).toEqual({ ...fresh.guardBuy, [role]: null });
			expect(migrateOldTemplateDefaults(migrated)).toEqual(migrated);
		},
	);

	it("自定义的值原样保留;不是字符串的、缺着的键不碰;入参不被就地改动", () => {
		const { dynamic: _dropped, ...rest } = fresh;
		const input = {
			...rest,
			liveStart: "我自定义的开播文案 {name}",
			liveEnd: 42,
			guardBuy: {
				...fresh.guardBuy,
				captain: { ...fresh.guardBuy.captain, template: "我自定义的舰长文案 {uname}" },
			},
		};
		const before = structuredClone(input);
		const migrated = migrateOldTemplateDefaults(input);
		expect(migrated).toEqual(before);
		expect(migrated).not.toHaveProperty("dynamic");
		expect(input).toEqual(before);
	});

	it("新形状(出厂配置的模板)原样不变", () => {
		expect(migrateOldTemplateDefaults(fresh)).toEqual(fresh);
	});

	it.each([
		["不是对象", null],
		["是数组", ["{name}发布了一条动态：{url}"]],
		["是字符串", "{name}发布了一条动态：{url}"],
	])("认不得的形状原样放过(%s)", (_name, raw) => {
		expect(migrateOldTemplateDefaults(raw)).toEqual(raw);
	});
});

// ── 整份 globals ─────────────────────────────────────────────────────────────────────
//
// 这一组没有 internal 里的对应用例:迁移函数各自的判定在上面钉过了,这里钉「整份 globals 把三处老形状一起迁」
// 与认不得的形状原样放过。推送特性那一项的整份用例在 `./features.test.ts`。

describe("整份 globals 迁移(ai / linkParsing / templates)", () => {
	/** 整份 globals,三处换成给定的老形状。 */
	function legacyGlobals() {
		const base = rawGlobals() as unknown as {
			defaults: { ai: Record<string, unknown>; templates: Record<string, unknown> };
			linkParsing: unknown;
		};
		const { providers: _providers, activeProfile: _activeProfile, ...ai } = base.defaults.ai;
		return {
			...base,
			defaults: {
				...base.defaults,
				ai: { ...ai, apiKey: "sk-old", baseUrl: "https://api.deepseek.com", model: "m" },
				templates: { ...base.defaults.templates, liveEnd: "{name} 下播了，直播时长 {duration}" },
			},
			linkParsing: { enabled: true, scope: "selected", targets: [{ targetId: A }] },
		};
	}

	it("三处老形状经整份 globals 一起迁,其余键一个不动,迁完整份能过 schema", () => {
		const input = legacyGlobals();
		const migrated = migrateGlobals(input) as typeof input;

		expectMigratedAiShape(migrated.defaults.ai);
		expect(migrated.defaults.ai).toMatchObject({
			activeProfile: "custom",
			providers: { custom: { provider: "custom", apiKey: "sk-old", model: "m" } },
		});
		expect(migrated.linkParsing).toEqual({
			enabled: true,
			defaults: { parse: false, form: "image" },
			groups: { [A]: { parse: true } },
		});
		expect(migrated.defaults.templates.liveEnd).toBe(makeZeroGlobals().defaults.templates.liveEnd);

		// 这三格之外的,迁移一个字不碰。
		const without = (g: typeof input) => ({
			...g,
			linkParsing: null,
			defaults: { ...g.defaults, ai: null, templates: null },
		});
		expect(without(migrated)).toEqual(without(input));

		expect(migrateGlobals(migrated)).toEqual(migrated);
		expect(GlobalConfigSchema.safeParse(migrateGlobalsToCurrent(migrated)).success).toBe(true);
	});

	it("0.9.1 的范围 + 白名单经整条流水线到五格:enabled 开、isOnByDefault 关、A 显式开;迁完没有 linkParsing,过 schema", () => {
		const out = migrateGlobalsToCurrent(legacyGlobals()) as Record<string, unknown>;
		expect(out).not.toHaveProperty("linkParsing");
		expect(out.linkPreview).toEqual({
			enabled: true,
			isOnByDefault: false,
			replyForm: "image",
			byTarget: { [A]: { isOn: true } },
		});
		expect(GlobalConfigSchema.parse(out).linkPreview).toEqual({
			...FRESH_LINK,
			enabled: true,
			isOnByDefault: false,
			byTarget: { [A]: { isOn: true } },
		});
	});

	it.each([
		["ai 不是对象", migrateAiSettings, null],
		["linkParsing 不是对象", migrateLegacyLinkParsing, 3],
		["linkParsing 是数组", migrateLegacyLinkParsing, [{ scope: "selected" }]],
		["linkParsing 是 null", migrateLegacyLinkParsing, null],
	] as const)("认不得的形状原样放过(%s)", (_name, migrate, raw) => {
		expect(migrate(raw)).toEqual(raw);
	});
});

/**
 * **历史保留天数换键、换档**(ADR-0022 决策 9 下 10-04 的 🔗):0.x 的 `app.historyRetentionDays`(1–365 任意整数)
 * 搬成顶层 `history.retentionDays`,值换算成七档 90 / 60 / 30 / 15 / 7 / 3 / 1 —— 不在选项里的往上取最近一档,
 * 超过 90 压成 90,缺了或读不懂按 0.x 的默认 30。
 */
describe("历史保留天数 → history.retentionDays(七档)", () => {
	const moved = (app: Record<string, unknown>) =>
		moveHistoryRetention({ app, master: {} }) as {
			app: Record<string, unknown>;
			history: { retentionDays: number };
		};

	it.each([
		[1, 1],
		[2, 3],
		[3, 3],
		[4, 7],
		[7, 7],
		[8, 15],
		[15, 15],
		[16, 30],
		[30, 30],
		[31, 60],
		[60, 60],
		[61, 90],
		[90, 90],
		[91, 90],
		[365, 90],
	])("老值 %i → %i", (old, next) => {
		expect(moved({ historyRetentionDays: old }).history.retentionDays).toBe(next);
	});

	it.each([
		["没写过", {}],
		["不是数", { historyRetentionDays: "30" }],
		["小于 1", { historyRetentionDays: 0 }],
		["不是整数的怪值", { historyRetentionDays: Number.NaN }],
	])("%s → 按默认 30", (_name, app) => {
		expect(moved(app).history.retentionDays).toBe(30);
	});

	it("老键从 `app` 里拿掉,`app` 里别的格一个字不动", () => {
		const out = moved({ logLevel: "debug", historyRetentionDays: 45, fansCron: "0 0 * * * *" });
		expect(out.app).toEqual({ logLevel: "debug", fansCron: "0 0 * * * *" });
		expect(out.history).toEqual({ retentionDays: 60 });
	});

	it("已经是新形状的原样回(同一个对象):迁两遍和迁一遍一样", () => {
		const current = { app: { logLevel: "info" }, history: { retentionDays: 7 } };
		expect(moveHistoryRetention(current)).toBe(current);
		const once = moveHistoryRetention({ app: { historyRetentionDays: 20 } });
		expect(moveHistoryRetention(once)).toEqual(once);
	});

	it.each([
		["不是对象", 3],
		["null", null],
		["数组", [{ app: {} }]],
	])("认不得的形状原样放过(%s)", (_name, raw) => {
		expect(moveHistoryRetention(raw)).toEqual(raw);
	});

	it("整条流水走完:0.x 的设置里是 45 天 → 1.0 的设置里 history.retentionDays 是 60,`app` 整个拆掉、`logging` 里没有老键,过得了 schema", () => {
		const zero = makeZeroGlobals();
		const out = migrateGlobalsToCurrent({
			...zero,
			app: { ...zero.app, historyRetentionDays: 45 },
		}) as { logging: Record<string, unknown>; history: unknown };
		expect(out.history).toEqual({ retentionDays: 60 });
		expect(out).not.toHaveProperty("app");
		expect(out.logging).not.toHaveProperty("historyRetentionDays");
		const parsed = GlobalConfigSchema.safeParse(out);
		expect(parsed.success).toBe(true);
		expect(parsed.data?.history.retentionDays).toBe(60);
	});
});

describe("search scene key migration", () => {
	it("moves search switches after AI is lifted without changing the input", () => {
		const raw = {
			defaults: {
				ai: {
					search: {
						backend: "tavily",
						keys: { bocha: "b", tavily: "t" },
						engines: { dynamic: true, live: false, roast: true },
					},
				},
			},
		};
		const before = structuredClone(raw);
		const out = migrateGlobalsToCurrent(raw) as { ai: { search: Record<string, unknown> } };
		expect(out.ai.search).toEqual({
			backend: "tavily",
			keys: { bocha: "b", tavily: "t" },
			scenes: { post: true, live: false, roast: true },
		});
		expect(raw).toEqual(before);
		expect(migrateGlobalsToCurrent(out)).toEqual(out);
	});
});

describe("search scene migration conflicts", () => {
	it.each([
		[
			{ engines: { dynamic: true, live: true }, scenes: { post: false } },
			{ scenes: { post: false } },
		],
		[{ engines: { dynamic: true }, scenes: {} }, { scenes: {} }],
		[{ engines: { dynamic: true }, scenes: null }, { scenes: null }],
		[{ engines: null }, { scenes: null }],
		[{ engines: false }, { scenes: false }],
		[{ engines: [true] }, { scenes: [true] }],
		[
			{ engines: { dynamic: null, live: false, extra: 7 } },
			{ scenes: { post: null, live: false, extra: 7 } },
		],
		[
			{ engines: { dynamic: true, post: false, roast: true } },
			{ scenes: { post: false, roast: true } },
		],
		[{ scenes: { dynamic: true, post: null } }, { scenes: { post: null } }],
		[{ keys: { bocha: "b", tavily: "t" } }, { keys: { bocha: "b", tavily: "t" } }],
	])("preserves explicit values and new-key precedence: %j", (search, expected) => {
		const raw = { ai: { search } };
		const before = structuredClone(raw);
		const out = migrateGlobalsToCurrent(raw) as { ai: { search: unknown } };
		expect(out.ai.search).toEqual(expected);
		expect(raw).toEqual(before);
		expect(migrateGlobalsToCurrent(out)).toEqual(out);
	});
	it.each([null, [], false, "broken"])("preserves malformed search for isolation: %j", (search) => {
		expect(migrateGlobalsToCurrent({ ai: { search } })).toMatchObject({ ai: { search } });
	});
});
