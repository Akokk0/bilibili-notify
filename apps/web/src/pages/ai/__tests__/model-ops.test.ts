/**
 * AI 设置页左栏的增删操作 —— 全是对 `AISettings` 草稿的纯变换。
 *
 * 之所以抽成纯函数而不是散在 `Ai.tsx` 的 setState 里:这里的分支恰恰是**最容易
 * 悄悄出错、又最难在界面上看出来**的那几处 —— 删掉正在用的那家之后指针指向哪、
 * 删到一家不剩会不会炸、新人格的 id 撞没撞上。
 */

import {
	AI_PROVIDER_IDS,
	BUILTIN_AI_PRESETS,
	EMPTY_AI_PROVIDER_PROFILE,
} from "@bilibili-notify/internal/constants";
import { describe, expect, it } from "vite-plus/test";
import type { AIPersona, AISettings } from "../../../types/globals";
import {
	addableProviders,
	addedProviders,
	addPersona,
	addProvider,
	duplicatePersona,
	globalPersonaRailId,
	isBuiltinPersona,
	missingBuiltinPersonas,
	personaAt,
	personaRailItems,
	removePersona,
	removeProvider,
	renamePersona,
	resolveEditingProvider,
	restoreBuiltinPersona,
	setGlobalPersona,
	setGlobalProvider,
	updatePersonaAt,
} from "../model-ops";

const PERSONA: AIPersona = {
	name: "",
	addressUser: "",
	addressSelf: "",
	traits: "",
	catchphrase: "",
	baseRole: "",
	extraSystemPrompt: "",
};

function settings(over: Partial<AISettings> = {}): AISettings {
	return {
		enabled: true,
		persona: PERSONA,
		dynamicPrompt: "",
		liveSummaryPrompt: "",
		provider: "custom",
		providers: {},
		presets: [],
		...over,
	};
}

describe("addedProviders", () => {
	it("只列已添加的那几家", () => {
		const ai = settings({
			providers: { deepseek: { ...EMPTY_AI_PROVIDER_PROFILE } },
		});
		expect(addedProviders(ai)).toEqual(["deepseek"]);
	});

	it("全新配置一家都没有 —— 左栏该是空的", () => {
		expect(addedProviders(settings())).toEqual([]);
	});

	it("顺序按注册表来,不随主人添加的先后跳动", () => {
		// 对象键序 = 插入序。照它渲染的话,主人先加硅基后加 OpenRouter,左栏就与
		// 「+ 添加服务商」清单里的顺序不一致;删掉再加回来还会自己换位置。
		const ai = settings({
			providers: {
				siliconflow: { ...EMPTY_AI_PROVIDER_PROFILE },
				openrouter: { ...EMPTY_AI_PROVIDER_PROFILE },
			},
		});
		const expected = AI_PROVIDER_IDS.filter((id) => id === "openrouter" || id === "siliconflow");
		expect(addedProviders(ai)).toEqual(expected);
	});
});

describe("addableProviders", () => {
	it("「+ 添加服务商」清单 = 还没添加过的那些", () => {
		const ai = settings({ providers: { deepseek: { ...EMPTY_AI_PROVIDER_PROFILE } } });
		expect(addableProviders(ai)).toEqual(AI_PROVIDER_IDS.filter((id) => id !== "deepseek"));
	});

	it("五家全加过 → 空清单(调用方据此禁用按钮)", () => {
		const providers = Object.fromEntries(
			AI_PROVIDER_IDS.map((id) => [id, { ...EMPTY_AI_PROVIDER_PROFILE }]),
		);
		expect(addableProviders(settings({ providers }))).toEqual([]);
	});
});

