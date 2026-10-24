import { describe, expect, it } from "vite-plus/test";
import { BUILTIN_PRESET_IDS, builtinPresetsFor, templateDefaultsFor } from "../builtin-texts";
import { LOCALES } from "../i18n";
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
		expect(out.membership.guard.default.template).toBe(zhCN["template.membership"]);
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
	it("templateDefaultsFor(zh-CN) 与搬家前的 DEFAULT_TEMPLATES 逐字相等", () => {
		expect(templateDefaultsFor("zh-CN")).toEqual(before.templates);
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

	it("别的语言今天是空表,读出来同简体", () => {
		for (const locale of LOCALES) {
			expect(templateDefaultsFor(locale)).toEqual(templateDefaultsFor("zh-CN"));
		}
	});
});
