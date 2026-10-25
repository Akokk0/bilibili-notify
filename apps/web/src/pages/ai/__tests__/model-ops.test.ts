/**
 * AI 设置页左栏的增删操作 —— 全是对 `AISettings` 草稿的纯变换。
 *
 * 之所以抽成纯函数而不是散在 `Ai.tsx` 的 setState 里:这里的分支恰恰是**最容易
 * 悄悄出错、又最难在界面上看出来**的那几处 —— 删掉正在用的那家之后指针指向哪、
 * 删到一家不剩会不会炸、新人格的 id 撞没撞上。
 */

import { type AIProviderId, EMPTY_AI_PROVIDER_PROFILE } from "@bilibili-notify/internal/ai";
import { BUILTIN_PRESET_IDS, builtinPresetsFor } from "@bilibili-notify/internal/builtin-texts";
import { buildPatch } from "@bilibili-notify/internal/patch";
import { describe, expect, it } from "vite-plus/test";
import type { AIPersona, AISettings } from "../../../types/globals";
import {
	addPersona,
	addProfile,
	duplicatePersona,
	globalPersonaRailId,
	isBuiltinPersona,
	missingBuiltinPersonas,
	personaAt,
	personaRailItems,
	profileRailItems,
	removePersona,
	removeProfile,
	renamePersona,
	renameProfile,
	resolveEditingProfile,
	restoreBuiltinPersona,
	setActiveProfile,
	setGlobalPersona,
	updatePersonaAt,
} from "../model-ops";

// 内置人格每次按当前语言取,设置里不存(ADR-0037 决策 11)
const BUILTINS = builtinPresetsFor("zh-CN");

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
		activeProfile: "",
		providers: {},
		chat: {},
		search: {
			backend: "bocha",
			keys: { bocha: "", tavily: "" },
			engines: { dynamic: false, live: false, roast: false },
		},
		writing: {
			post: { isOnByDefault: true, byTarget: {} },
			liveSummary: { isOnByDefault: true, byTarget: {} },
		},
		presets: [],
		...over,
	};
}

/** 一只属于某家的实例桶。 */
function bucket(provider: AIProviderId, over: Partial<AISettings["providers"][string]> = {}) {
	return { ...EMPTY_AI_PROVIDER_PROFILE, provider, ...over };
}

describe("profileRailItems —— 左栏列什么", () => {
	it("只列已添加的实例,显示名空着就用注册表里那家的名字", () => {
		const ai = settings({ providers: { deepseek: bucket("deepseek") } });
		expect(profileRailItems(ai)).toEqual([
			{ id: "deepseek", provider: "deepseek", label: "DeepSeek" },
		]);
	});

	it("起过名的显示自己的名字", () => {
		const ai = settings({ providers: { deepseek: bucket("deepseek", { label: "备用号" }) } });
		expect(profileRailItems(ai)[0]?.label).toBe("备用号");
	});

	it("全新配置一份都没有 —— 左栏该是空的", () => {
		expect(profileRailItems(settings())).toEqual([]);
	});

	it("按注册表序分家排,同家内按添加先后", () => {
		// 纯对象键序的话,主人先加硅基后加 OpenRouter,左栏就与「+ 添加服务商」
		// 清单里的顺序不一致;删掉再加回来还会自己换位置。
		const ai = settings({
			providers: {
				"deepseek-2": bucket("deepseek", { label: "乙" }),
				openrouter: bucket("openrouter"),
				deepseek: bucket("deepseek", { label: "甲" }),
			},
		});
		expect(profileRailItems(ai).map((i) => i.id)).toEqual(["openrouter", "deepseek-2", "deepseek"]);
	});
});