describe("addProvider", () => {
	it("建一个空桶", () => {
		const next = addProvider(settings(), "openrouter");
		expect(next.providers.openrouter).toEqual(EMPTY_AI_PROVIDER_PROFILE);
	});

	it("指针还没着落时(全新配置)→ 头一家添加的就成了在用的那家", () => {
		// 不这么做的话:主人添加了第一家、填好密钥,女仆却仍然「没配齐」,
		// 而界面上看不出还差一步。
		const next = addProvider(settings({ provider: "custom", providers: {} }), "openrouter");
		expect(next.provider).toBe("openrouter");
	});

	it("已经有在用的那家 → 再添加一家**不抢**指针", () => {
		// 添加 ≠ 换用。换用是「全局配置」里那个选择器的事(与人格同一套语义)。
		const ai = settings({
			provider: "deepseek",
			providers: { deepseek: { ...EMPTY_AI_PROVIDER_PROFILE, apiKey: "sk-ds" } },
		});
		expect(addProvider(ai, "openrouter").provider).toBe("deepseek");
	});

	it("不动别家已填好的桶", () => {
		const ai = settings({
			provider: "deepseek",
			providers: { deepseek: { ...EMPTY_AI_PROVIDER_PROFILE, apiKey: "sk-ds" } },
		});
		const next = addProvider(ai, "openrouter");
		expect(next.providers.deepseek?.apiKey).toBe("sk-ds");
	});

	it("重复添加同一家**不覆盖**它已有的配置", () => {
		// 界面上不会把已添加的那家摆进清单,但这条是数据安全底线 —— 一旦哪天
		// 清单算错、或者两处入口撞上,拿空档案盖掉主人填好的 key 是不可逆的。
		const ai = settings({
			provider: "custom",
			providers: { deepseek: { ...EMPTY_AI_PROVIDER_PROFILE, apiKey: "sk-ds", model: "ds-v4" } },
		});
		const next = addProvider(ai, "deepseek");
		expect(next.providers.deepseek).toMatchObject({ apiKey: "sk-ds", model: "ds-v4" });
	});

	it("不改原对象", () => {
		const ai = settings();
		addProvider(ai, "openrouter");
		expect(ai.providers).toEqual({});
		expect(ai.provider).toBe("custom");
	});
});

describe("setGlobalProvider —— 「设为默认」拨的就是这个指针", () => {
	it("拨到另一家", () => {
		const ai = settings({
			provider: "deepseek",
			providers: { deepseek: EMPTY_AI_PROVIDER_PROFILE, openrouter: EMPTY_AI_PROVIDER_PROFILE },
		});
		expect(setGlobalProvider(ai, "openrouter").provider).toBe("openrouter");
	});

	it("拨到一家没添加过的 → 不动", () => {
		// 指向一个不存在的桶就是悬空引用:界面上左栏没有它、`resolveAIProfile`
		// 兜一套空档案,于是女仆静默停工而主人以为选好了。
		const ai = settings({
			provider: "deepseek",
			providers: { deepseek: EMPTY_AI_PROVIDER_PROFILE },
		});
		expect(setGlobalProvider(ai, "openrouter").provider).toBe("deepseek");
	});

	it("不改原对象", () => {
		const ai = settings({
			provider: "deepseek",
			providers: { deepseek: EMPTY_AI_PROVIDER_PROFILE, openrouter: EMPTY_AI_PROVIDER_PROFILE },
		});
		setGlobalProvider(ai, "openrouter");
		expect(ai.provider).toBe("deepseek");
	});
});

describe("resolveEditingProvider —— 左栏在看哪一家", () => {
	const both = settings({
		provider: "deepseek",
		providers: { deepseek: EMPTY_AI_PROVIDER_PROFILE, openrouter: EMPTY_AI_PROVIDER_PROFILE },
	});

	it("看着一家真实存在的 → 原样", () => {
		expect(resolveEditingProvider(both, "openrouter")).toBe("openrouter");
	});

	it("还没选过(刚进页面)→ 落在女仆正用的那家", () => {
		expect(resolveEditingProvider(both, null)).toBe("deepseek");
	});

	it("正看着的那家被删掉了 → 收回到在用的那家,不让左栏高亮到虚空", () => {
		const ai = settings({
			provider: "deepseek",
			providers: { deepseek: EMPTY_AI_PROVIDER_PROFILE },
		});
		expect(resolveEditingProvider(ai, "openrouter")).toBe("deepseek");
	});

	it("连在用的那家都没添加过 → 落到注册表序第一家(不是对象键序)", () => {
		// 键序先写 deepseek,注册表里 openrouter 在前 —— 左栏就是按注册表渲染的,
		// 这里跟着它才不会「高亮项与右侧内容各说各话」。
		const ai = settings({
			provider: "custom",
			providers: { deepseek: EMPTY_AI_PROVIDER_PROFILE, openrouter: EMPTY_AI_PROVIDER_PROFILE },
		});
		expect(resolveEditingProvider(ai, null)).toBe("openrouter");
	});

	it("一家都没添加 → null(右侧该出添加面板,不是一组空框子)", () => {
		expect(resolveEditingProvider(settings(), null)).toBeNull();
	});
});

