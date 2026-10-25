/**
 * 人格库的读法(ADR-0037 决策 11):内置的每次按当前语言取,设置里只记「删了哪几份」+ 主人自己的。
 * 只经公开的口验:`presetsOf` / `resolveActivePersona` 吃注入的内置列表。
 */

import { describe, expect, it } from "vite-plus/test";
import { presetsOf, resolveActivePersona } from "../ai";
import { BUILTIN_PRESET_IDS, builtinPresetsFor } from "../builtin-texts";
import zhCN from "../locales/zh-CN.json";

const zh = builtinPresetsFor("zh-CN");
// 英文只填两个字段,别的靠简体打底 —— 够认出「取的是注入的那份」
const en = builtinPresetsFor("en", {
	"zh-CN": zhCN as Record<string, string>,
	"zh-TW": {},
	ja: {},
	en: {
		"persona.gentle-maid.name": "Gentle Maid",
		"persona.gentle-maid.dynamicPrompt": "Write a post comment.",
		"persona.tsundere.name": "Rin",
	},
});

const MINE = {
	id: "mine",
	label: "我的",
	persona: {
		name: "阿绫",
		addressUser: "老板",
		addressSelf: "我",
		traits: "话少",
		catchphrase: "",
		baseRole: "简洁汇报",
		extraSystemPrompt: "",
	},
	dynamicPrompt: "就照这个说",
	liveSummaryPrompt: "直播也照这个说",
};

describe("presetsOf —— 人格左栏", () => {
	it("缺 removedBuiltinPresets = 四份内置全在,顺序同 BUILTIN_PRESET_IDS", () => {
		expect(presetsOf({ presets: [] }, zh).map((p) => p.id)).toEqual([...BUILTIN_PRESET_IDS]);
	});

	it("删了的内置不在列表里,主人自己的排在内置之后", () => {
		const list = presetsOf({ removedBuiltinPresets: ["tsundere"], presets: [MINE] }, zh);
		expect(list.map((p) => p.id)).toEqual(["gentle-maid", "analyst", "genki", "mine"]);
	});

	it("内置的内容取传进来的那份(当前语言)", () => {
		const list = presetsOf({ presets: [] }, en);
		expect(list.find((p) => p.id === "tsundere")?.persona.name).toBe("Rin");
	});

	it("presets 里混进内置 id 的条目:以内置为准、那一份不进列表", () => {
		const stale = { ...MINE, id: "tsundere", label: "旧的" };
		const list = presetsOf({ presets: [stale, MINE] }, en);
		expect(list.map((p) => p.id)).toEqual(["gentle-maid", "tsundere", "analyst", "genki", "mine"]);
		expect(list.find((p) => p.id === "tsundere")?.persona.name).toBe("Rin");
	});

	it("removedBuiltinPresets 里认不得的 id 忽略", () => {
		const list = presetsOf({ removedBuiltinPresets: ["nope"], presets: [] }, zh);
		expect(list).toHaveLength(4);
	});
});

describe("resolveActivePersona —— 当前用哪份人格", () => {
	it("指针指内置:取注入的英文内容", () => {
		const a = resolveActivePersona({ activePreset: "tsundere", presets: [] }, en);
		expect(a.persona.name).toBe("Rin");
	});

	it("指针指主人自己的:取它,两段提示词也跟着走", () => {
		const a = resolveActivePersona({ activePreset: "mine", presets: [MINE] }, zh);
		expect(a.persona.name).toBe("阿绫");
		expect(a.dynamicPrompt).toBe("就照这个说");
		expect(a.liveSummaryPrompt).toBe("直播也照这个说");
	});

	it("指针落空(没填 / 指着已删的)回落列表第一份", () => {
		const ai = { removedBuiltinPresets: ["gentle-maid"], presets: [] };
		expect(resolveActivePersona({ ...ai, activePreset: "gone" }, en).persona.name).toBe(
			en[1]?.persona.name,
		);
		expect(resolveActivePersona(ai, en).persona.name).toBe(en[1]?.persona.name);
		// 指着一份被删掉的内置
		expect(resolveActivePersona({ ...ai, activePreset: "gentle-maid" }, en).persona.name).toBe(
			en[1]?.persona.name,
		);
	});

	it("内置全删光、主人也没有自己的:回落内置首份", () => {
		const a = resolveActivePersona(
			{ removedBuiltinPresets: [...BUILTIN_PRESET_IDS], presets: [] },
			en,
		);
		expect(a.persona.name).toBe("Gentle Maid");
		expect(a.dynamicPrompt).toBe("Write a post comment.");
	});

	it("主人那份缺提示词:逐段回落内置首份的那段", () => {
		const { dynamicPrompt: _d, liveSummaryPrompt: _l, ...bare } = MINE;
		const a = resolveActivePersona({ activePreset: "mine", presets: [bare] }, en);
		expect(a.persona.name).toBe("阿绫");
		expect(a.dynamicPrompt).toBe("Write a post comment.");
		expect(a.liveSummaryPrompt).toBe(en[0]?.liveSummaryPrompt);
	});
});