describe("addProfile", () => {
	it("建一只空桶,盖上 provider 章,把新实例 id 交回调用方切过去", () => {
		const { ai, id } = addProfile(settings(), "openrouter");
		expect(id).toBe("openrouter");
		expect(ai.providers.openrouter).toEqual({
			...EMPTY_AI_PROVIDER_PROFILE,
			provider: "openrouter",
		});
	});

	it("指针还没着落时(全新配置)→ 头一份添加的就成了在用的那份", () => {
		// 不这么做的话:主人添加了第一份、填好密钥,女仆却仍然「没配齐」,
		// 而界面上看不出还差一步。
		const { ai } = addProfile(settings(), "openrouter");
		expect(ai.activeProfile).toBe("openrouter");
	});

	it.each(["constructor", "toString", "__proto__"])(
		"指针是原型名 %s(表里没有这一家)→ 算没着落,头一份添加的成了在用的那份",
		(name) => {
			// 下标直读会从原型上摸到内置函数、当成「指针有着落」,新加的第一家就不会被用上。
			const { ai } = addProfile(settings({ activeProfile: name }), "openrouter");
			expect(ai.activeProfile).toBe("openrouter");
		},
	);

	it("已经有在用的那份 → 再添加**不抢**指针", () => {
		// 添加 ≠ 换用。换用是「全局配置」里那个选择器的事(与人格同一套语义)。
		const base = settings({
			activeProfile: "deepseek",
			providers: { deepseek: bucket("deepseek", { apiKey: "sk-ds" }) },
		});
		expect(addProfile(base, "openrouter").ai.activeProfile).toBe("deepseek");
	});

	it("同一家再添加一份 → 新实例 id 带序号,默认名也带序号好区分", () => {
		// 这正是分实例的意义:两个 DeepSeek 号并存。左栏两行都叫「DeepSeek」的话,
		// 主人分不清哪只是哪只。
		const base = settings({
			activeProfile: "deepseek",
			providers: { deepseek: bucket("deepseek", { apiKey: "sk-a" }) },
		});
		const { ai, id } = addProfile(base, "deepseek");
		expect(id).toBe("deepseek-2");
		expect(ai.providers["deepseek-2"]).toMatchObject({ provider: "deepseek", label: "DeepSeek 2" });
		// 原来那份一根毛都不动。
		expect(ai.providers.deepseek?.apiKey).toBe("sk-a");
	});

	it("id 挑第一个空位,跳过已占用的", () => {
		const base = settings({
			providers: {
				deepseek: bucket("deepseek"),
				"deepseek-2": bucket("deepseek"),
			},
		});
		expect(addProfile(base, "deepseek").id).toBe("deepseek-3");
	});

	it("不改原对象", () => {
		const ai = settings();
		addProfile(ai, "openrouter");
		expect(ai.providers).toEqual({});
		expect(ai.activeProfile).toBe("");
	});
});

describe("setActiveProfile —— 「设为默认」拨的就是这个指针", () => {
	it("拨到另一份", () => {
		const ai = settings({
			activeProfile: "deepseek",
			providers: { deepseek: bucket("deepseek"), "deepseek-2": bucket("deepseek") },
		});
		expect(setActiveProfile(ai, "deepseek-2").activeProfile).toBe("deepseek-2");
	});

	it("拨到一份没添加过的 → 不动", () => {
		// 指向一个不存在的桶就是悬空引用:界面上左栏没有它、`resolveAIProfile`
		// 兜一套空档案,于是女仆静默停工而主人以为选好了。
		const ai = settings({
			activeProfile: "deepseek",
			providers: { deepseek: bucket("deepseek") },
		});
		expect(setActiveProfile(ai, "openrouter").activeProfile).toBe("deepseek");
	});

	it("不改原对象", () => {
		const ai = settings({
			activeProfile: "deepseek",
			providers: { deepseek: bucket("deepseek"), openrouter: bucket("openrouter") },
		});
		setActiveProfile(ai, "openrouter");
		expect(ai.activeProfile).toBe("deepseek");
	});
});

describe("renameProfile", () => {
	it("改显示名,不动配置", () => {
		const ai = settings({
			providers: { deepseek: bucket("deepseek", { apiKey: "sk-ds" }) },
		});
		const next = renameProfile(ai, "deepseek", "主号");
		expect(next.providers.deepseek).toMatchObject({ label: "主号", apiKey: "sk-ds" });
	});

	it("清空名字 → 显示名回落到注册表里那家的名字", () => {
		const ai = settings({
			providers: { deepseek: bucket("deepseek", { label: "主号" }) },
		});
		const next = renameProfile(ai, "deepseek", "");
		expect(profileRailItems(next)[0]?.label).toBe("DeepSeek");
	});

	it("改一份不存在的 → 原样返回", () => {
		const ai = settings({ providers: { deepseek: bucket("deepseek") } });
		expect(renameProfile(ai, "gone", "x")).toEqual(ai);
	});
});