describe("removeProvider", () => {
	/** 三家都添加过,当前用 deepseek。 */
	function three(): AISettings {
		return settings({
			provider: "deepseek",
			providers: {
				openrouter: { ...EMPTY_AI_PROVIDER_PROFILE, apiKey: "sk-or" },
				deepseek: { ...EMPTY_AI_PROVIDER_PROFILE, apiKey: "sk-ds" },
				siliconflow: { ...EMPTY_AI_PROVIDER_PROFILE, apiKey: "sk-sf" },
			},
		});
	}

	it("桶真的没了 —— 不是留着一个空壳", () => {
		// 留空壳的话左栏还会列着它(addedProviders 看的是「键存不存在」),
		// 而且落盘时 collectAiSecrets 仍会去看它一眼。
		const next = removeProvider(three(), "siliconflow");
		expect("siliconflow" in next.providers).toBe(false);
	});

	it("删掉不在用的那家,指针不动", () => {
		expect(removeProvider(three(), "siliconflow").provider).toBe("deepseek");
	});

	it("删掉**正在用**的那家 → 指针落到剩下的第一家(注册表序)", () => {
		const next = removeProvider(three(), "deepseek");
		expect(next.provider).toBe("openrouter");
		// 而且落在一个**真实存在**的桶上,不是随手指个名字。
		expect(next.providers[next.provider]).toBeDefined();
	});

	it("剩下的第一家按注册表序,不按对象键序", () => {
		// 键序是「硅基先、OpenRouter 后」,注册表序反过来。照键序取就会指向硅基,
		// 与左栏第一项(注册表序渲染)对不上 —— 删完之后高亮项和内容各说各话。
		const ai = settings({
			provider: "deepseek",
			providers: {
				siliconflow: { ...EMPTY_AI_PROVIDER_PROFILE },
				openrouter: { ...EMPTY_AI_PROVIDER_PROFILE },
				deepseek: { ...EMPTY_AI_PROVIDER_PROFILE },
			},
		});
		expect(removeProvider(ai, "deepseek").provider).toBe("openrouter");
	});

	it("删到一家不剩:不炸,指针原样留着", () => {
		// 指针成了悬空引用 —— 这是**允许**的:resolveAIProfile 明确兜一套空默认值,
		// 页面据此显示空态、引擎据此判定「没配齐」而停用 AI。硬改成 'custom' 反而是
		// 撒谎(custom 也没添加),还会让主人重新添加同一家时指针莫名跑掉。
		const ai = settings({
			provider: "deepseek",
			providers: { deepseek: { ...EMPTY_AI_PROVIDER_PROFILE } },
		});
		const next = removeProvider(ai, "deepseek");
		expect(next.providers).toEqual({});
		expect(next.provider).toBe("deepseek");
	});

	it("删一家没添加过的 → 原样返回,不凭空造出别的变化", () => {
		const ai = three();
		expect(removeProvider(ai, "volcengine")).toEqual(ai);
	});

	it("不改原对象", () => {
		const ai = three();
		removeProvider(ai, "deepseek");
		expect(Object.keys(ai.providers).sort()).toEqual(["deepseek", "openrouter", "siliconflow"]);
		expect(ai.provider).toBe("deepseek");
	});
});

// ── 人格左栏 ────────────────────────────────────────────────────────────
//
// 人格只住在 `presets[]` 里,`activePreset` 指着全局用的那一份。曾经还有个「默认」项
// 对应 `ai.persona` —— 但它与 `presets[0]`「温柔女仆」本就是同一份东西,摆两个入口是
// 重复。schema 那边的迁移保证 presets 恒非空、指针恒有着落
// (见 packages/internal/src/schema/ai-persona-pointer.test.ts)。

