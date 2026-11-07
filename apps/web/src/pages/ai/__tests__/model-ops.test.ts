/**
 * AI 设置页左栏的增删操作 —— 全是对 `AiSettings` 草稿的纯变换。
 *
 * 之所以抽成纯函数而不是散在 `Ai.tsx` 的 setState 里:这里的分支恰恰是**最容易
 * 悄悄出错、又最难在界面上看出来**的那几处 —— 删掉正在用的那家之后指针指向哪、
 * 删到一家不剩会不会炸、新人格的 id 撞没撞上。
 */

import { type AIProviderId, EMPTY_AI_PROVIDER_PROFILE } from "@bilibili-notify/internal/ai";
import { buildPatch } from "@bilibili-notify/internal/patch";
import { BUILTIN_PRESET_IDS, builtinPresetsFor } from "@bilibili-notify/internal/texts/builtin";
import { describe, expect, it } from "vite-plus/test";
import type { AiPersonaSettings, AiSettings } from "../../../types/globals";
import {
	addProfile,
	globalPersonaRailId,
	personaRailItems,
	profileRailItems,
	removeProfile,
	renameProfile,
	resolveEditingProfile,
	setActiveProfile,
	setGlobalPersona,
} from "../model-ops";

// 内置人格每次按当前语言取,设置里不存(ADR-0037 决策 11)
const BUILTINS = builtinPresetsFor("zh-CN");

const PERSONA: AiPersonaSettings = {
	name: "",
	addressUser: "",
	addressSelf: "",
	traits: "",
	catchphrase: "",
	baseRole: "",
	extraSystemPrompt: "",
};

function settings(over: Partial<AiSettings> = {}): AiSettings {
	return {
		enabled: true,
		activeProfile: "",
		providers: {},
		chat: {},
		search: {
			backend: "bocha",
			keys: { bocha: "", tavily: "" },
			scenes: { post: false, live: false, roast: false },
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
function bucket(provider: AIProviderId, over: Partial<AiSettings["providers"][string]> = {}) {
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

	it("指针为空且没有实例时 → 头一份添加的就成了在用的那份", () => {
		// 不这么做的话:主人添加了第一份、填好密钥,女仆却仍然「没配齐」,
		// 而界面上看不出还差一步。
		const { ai } = addProfile(settings(), "openrouter");
		expect(ai.activeProfile).toBe("openrouter");
	});

	it.each(["unreadable-profile", "constructor", "toString", "__proto__"])(
		"默认指针 %s 暂时没有可读实例 → 添加不改写原选择",
		(name) => {
			const base = settings({ activeProfile: name });
			const { ai } = addProfile(base, "openrouter");
			expect(ai.activeProfile).toBe(name);
			expect(buildPatch({ ai }, { ai: base })).toMatchObject({ ai: { activeProfile: name } });
		},
	);

	it("已有实例而指针为空 → 添加不替用户决定默认实例", () => {
		const base = settings({ providers: { backup: bucket("deepseek") } });
		expect(addProfile(base, "openrouter").ai.activeProfile).toBe("");
	});

	it("默认实例读不到但仍有别的实例 → 添加不抢默认指针", () => {
		const base = settings({
			activeProfile: "unreadable",
			providers: { backup: bucket("deepseek") },
		});
		expect(addProfile(base, "openrouter").ai.activeProfile).toBe("unreadable");
	});

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
	function three(): AiSettings {
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

const ALL_BUILTIN_IDS = [...BUILTIN_PRESET_IDS];

/** 只有主人自己的人格(四份内置都标成已删)。 */
function ownerOnly(...labels: string[]): AiSettings {
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