describe("resolveEditingProfile —— 左栏在看哪一份", () => {
	const both = settings({
		activeProfile: "deepseek",
		providers: { deepseek: bucket("deepseek"), openrouter: bucket("openrouter") },
	});

	it("看着一份真实存在的 → 原样", () => {
		expect(resolveEditingProfile(both, "openrouter")).toBe("openrouter");
	});

	it("还没选过(刚进页面)→ 落在女仆正用的那份", () => {
		expect(resolveEditingProfile(both, null)).toBe("deepseek");
	});

	it("正看着的那份被删掉了 → 收回到在用的那份,不让左栏高亮到虚空", () => {
		const ai = settings({
			activeProfile: "deepseek",
			providers: { deepseek: bucket("deepseek") },
		});
		expect(resolveEditingProfile(ai, "openrouter")).toBe("deepseek");
	});

	it("连在用的那份都没添加过 → 落到左栏第一项(注册表序分家,不是对象键序)", () => {
		const ai = settings({
			activeProfile: "gone",
			providers: { deepseek: bucket("deepseek"), openrouter: bucket("openrouter") },
		});
		expect(resolveEditingProfile(ai, null)).toBe("openrouter");
	});

	it("一份都没添加 → null(右侧该出添加面板,不是一组空框子)", () => {
		expect(resolveEditingProfile(settings(), null)).toBeNull();
	});
});

describe("removeProfile", () => {
	/** 三份实例(两只 DeepSeek + 一只 OpenRouter),当前用 deepseek。 */
	function three(): AISettings {
		return settings({
			activeProfile: "deepseek",
			providers: {
				"deepseek-2": bucket("deepseek", { apiKey: "sk-b" }),
				deepseek: bucket("deepseek", { apiKey: "sk-a" }),
				openrouter: bucket("openrouter", { apiKey: "sk-or" }),
			},
		});
	}

	it("桶真的没了 —— 不是留着一个空壳", () => {
		// 留空壳的话左栏还会列着它(profileRailItems 看的是「键存不存在」),
		// 而且落盘时 collectAiSecrets 仍会去看它一眼。
		const next = removeProfile(three(), "deepseek-2");
		expect("deepseek-2" in next.providers).toBe(false);
	});

	it("删掉不在用的那份,指针不动", () => {
		expect(removeProfile(three(), "deepseek-2").activeProfile).toBe("deepseek");
	});

	it("删掉**正在用**的那份 → 指针落到左栏剩下的第一项", () => {
		// 左栏按注册表序分家渲染(OpenRouter 在 DeepSeek 前),指针跟着它才不会
		// 「高亮项与右侧内容各说各话」。
		const next = removeProfile(three(), "deepseek");
		expect(next.activeProfile).toBe("openrouter");
		// 而且落在一个**真实存在**的桶上,不是随手指个名字。
		expect(next.providers[next.activeProfile]).toBeDefined();
	});

	it("删到一份不剩:不炸,指针原样留着", () => {
		// 指针成了悬空引用 —— 这是**允许**的:resolveAIProfile 明确兜一套空默认值,
		// 页面据此显示空态、引擎据此判定「没配齐」而停用 AI。
		const ai = settings({
			activeProfile: "deepseek",
			providers: { deepseek: bucket("deepseek") },
		});
		const next = removeProfile(ai, "deepseek");
		expect(next.providers).toEqual({});
		expect(next.activeProfile).toBe("deepseek");
	});

	it("删一份没添加过的 → 原样返回,不凭空造出别的变化", () => {
		const ai = three();
		expect(removeProfile(ai, "volcengine")).toEqual(ai);
	});

	it("不改原对象", () => {
		const ai = three();
		removeProfile(ai, "deepseek");
		expect(Object.keys(ai.providers).sort()).toEqual(["deepseek", "deepseek-2", "openrouter"]);
		expect(ai.activeProfile).toBe("deepseek");
	});
});