const TSUNDERE: AIPersona = { ...PERSONA, name: "傲娇", traits: "毒舌" };

function withPresets(...labels: string[]): AISettings {
	return settings({
		presets: labels.map((label, i) => ({
			id: `p${i}`,
			label,
			persona: { ...PERSONA, name: label },
		})),
	});
}

describe("personaRailItems", () => {
	it("左栏就是人格清单本身,没有多余的「默认」项", () => {
		expect(personaRailItems(withPresets("温柔女仆", "傲娇毒舌")).map((i) => i.label)).toEqual([
			"温柔女仆",
			"傲娇毒舌",
		]);
	});

	it("带上原始 preset id —— 调用方查图标要用,不该自己去切前缀", () => {
		expect(personaRailItems(withPresets("温柔女仆"))[0]).toMatchObject({
			id: "preset:p0",
			presetId: "p0",
		});
	});

	it("没起名的显示占位,而不是渲染成一条空白行", () => {
		const ai = settings({ presets: [{ id: "x", label: "", persona: PERSONA }] });
		expect(personaRailItems(ai)[0]?.label).toBe("(未命名)");
	});
});

describe("personaAt —— 右侧编辑的是谁", () => {
	const ai = settings({
		dynamicPrompt: "全局动态",
		liveSummaryPrompt: "全局总结",
		presets: [
			{ id: "tsundere", label: "傲娇", persona: TSUNDERE, dynamicPrompt: "傲娇动态" },
			{ id: "maid", label: "女仆", persona: { ...PERSONA, name: "小绫" } },
		],
	});

	it("选哪一份就编辑哪一份", () => {
		expect(personaAt(ai, "preset:maid").persona.name).toBe("小绫");
		expect(personaAt(ai, "preset:tsundere").persona.name).toBe("傲娇");
	});

	it("预设没写的那段 prompt 显示为空,而不是把全局那段搬过来充数", () => {
		// prompt 是 optional:undefined = 用全局那份(见 resolve() 的 ?? 链)。把全局
		// 文案填进输入框的话,主人一保存就把它坐实成一份副本,此后改全局再也带不动它,
		// 而界面上完全看不出发生了这件事。
		expect(personaAt(ai, "preset:tsundere").liveSummaryPrompt).toBe("");
		expect(personaAt(ai, "preset:tsundere").dynamicPrompt).toBe("傲娇动态");
	});

	it("指向一份不存在的(刚被删掉)→ 收回第一份,不炸", () => {
		expect(personaAt(ai, "preset:gone").persona.name).toBe("傲娇");
	});
});

describe("updatePersonaAt —— 编辑落在谁身上", () => {
	// 刻意用**非内置**的 id:内置那几份是只读的(见下面「内置的改不动」),
	// 这一组测的是自建人格的编辑路径。
	function base(): AISettings {
		return settings({
			persona: { ...PERSONA, name: "遗留的" },
			presets: [
				{ id: "mine-a", label: "傲娇", persona: TSUNDERE, dynamicPrompt: "傲娇动态" },
				{ id: "mine-b", label: "女仆", persona: { ...PERSONA, name: "小绫" } },
			],
		});
	}

	it("改的是选中那一份,别的一根毛都不动", () => {
		const next = updatePersonaAt(base(), "preset:mine-a", {
			persona: { ...TSUNDERE, name: "改了" },
		});
		expect(next.presets[0]?.persona.name).toBe("改了");
		expect(next.presets[1]?.persona.name).toBe("小绫");
	});

	it("**不碰** ai.persona —— 它已经没有界面入口,只是 resolve() 的安全网", () => {
		const next = updatePersonaAt(base(), "preset:mine-a", {
			persona: { ...TSUNDERE, name: "改了" },
		});
		expect(next.persona.name).toBe("遗留的");
	});

	it("prompt 清空 → 存回 undefined,也就是恢复「用全局那份」", () => {
		// 存成 "" 的话 resolve() 里的 `?? ` 不会再落到全局(空串不是 nullish),
		// 该预设从此强制发一段**空** prompt。
		expect(
			updatePersonaAt(base(), "preset:mine-a", { dynamicPrompt: "" }).presets[0]?.dynamicPrompt,
		).toBeUndefined();
	});

	it("prompt 填了字就照存", () => {
		const next = updatePersonaAt(base(), "preset:mine-b", { liveSummaryPrompt: "女仆总结" });
		expect(next.presets[1]?.liveSummaryPrompt).toBe("女仆总结");
	});

	it("不改原对象", () => {
		const ai = base();
		updatePersonaAt(ai, "preset:mine-a", { persona: { ...TSUNDERE, name: "改了" } });
		expect(ai.presets[0]?.persona.name).toBe("傲娇");
	});
});

