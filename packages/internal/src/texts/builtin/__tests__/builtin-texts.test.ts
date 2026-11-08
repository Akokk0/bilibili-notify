import { describe, expect, it } from "vite-plus/test";
import { LOCALES } from "../../../i18n";
import {
	BUILTIN_PRESET_IDS,
	builtinPresetsFor,
	templateDefaultsFor,
	withTemplateDefaults,
} from "..";
import before from "./fixtures/builtin-texts-before-move.json";

/** 一份只有几条的英文,别的键全靠简体打底。 */
const sparse = (en: Record<string, string>) =>
	({ "zh-CN": zhFull(), "zh-TW": {}, en, ja: {} }) as const;

// 简体底:取真字典(通过读口无法拿到原字典,这里借 zh-CN 的读口结果反推不必要 —— 直接读 JSON)
import zhCN from "../locales/zh-CN.json";

const zhFull = () => zhCN as Record<string, string>;

describe("出厂文案读口:按语言打底", () => {
	it("本语言有这一条就取本语言,别的取简体", () => {
		const dicts = sparse({ "template.liveStart": "{name} is live" });
		const out = templateDefaultsFor("en", dicts);
		expect(out.liveStart).toBe("{name} is live");
		expect(out.liveEnd).toBe(zhCN["template.liveEnd"]);
		expect(out.membership).toBe(zhCN["template.membership"]);
	});

	it("人格同理:一个字段取本语言,别的字段与别的人格取简体", () => {
		const dicts = sparse({ "persona.tsundere.name": "Rin" });
		const presets = builtinPresetsFor("en", dicts);
		const tsundere = presets.find((p) => p.id === "tsundere");
		expect(tsundere?.persona.name).toBe("Rin");
		expect(tsundere?.persona.addressSelf).toBe(zhCN["persona.tsundere.addressSelf"]);
		expect(presets[0]?.persona.name).toBe(zhCN["persona.gentle-maid.name"]);
	});

	it("每次交新对象,改一份不影响下一份", () => {
		const a = templateDefaultsFor("zh-CN");
		a.liveStart = "改了";
		expect(templateDefaultsFor("zh-CN").liveStart).not.toBe("改了");
		const p = builtinPresetsFor("zh-CN");
		const first = p[0];
		if (!first) throw new Error("没有内置人格");
		first.persona.name = "改了";
		expect(builtinPresetsFor("zh-CN")[0]?.persona.name).not.toBe("改了");
	});
});

describe("出厂文案读口:真字典", () => {
	it("templateDefaultsFor(zh-CN) 的文字与搬家前的 DEFAULT_TEMPLATES 逐字相等(非文字的格已收出去)", () => {
		const { wordcloudStopWords: _w, membership, ...texts } = before.templates;
		expect(templateDefaultsFor("zh-CN")).toEqual({
			...texts,
			membership: membership.guard.default.template,
		});
	});

	it("builtinPresetsFor(zh-CN) 与搬家前的 BUILTIN_AI_PRESETS 逐字相等", () => {
		expect(builtinPresetsFor("zh-CN")).toEqual(before.presets);
	});

	it("人格的 id 顺序等于 BUILTIN_PRESET_IDS,每份十格齐全", () => {
		for (const locale of LOCALES) {
			const presets = builtinPresetsFor(locale);
			expect(presets.map((p) => p.id)).toEqual([...BUILTIN_PRESET_IDS]);
			for (const p of presets) {
				const cells = [
					p.label,
					p.persona.name,
					p.persona.addressUser,
					p.persona.addressSelf,
					p.persona.traits,
					p.persona.catchphrase,
					p.persona.baseRole,
					p.persona.extraSystemPrompt,
					p.dynamicPrompt,
					p.liveSummaryPrompt,
				];
				expect(cells).toHaveLength(10);
				for (const cell of cells) expect(cell.trim()).not.toBe("");
			}
		}
	});

	it("四语默认模板均已提供，固定模型提示词仍与简中相同", () => {
		for (const locale of LOCALES) {
			if (locale !== "zh-CN")
				expect(templateDefaultsFor(locale).liveStart).not.toBe(
					templateDefaultsFor("zh-CN").liveStart,
				);
			expect(builtinPresetsFor(locale).map((p) => [p.dynamicPrompt, p.liveSummaryPrompt])).toEqual(
				before.presets.map((p) => [p.dynamicPrompt, p.liveSummaryPrompt]),
			);
		}
	});
});

it("keeps the two model prompt fields Chinese even when human dictionaries offer translations", () => {
	const dicts = sparse({
		"persona.gentle-maid.name": "Gentle Maid",
		"persona.gentle-maid.dynamicPrompt": "Human translation must not replace this model rule.",
		"persona.gentle-maid.liveSummaryPrompt": "Another human translation of a model rule.",
	});
	const preset = builtinPresetsFor("en", dicts)[0];
	expect(preset?.persona.name).toBe("Gentle Maid");
	expect(preset?.dynamicPrompt).toBe(before.presets[0]?.dynamicPrompt);
	expect(preset?.liveSummaryPrompt).toBe(before.presets[0]?.liveSummaryPrompt);
});

it("provides localized factory personas and templates while retaining custom template text", () => {
	for (const [locale, liveStart, label, name] of [
		["en", "{name} is live. Current followers: {follower}", "Gentle Maid", "Ling"],
		["ja", "{name}が配信を開始しました。現在のフォロワー数：{follower}", "優しいメイド", "アヤ"],
		["zh-TW", "{name} 開播了，目前粉絲數：{follower}", "溫柔女僕", "小綾"],
	] as const) {
		const defaults = templateDefaultsFor(locale);
		expect(defaults.liveStart).toBe(liveStart);
		expect(withTemplateDefaults({ post: "主人自写", liveStart: "" }, defaults)).toMatchObject({
			post: "主人自写",
			liveStart: "",
			liveEnd: defaults.liveEnd,
		});
		const preset = builtinPresetsFor(locale)[0];
		expect(preset).toMatchObject({
			id: "gentle-maid",
			label,
			persona: { name },
			dynamicPrompt: before.presets[0]?.dynamicPrompt,
			liveSummaryPrompt: before.presets[0]?.liveSummaryPrompt,
		});
	}
});