// ── 人格左栏 ────────────────────────────────────────────────────────────
//
// 左栏 = 没删的内置(内容取当前语言)+ 主人自己的 `presets[]`;`activePreset` 指着全局用的那一份。
// 设置里只记「删了哪几份内置」(`removedBuiltinPresets`,缺 = 一份没删)。
// 下面凡是只想测"主人自己的"那一支,用 `ownerOnly` 把四份内置都标成已删。

const TSUNDERE: AIPersona = { ...PERSONA, name: "傲娇", traits: "毒舌" };
const ALL_BUILTIN_IDS = [...BUILTIN_PRESET_IDS];

/** 只有主人自己的人格(四份内置都标成已删)。 */
function ownerOnly(...labels: string[]): AISettings {
	return settings({
		removedBuiltinPresets: ALL_BUILTIN_IDS,
		presets: labels.map((label, i) => ({
			id: `p${i}`,
			label,
			persona: { ...PERSONA, name: label },
		})),
	});
}

describe("personaRailItems", () => {
	it("左栏 = 没删的内置 + 主人自己的,内置在前", () => {
		const ai = settings({
			removedBuiltinPresets: ["tsundere"],
			presets: [{ id: "mine", label: "我的", persona: PERSONA }],
		});
		expect(personaRailItems(ai, BUILTINS).map((i) => i.presetId)).toEqual([
			"gentle-maid",
			"analyst",
			"genki",
			"mine",
		]);
	});

	it("缺 removedBuiltinPresets = 一份没删:四份内置全在", () => {
		expect(personaRailItems(settings(), BUILTINS).map((i) => i.presetId)).toEqual(ALL_BUILTIN_IDS);
	});

	it("内置的名字取传进来的(当前语言)那份", () => {
		const en = BUILTINS.map((p) => ({ ...p, label: `EN ${p.label}` }));
		expect(personaRailItems(settings(), en)[0]?.label).toBe("EN 温柔女仆");
	});

	it("带上原始 preset id —— 调用方查图标要用,不该自己去切前缀", () => {
		expect(personaRailItems(ownerOnly("温柔女仆"), BUILTINS)[0]).toMatchObject({
			id: "preset:p0",
			presetId: "p0",
		});
	});

	it("没起名的显示占位,而不是渲染成一条空白行", () => {
		const ai = settings({
			removedBuiltinPresets: ALL_BUILTIN_IDS,
			presets: [{ id: "x", label: "", persona: PERSONA }],
		});
		expect(personaRailItems(ai, BUILTINS)[0]?.label).toBe("(未命名)");
	});
});

describe("personaAt —— 右侧编辑的是谁", () => {
	const ai = settings({
		presets: [
			{ id: "mine-a", label: "傲娇", persona: TSUNDERE, dynamicPrompt: "傲娇动态" },
			{ id: "mine-b", label: "女仆", persona: { ...PERSONA, name: "小绫2" } },
		],
	});

	it("选哪一份就编辑哪一份", () => {
		expect(personaAt(ai, BUILTINS, "preset:mine-b").persona.name).toBe("小绫2");
		expect(personaAt(ai, BUILTINS, "preset:mine-a").persona.name).toBe("傲娇");
	});

	it("内置的内容取传进来的(当前语言)那份,两段 prompt 齐全", () => {
		const en = BUILTINS.map((p) => ({ ...p, dynamicPrompt: `EN ${p.dynamicPrompt}` }));
		expect(personaAt(ai, en, "preset:tsundere").dynamicPrompt).toBe(
			`EN ${BUILTINS[1]?.dynamicPrompt}`,
		);
		expect(personaAt(ai, BUILTINS, "preset:tsundere").persona.name).toBe("凛子");
	});

	it("主人那份没写的 prompt 显示为空,而不是把内置那段搬过来充数", () => {
		// prompt 是 optional:undefined = 用内置首份的那段。把它填进输入框的话,主人一保存
		// 就把「跟随」坐实成一份副本,而界面上完全看不出发生了这件事。
		expect(personaAt(ai, BUILTINS, "preset:mine-a").liveSummaryPrompt).toBe("");
		expect(personaAt(ai, BUILTINS, "preset:mine-a").dynamicPrompt).toBe("傲娇动态");
	});

	it("指向一份不存在的(刚被删掉)→ 收回左栏第一份,不炸", () => {
		expect(personaAt(ai, BUILTINS, "preset:gone").persona.name).toBe("小绫");
	});
});