describe("addPersona", () => {
	it("追加一份空白人格,并把左栏 id 交回调用方切过去", () => {
		const { ai, railId } = addPersona(withPresets("温柔女仆"));
		expect(ai.presets).toHaveLength(2);
		expect(personaAt(ai, railId).persona).toEqual(PERSONA);
	});

	it("新人格的两段 prompt 是 undefined —— 一开始就用全局那份", () => {
		const { ai } = addPersona(withPresets("温柔女仆"));
		expect(ai.presets[1]?.dynamicPrompt).toBeUndefined();
		expect(ai.presets[1]?.liveSummaryPrompt).toBeUndefined();
	});

	it("id 挑的是**第一个空位**,不是「数一数有几份」", () => {
		// 只有一份、id 却是 persona-2 时,「presets.length + 1」正好也算出 persona-2,
		// 当场撞车。数量与编号本来就没有关系。
		const ai = settings({ presets: [{ id: "persona-2", label: "手写的", persona: PERSONA }] });
		expect(addPersona(ai).ai.presets[1]?.id).toBe("persona-1");
	});

	it("撞 id 会静默串台,所以必须跳过已占用的", () => {
		// per-UP overrides.ai.preset 指着那个 id,resolve() 用 find() 取第一个匹配 ——
		// 两份同 id 的预设永远只有前一份生效,主人改后一份怎么改都不生效。
		const ai = settings({
			presets: [
				{ id: "persona-1", label: "甲", persona: PERSONA },
				{ id: "persona-2", label: "乙", persona: PERSONA },
			],
		});
		expect(addPersona(ai).ai.presets[2]?.id).toBe("persona-3");
	});

	it("不改原对象", () => {
		const ai = withPresets("温柔女仆");
		addPersona(ai);
		expect(ai.presets).toHaveLength(1);
	});
});

describe("removePersona", () => {
	it("删掉一份", () => {
		const next = removePersona(withPresets("甲", "乙"), "preset:p0");
		expect(next.presets.map((p) => p.label)).toEqual(["乙"]);
	});

	it("**最后一份删不掉** —— AI 总得有一份人格", () => {
		// 删空了右侧就没东西可显示,resolve() 也只能回落到那份界面上已无入口的 ai.persona。
		const ai = withPresets("就剩这一份");
		expect(removePersona(ai, "preset:p0")).toEqual(ai);
	});

	it("删掉正被全局用着的那份 → 指针落到剩下的第一份", () => {
		const ai = { ...withPresets("甲", "乙"), activePreset: "p0" };
		expect(removePersona(ai, "preset:p0").activePreset).toBe("p1");
	});

	it("删掉**不是**正用着的那份 → 指针不动", () => {
		const ai = { ...withPresets("甲", "乙"), activePreset: "p0" };
		expect(removePersona(ai, "preset:p1").activePreset).toBe("p0");
	});

	it("删一份不存在的 → 原样返回", () => {
		const ai = withPresets("甲", "乙");
		expect(removePersona(ai, "preset:gone")).toEqual(ai);
	});

	it("不改原对象", () => {
		const ai = withPresets("甲", "乙");
		removePersona(ai, "preset:p0");
		expect(ai.presets).toHaveLength(2);
	});
});

describe("renamePersona", () => {
	it("改名字,不动人格内容", () => {
		const next = renamePersona(withPresets("傲娇"), "preset:p0", "超傲娇");
		expect(next.presets[0]?.label).toBe("超傲娇");
		expect(next.presets[0]?.persona.name).toBe("傲娇");
	});
});