describe("updatePersonaAt —— 编辑落在谁身上", () => {
	// 刻意用**非内置**的 id:内置那几份是只读的(见下面「内置的改不动」),
	// 这一组测的是自建人格的编辑路径。
	function base(): AISettings {
		return settings({
			presets: [
				{ id: "mine-a", label: "傲娇", persona: TSUNDERE, dynamicPrompt: "傲娇动态" },
				{ id: "mine-b", label: "女仆", persona: { ...PERSONA, name: "小绫" } },
			],
		});
	}

	it("改的是选中那一份,别的一根毛都不动", () => {
		const next = updatePersonaAt(base(), BUILTINS, "preset:mine-a", {
			persona: { ...TSUNDERE, name: "改了" },
		});
		expect(next.presets[0]?.persona.name).toBe("改了");
		expect(next.presets[1]?.persona.name).toBe("小绫");
	});

	it("prompt 清空 → 存回 undefined,也就是恢复「用内置首份的那段」", () => {
		// 存成 "" 的话读取处的 `??` 不会再落到内置(空串不是 nullish),
		// 该预设从此强制发一段**空** prompt。
		expect(
			updatePersonaAt(base(), BUILTINS, "preset:mine-a", { dynamicPrompt: "" }).presets[0]
				?.dynamicPrompt,
		).toBeUndefined();
	});

	it("prompt 填了字就照存", () => {
		const next = updatePersonaAt(base(), BUILTINS, "preset:mine-b", {
			liveSummaryPrompt: "女仆总结",
		});
		expect(next.presets[1]?.liveSummaryPrompt).toBe("女仆总结");
	});

	it("不改原对象", () => {
		const ai = base();
		updatePersonaAt(ai, BUILTINS, "preset:mine-a", { persona: { ...TSUNDERE, name: "改了" } });
		expect(ai.presets[0]?.persona.name).toBe("傲娇");
	});
});

describe("addPersona", () => {
	it("追加一份空白人格,并把左栏 id 交回调用方切过去", () => {
		const { ai, railId } = addPersona(ownerOnly("温柔女仆"));
		expect(ai.presets).toHaveLength(2);
		expect(personaAt(ai, BUILTINS, railId).persona).toEqual(PERSONA);
	});

	it("新人格的两段 prompt 是 undefined —— 一开始就用内置首份的那段", () => {
		const { ai } = addPersona(ownerOnly("温柔女仆"));
		expect(ai.presets[1]?.dynamicPrompt).toBeUndefined();
		expect(ai.presets[1]?.liveSummaryPrompt).toBeUndefined();
	});

	it("id 挑的是**第一个空位**,不是「数一数有几份」", () => {
		const ai = settings({ presets: [{ id: "persona-2", label: "手写的", persona: PERSONA }] });
		expect(addPersona(ai).ai.presets[1]?.id).toBe("persona-1");
	});

	it("撞 id 会静默串台,所以必须跳过已占用的", () => {
		// per-UP overrides.ai.preset 指着那个 id,读取处用 find() 取第一个匹配 ——
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
		const ai = ownerOnly("温柔女仆");
		addPersona(ai);
		expect(ai.presets).toHaveLength(1);
	});
});

describe("removePersona", () => {
	it("删掉主人自己的一份 = 从 presets 拿掉,不碰 removedBuiltinPresets", () => {
		const next = removePersona(ownerOnly("甲", "乙"), BUILTINS, "preset:p0");
		expect(next.presets.map((p) => p.label)).toEqual(["乙"]);
		expect(next.removedBuiltinPresets).toEqual(ALL_BUILTIN_IDS);
	});

	it("删掉一份内置 = 把它的 id 记进 removedBuiltinPresets,presets 不动", () => {
		const ai = settings({ presets: [{ id: "mine", label: "我的", persona: PERSONA }] });
		const next = removePersona(ai, BUILTINS, "preset:tsundere");
		expect(next.removedBuiltinPresets).toEqual(["tsundere"]);
		expect(next.presets).toEqual(ai.presets);
		expect(personaRailItems(next, BUILTINS).map((i) => i.presetId)).not.toContain("tsundere");
	});

	it("再删一份内置 → 两个 id 都在,且不重复", () => {
		const once = removePersona(settings(), BUILTINS, "preset:tsundere");
		const twice = removePersona(once, BUILTINS, "preset:genki");
		expect(twice.removedBuiltinPresets).toEqual(["tsundere", "genki"]);
	});

	it("**最后一份删不掉**按左栏总数算(没删的内置 + 主人的)—— AI 总得有一份人格", () => {
		const ai = ownerOnly("就剩这一份");
		expect(removePersona(ai, BUILTINS, "preset:p0")).toEqual(ai);
		// 只剩一份内置、主人也没有:同样删不掉
		const lastBuiltin = settings({ removedBuiltinPresets: ["gentle-maid", "tsundere", "analyst"] });
		expect(removePersona(lastBuiltin, BUILTINS, "preset:genki")).toEqual(lastBuiltin);
		// 内置只剩一份、主人有一份:总数是 2,删得掉
		const two = settings({
			removedBuiltinPresets: ["gentle-maid", "tsundere", "analyst"],
			presets: [{ id: "mine", label: "我的", persona: PERSONA }],
		});
		expect(removePersona(two, BUILTINS, "preset:genki").removedBuiltinPresets).toContain("genki");
	});

	it("删掉正被全局用着的那份 → 指针落到剩下的第一份", () => {
		const ai = { ...ownerOnly("甲", "乙"), activePreset: "p0" };
		expect(removePersona(ai, BUILTINS, "preset:p0").activePreset).toBe("p1");
		const builtin = { ...settings(), activePreset: "gentle-maid" };
		expect(removePersona(builtin, BUILTINS, "preset:gentle-maid").activePreset).toBe("tsundere");
	});

	it("删掉**不是**正用着的那份 → 指针不动", () => {
		const ai = { ...ownerOnly("甲", "乙"), activePreset: "p0" };
		expect(removePersona(ai, BUILTINS, "preset:p1").activePreset).toBe("p0");
	});

	it("删一份不存在的 → 原样返回", () => {
		const ai = ownerOnly("甲", "乙");
		expect(removePersona(ai, BUILTINS, "preset:gone")).toEqual(ai);
	});

	it("不改原对象", () => {
		const ai = settings();
		removePersona(ai, BUILTINS, "preset:tsundere");
		expect(ai.removedBuiltinPresets).toBeUndefined();
		const own = ownerOnly("甲", "乙");
		removePersona(own, BUILTINS, "preset:p0");
		expect(own.presets).toHaveLength(2);
	});
});

describe("renamePersona", () => {
	it("改名字,不动人格内容", () => {
		const next = renamePersona(ownerOnly("傲娇"), BUILTINS, "preset:p0", "超傲娇");
		expect(next.presets[0]?.label).toBe("超傲娇");
		expect(next.presets[0]?.persona.name).toBe("傲娇");
	});
});

describe("全局人格指针", () => {
	it("没设指针 → 落在左栏第一份(出厂默认的第一份是「温柔女仆」)", () => {
		expect(globalPersonaRailId(settings(), BUILTINS)).toBe("preset:gentle-maid");
		expect(globalPersonaRailId(ownerOnly("温柔女仆", "傲娇"), BUILTINS)).toBe("preset:p0");
	});

	it("设为某份 → 指针记下它的 id", () => {
		const next = setGlobalPersona(ownerOnly("甲", "乙"), BUILTINS, "preset:p1");
		expect(next.activePreset).toBe("p1");
		expect(globalPersonaRailId(next, BUILTINS)).toBe("preset:p1");
		expect(setGlobalPersona(settings(), BUILTINS, "preset:analyst").activePreset).toBe("analyst");
	});

	it("指针指着一份已被删掉的 → 读回第一份,不让左栏高亮到虚空", () => {
		expect(globalPersonaRailId({ ...ownerOnly("甲", "乙"), activePreset: "gone" }, BUILTINS)).toBe(
			"preset:p0",
		);
		expect(
			globalPersonaRailId(
				{ ...settings({ removedBuiltinPresets: ["tsundere"] }), activePreset: "tsundere" },
				BUILTINS,
			),
		).toBe("preset:gentle-maid");
	});

	it("不改原对象", () => {
		const ai = ownerOnly("甲", "乙");
		setGlobalPersona(ai, BUILTINS, "preset:p1");
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
		for (const p of BUILTINS) expect(isBuiltinPersona(p.id)).toBe(true);
	});

	it("主人自己加的不算", () => {
		expect(isBuiltinPersona("persona-1")).toBe(false);
		expect(isBuiltinPersona("custom-persona")).toBe(false);
	});
});