describe("全局人格指针", () => {
	it("没设指针 → 落在第一份(schema 迁移保证它是「温柔女仆」)", () => {
		expect(globalPersonaRailId(withPresets("温柔女仆", "傲娇"))).toBe("preset:p0");
	});

	it("设为某份 → 指针记下它的 id,而**不是**把它复制进 ai.persona", () => {
		// 旧界面正是靠复制来表达选中的:一下就把主人手写的全局人格盖掉且换不回来。
		const ai = { ...withPresets("甲", "乙"), persona: { ...PERSONA, name: "遗留的" } };
		const next = setGlobalPersona(ai, "preset:p1");
		expect(next.activePreset).toBe("p1");
		expect(next.persona.name).toBe("遗留的");
		expect(globalPersonaRailId(next)).toBe("preset:p1");
	});

	it("指针指着一份已被删掉的 → 读回第一份,不让左栏高亮到虚空", () => {
		expect(globalPersonaRailId({ ...withPresets("甲", "乙"), activePreset: "gone" })).toBe(
			"preset:p0",
		);
	});

	it("不改原对象", () => {
		const ai = withPresets("甲", "乙");
		setGlobalPersona(ai, "preset:p1");
		expect(ai.activePreset).toBeUndefined();
	});
});

// ── 内置人格:只读的参照库 ──────────────────────────────────────────────
//
// 内置那四份在界面上**锁死**:可以删、可以「从内置修改」另存一份可改的副本,但不能
// 就地改 —— 改花了「从内置恢复」就没有一个稳定的东西可恢复了。判据是 **id**,不是
// 内容:按内容判会出现「同样是傲娇毒舌,这份能改那份不能」的怪事。

describe("isBuiltinPersona", () => {
	it("内置四份都算", () => {
		for (const p of BUILTIN_AI_PRESETS) expect(isBuiltinPersona(p.id)).toBe(true);
	});

	it("主人自己加的不算", () => {
		expect(isBuiltinPersona("persona-1")).toBe(false);
		expect(isBuiltinPersona("custom-persona")).toBe(false);
	});
});

describe("内置的改不动", () => {
	function withBuiltin(): AISettings {
		return settings({
			presets: BUILTIN_AI_PRESETS.map((p) => ({ ...p, persona: { ...p.persona } })),
		});
	}

	it("编辑内置人格是空操作 —— 界面禁掉了,这里是第二道闸", () => {
		const ai = withBuiltin();
		const next = updatePersonaAt(ai, "preset:tsundere", {
			persona: { ...PERSONA, name: "改了" },
		});
		expect(next).toEqual(ai);
	});

	it("给内置人格改名也不行", () => {
		const ai = withBuiltin();
		expect(renamePersona(ai, "preset:tsundere", "别的名")).toEqual(ai);
	});

	it("但删得掉 —— 主人不想要就该能拿走", () => {
		expect(removePersona(withBuiltin(), "preset:tsundere").presets.map((p) => p.id)).not.toContain(
			"tsundere",
		);
	});

	it("自己加的照旧能改", () => {
		const { ai } = addPersona(withBuiltin());
		const next = updatePersonaAt(ai, "preset:persona-1", {
			persona: { ...PERSONA, name: "改了" },
		});
		expect(next.presets.find((p) => p.id === "persona-1")?.persona.name).toBe("改了");
	});
});

describe("missingBuiltinPersonas —— 「从内置恢复」列什么", () => {
	it("一份没删时是空的(按钮该收起来)", () => {
		const ai = settings({ presets: BUILTIN_AI_PRESETS.map((p) => ({ ...p })) });
		expect(missingBuiltinPersonas(ai)).toEqual([]);
	});

	it("只列被删掉的那几份", () => {
		const ai = settings({
			presets: BUILTIN_AI_PRESETS.filter((p) => p.id !== "tsundere").map((p) => ({ ...p })),
		});
		expect(missingBuiltinPersonas(ai).map((p) => p.id)).toEqual(["tsundere"]);
	});
});