describe("内置的改不动", () => {
	it("编辑内置人格是空操作 —— 界面禁掉了,这里是第二道闸", () => {
		const ai = settings();
		const next = updatePersonaAt(ai, BUILTINS, "preset:tsundere", {
			persona: { ...PERSONA, name: "改了" },
		});
		expect(next).toEqual(ai);
	});

	it("给内置人格改名也不行", () => {
		const ai = settings();
		expect(renamePersona(ai, BUILTINS, "preset:tsundere", "别的名")).toEqual(ai);
	});

	it("但删得掉 —— 主人不想要就该能拿走", () => {
		const next = removePersona(settings(), BUILTINS, "preset:tsundere");
		expect(personaRailItems(next, BUILTINS).map((i) => i.presetId)).not.toContain("tsundere");
	});

	it("自己加的照旧能改", () => {
		const { ai } = addPersona(settings());
		const next = updatePersonaAt(ai, BUILTINS, "preset:persona-1", {
			persona: { ...PERSONA, name: "改了" },
		});
		expect(next.presets.find((p) => p.id === "persona-1")?.persona.name).toBe("改了");
	});
});

describe("missingBuiltinPersonas —— 「从内置恢复」列什么", () => {
	it("一份没删时是空的(按钮该收起来)", () => {
		expect(missingBuiltinPersonas(settings(), BUILTINS)).toEqual([]);
	});

	it("只列被删掉的那几份,按内置的顺序,名字取当前语言", () => {
		const ai = settings({ removedBuiltinPresets: ["genki", "tsundere"] });
		expect(missingBuiltinPersonas(ai, BUILTINS)).toEqual([
			{ id: "tsundere", label: "傲娇毒舌" },
			{ id: "genki", label: BUILTINS[3]?.label },
		]);
	});

	it("认不得的 id 不列", () => {
		expect(missingBuiltinPersonas(settings({ removedBuiltinPresets: ["nope"] }), BUILTINS)).toEqual(
			[],
		);
	});
});

describe("restoreBuiltinPersona", () => {
	it("从 removedBuiltinPresets 里拿掉它,左栏里它回到内置的原位", () => {
		const ai = settings({
			removedBuiltinPresets: ["tsundere"],
			presets: [{ id: "mine", label: "我的", persona: PERSONA }],
		});
		const { ai: next } = restoreBuiltinPersona(ai, "tsundere");
		expect(next.removedBuiltinPresets).toBeUndefined();
		expect(personaRailItems(next, BUILTINS).map((i) => i.presetId)).toEqual([
			"gentle-maid",
			"tsundere",
			"analyst",
			"genki",
			"mine",
		]);
	});

	it("还有别的没恢复的 → 只拿掉这一个", () => {
		const { ai } = restoreBuiltinPersona(
			settings({ removedBuiltinPresets: ["tsundere", "genki"] }),
			"tsundere",
		);
		expect(ai.removedBuiltinPresets).toEqual(["genki"]);
	});

	it("拿空了就删键 —— 草稿里没有这一键,存盘时下发 null(JSON Merge Patch 的删除)", () => {
		const before = settings({ removedBuiltinPresets: ["tsundere"] });
		const { ai } = restoreBuiltinPersona(before, "tsundere");
		expect("removedBuiltinPresets" in ai).toBe(false);
		expect(buildPatch({ ai }, { ai: before })).toMatchObject({
			ai: { removedBuiltinPresets: null },
		});
	});

	it("删一份内置再存盘:补丁里带 removedBuiltinPresets", () => {
		const before = settings();
		const next = removePersona(before, BUILTINS, "preset:tsundere");
		expect(buildPatch({ ai: next }, { ai: before })).toMatchObject({
			ai: { removedBuiltinPresets: ["tsundere"] },
		});
	});

	it("交回左栏 id,好当场切过去", () => {
		const { ai, railId } = restoreBuiltinPersona(
			settings({ removedBuiltinPresets: ["genki"] }),
			"genki",
		);
		expect(personaAt(ai, BUILTINS, railId).persona.name).toBe("小阳");
	});

	it("本来就没删的(或不认得的)→ 原样返回", () => {
		const ai = settings();
		expect(restoreBuiltinPersona(ai, "tsundere").ai).toEqual(ai);
		expect(restoreBuiltinPersona(ai, "nope").ai).toEqual(ai);
	});

	it("不改原对象", () => {
		const ai = settings({ removedBuiltinPresets: ["tsundere"] });
		restoreBuiltinPersona(ai, "tsundere");
		expect(ai.removedBuiltinPresets).toEqual(["tsundere"]);
	});
});

describe("duplicatePersona —— 「从内置修改」", () => {
	it("另存一份**可改**的副本,进 presets(主人自己的)", () => {
		const { ai, railId } = duplicatePersona(settings(), BUILTINS, "preset:tsundere");
		const copyId = railId.replace("preset:", "");
		expect(isBuiltinPersona(copyId)).toBe(false);
		expect(ai.presets.map((p) => p.id)).toEqual([copyId]);
		const edited = updatePersonaAt(ai, BUILTINS, railId, {
			persona: { ...PERSONA, name: "我的傲娇" },
		});
		expect(personaAt(edited, BUILTINS, railId).persona.name).toBe("我的傲娇");
	});

	it("抄的是**当前语言**的内容:换成别的语言的内置,副本里就是那份,此后不再跟语言", () => {
		const en = BUILTINS.map((p) => ({
			...p,
			label: `EN ${p.label}`,
			persona: { ...p.persona, name: `EN ${p.persona.name}` },
			dynamicPrompt: `EN ${p.dynamicPrompt}`,
		}));
		const { ai, railId } = duplicatePersona(settings(), en, "preset:tsundere");
		const copy = ai.presets[0];
		expect(copy?.persona.name).toBe("EN 凛子");
		expect(copy?.dynamicPrompt).toBe(`EN ${BUILTINS[1]?.dynamicPrompt}`);
		expect(copy?.label).toBe("EN 傲娇毒舌 副本");
		// 换回简体:副本不变
		expect(personaAt(ai, BUILTINS, railId).persona.name).toBe("EN 凛子");
	});

	it("名字带个后缀,好与原件区分", () => {
		const { ai } = duplicatePersona(settings(), BUILTINS, "preset:tsundere");
		expect(ai.presets[0]?.label).toBe("傲娇毒舌 副本");
	});

	it("原件一根毛都不动:内置还在左栏、removedBuiltinPresets 没变", () => {
		const { ai } = duplicatePersona(settings(), BUILTINS, "preset:tsundere");
		expect(ai.removedBuiltinPresets).toBeUndefined();
		expect(personaRailItems(ai, BUILTINS).map((i) => i.presetId)).toContain("tsundere");
	});

	it("副本与原件**不共享**任何可变对象", () => {
		// 别名本身就是缺陷:只要哪天有人图省事就地改一个字段,内置那份就当场被改花,
		// 而「锁死内置」正是为了不让这种事发生。这条守的是那个前提。
		const { ai } = duplicatePersona(settings(), BUILTINS, "preset:tsundere");
		const src = BUILTINS.find((p) => p.id === "tsundere");
		expect(ai.presets[0]?.persona).toEqual(src?.persona);
		expect(ai.presets[0]?.persona).not.toBe(src?.persona);
	});

	it("复制一份不存在的 → 原样返回", () => {
		const ai = settings();
		expect(duplicatePersona(ai, BUILTINS, "preset:gone").ai).toEqual(ai);
	});
});