describe("restoreBuiltinPersona", () => {
	function without(...ids: string[]): AISettings {
		return settings({
			presets: [
				...BUILTIN_AI_PRESETS.filter((p) => !ids.includes(p.id)).map((p) => ({ ...p })),
				{ id: "mine", label: "我的", persona: PERSONA },
			],
		});
	}

	it("把内置那份原样加回来,内容与注册表一致", () => {
		const { ai } = restoreBuiltinPersona(without("tsundere"), "tsundere");
		const back = ai.presets.find((p) => p.id === "tsundere");
		expect(back).toEqual(BUILTIN_AI_PRESETS.find((p) => p.id === "tsundere"));
	});

	it("插回它在内置清单里的原位,而不是甩到末尾", () => {
		// 恢复完排在自建人格后头会让清单看起来乱了套 —— 内置那几份该始终保持注册表序。
		const { ai } = restoreBuiltinPersona(without("tsundere"), "tsundere");
		expect(ai.presets.map((p) => p.id)).toEqual([
			"gentle-maid",
			"tsundere",
			"analyst",
			"genki",
			"mine",
		]);
	});

	it("交回左栏 id,好当场切过去", () => {
		const { ai, railId } = restoreBuiltinPersona(without("genki"), "genki");
		expect(personaAt(ai, railId).persona.name).toBe("小阳");
	});

	it("已经在清单里就原样返回,不造重复项", () => {
		const ai = without();
		expect(restoreBuiltinPersona(ai, "tsundere").ai).toEqual(ai);
	});

	it("不改原对象", () => {
		const ai = without("tsundere");
		restoreBuiltinPersona(ai, "tsundere");
		expect(ai.presets.map((p) => p.id)).not.toContain("tsundere");
	});
});

describe("duplicatePersona —— 「从内置修改」", () => {
	function withBuiltin(): AISettings {
		return settings({
			presets: BUILTIN_AI_PRESETS.map((p) => ({ ...p, persona: { ...p.persona } })),
		});
	}

	it("另存一份**可改**的副本", () => {
		const { ai, railId } = duplicatePersona(withBuiltin(), "preset:tsundere");
		const copyId = railId.replace("preset:", "");
		expect(isBuiltinPersona(copyId)).toBe(false);
		const edited = updatePersonaAt(ai, railId, { persona: { ...PERSONA, name: "我的傲娇" } });
		expect(personaAt(edited, railId).persona.name).toBe("我的傲娇");
	});

	it("内容照抄原件", () => {
		const { ai, railId } = duplicatePersona(withBuiltin(), "preset:tsundere");
		const src = BUILTIN_AI_PRESETS.find((p) => p.id === "tsundere");
		expect(personaAt(ai, railId).persona).toEqual(src?.persona);
	});

	it("名字带个后缀,好与原件区分", () => {
		const { ai, railId } = duplicatePersona(withBuiltin(), "preset:tsundere");
		const copy = ai.presets.find((p) => `preset:${p.id}` === railId);
		expect(copy?.label).toBe("傲娇毒舌 副本");
	});

	it("原件一根毛都不动", () => {
		const { ai } = duplicatePersona(withBuiltin(), "preset:tsundere");
		expect(ai.presets.find((p) => p.id === "tsundere")).toEqual(
			BUILTIN_AI_PRESETS.find((p) => p.id === "tsundere"),
		);
	});

	it("副本与原件**不共享**任何可变对象", () => {
		// 别名本身就是缺陷,所以这里断言的是「不是同一个对象」而不是某次改动的结果:
		// 当前写路径(updatePersonaAt)整体替换 persona,共享与否看不出差别 —— 但只要
		// 哪天有人图省事就地改一个字段,内置那份就当场被改花,而「锁死内置」正是为了
		// 不让这种事发生。这条测试守的是那个前提。
		const ai = withBuiltin();
		const { ai: next, railId } = duplicatePersona(ai, "preset:tsundere");
		const src = next.presets.find((p) => p.id === "tsundere");
		const copy = next.presets.find((p) => `preset:${p.id}` === railId);
		expect(copy?.persona).toEqual(src?.persona);
		expect(copy?.persona).not.toBe(src?.persona);
		expect(copy).not.toBe(src);
	});

	it("复制一份不存在的 → 原样返回", () => {
		const ai = withBuiltin();
		expect(duplicatePersona(ai, "preset:gone").ai).toEqual(ai);
	});
});
