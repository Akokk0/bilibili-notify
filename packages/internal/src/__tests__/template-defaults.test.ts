/**
 * 「默认文案有更新」的亮灯判定。
 *
 * 文字模板设置里只存主人改过的(ADR-0037 决策 10),没存的读时跟当前语言的出厂走。所以这套提示
 * 只对**存着的那几条**还有意义:主人改的那一刻,账本记下当时的简体出厂原文的指纹;后来简体出厂
 * 文案变了,指纹对不上,才亮灯问他「换成新的,还是留着自己的」。简体原文当「这一版默认」的版本号 ——
 * 换语言、以后补上别的语言的译文,都不该亮。
 */

import { describe, expect, it } from "vite-plus/test";
import { type BuiltinDicts, templateDefaultsFor } from "../builtin-texts";
import { DEFAULT_LOCALE } from "../i18n";
import zhCN from "../locales/zh-CN.json";
import {
	factoryTemplateAt,
	pendingTemplateUpdates,
	storedTemplateAt,
	syncTemplatesSeen,
	templateFingerprint,
} from "../template-defaults";

const fp = templateFingerprint;

/** 简体出厂(形状同 `templateDefaultsFor` 交出的:八条文字 + 会员体系默认那一句)。 */
const FACTORY = { liveStart: "新开播", liveEnd: "新下播", membership: "新上舰" };

describe("pendingTemplateUpdates", () => {
	it("存着、账本里有、指纹是旧简体的 → 亮灯", () => {
		expect(
			pendingTemplateUpdates({ liveStart: "我写的" }, FACTORY, { liveStart: fp("旧开播") }),
		).toEqual(["liveStart"]);
	});

	it("没存的不亮,哪怕账本里有旧指纹", () => {
		expect(pendingTemplateUpdates({}, FACTORY, { liveStart: fp("旧开播") })).toEqual([]);
		expect(
			pendingTemplateUpdates({ liveEnd: "我写的" }, FACTORY, {
				liveStart: fp("旧开播"),
				liveEnd: fp("旧下播"),
			}),
		).toEqual(["liveEnd"]);
	});

	it("存着但账本里没有这条 → 不亮", () => {
		expect(pendingTemplateUpdates({ liveStart: "我写的" }, FACTORY, {})).toEqual([]);
	});

	it("存着、账本指纹就是当前简体 → 不亮(这一版他见过了)", () => {
		expect(
			pendingTemplateUpdates({ liveStart: "我写的" }, FACTORY, { liveStart: fp("新开播") }),
		).toEqual([]);
	});

	it("存着的字已经就是新的简体出厂 → 不亮(换成新的等于什么都没变)", () => {
		expect(
			pendingTemplateUpdates({ liveStart: "新开播" }, FACTORY, { liveStart: fp("旧开播") }),
		).toEqual([]);
	});

	it("换语言不亮:比的永远是简体出厂,不看当前语言的出厂", () => {
		const dicts: BuiltinDicts = {
			"zh-CN": zhCN,
			"zh-TW": {},
			en: { "template.liveStart": "English start" },
			ja: {},
		};
		const zh = templateDefaultsFor(DEFAULT_LOCALE, dicts);
		const en = templateDefaultsFor("en", dicts);
		expect(en.liveStart).toBe("English start");
		const seen = { liveStart: fp(zh.liveStart) };
		expect(pendingTemplateUpdates({ liveStart: "我写的" }, zh, seen)).toEqual([]);
		// 把英文当成「这一版默认」去比就会亮 —— 这正是不许做的
		expect(pendingTemplateUpdates({ liveStart: "我写的" }, en, seen)).toEqual(["liveStart"]);
	});

	it("会员:存着的体系里那一句按出厂句判;没存那一句的体系不亮", () => {
		const stored = {
			membership: {
				guard: { enabled: true, default: { template: "我写的上舰" } },
				other: { enabled: true, default: { imageUrl: "https://x" } },
				bare: { tiers: {} },
			},
		};
		const seen = {
			"membership.guard.default.template": fp("旧上舰"),
			"membership.other.default.template": fp("旧上舰"),
			"membership.bare.default.template": fp("旧上舰"),
		};
		expect(pendingTemplateUpdates(stored, FACTORY, seen)).toEqual([
			"membership.guard.default.template",
		]);
	});

	it("不是文字的格出局:词云停用词、图片地址即使存着、账本里有旧指纹也不亮", () => {
		const stored = {
			wordcloudStopWords: "哈哈",
			membership: { guard: { default: { imageUrl: "https://x" } } },
		};
		expect(
			pendingTemplateUpdates(stored, FACTORY, {
				wordcloudStopWords: fp(""),
				"membership.guard.default.imageUrl": fp(""),
			}),
		).toEqual([]);
	});

	it("多条同时有更新 → 一条不落全报出来", () => {
		expect(
			pendingTemplateUpdates({ liveStart: "我一", liveEnd: "我二" }, FACTORY, {
				liveStart: fp("旧一"),
				liveEnd: fp("旧二"),
			}),
		).toEqual(["liveStart", "liveEnd"]);
	});
});

describe("storedTemplateAt / factoryTemplateAt", () => {
	it("按点路径取存着的文字,会员走 membership.<体系>.default.template", () => {
		const stored = { liveStart: "x", membership: { guard: { default: { template: "y" } } } };
		expect(storedTemplateAt(stored, "liveStart")).toBe("x");
		expect(storedTemplateAt(stored, "membership.guard.default.template")).toBe("y");
		expect(storedTemplateAt(stored, "liveEnd")).toBeUndefined();
		expect(storedTemplateAt(stored, "membership.other.default.template")).toBeUndefined();
	});

	it("出厂一侧:会员那一句不分体系,每个体系取同一句", () => {
		expect(factoryTemplateAt(FACTORY, "liveStart")).toBe("新开播");
		expect(factoryTemplateAt(FACTORY, "membership.guard.default.template")).toBe("新上舰");
		expect(factoryTemplateAt(FACTORY, "membership.other.default.template")).toBe("新上舰");
		expect(factoryTemplateAt(FACTORY, "wordcloudStopWords")).toBeUndefined();
		expect(factoryTemplateAt(FACTORY, "membership")).toBeUndefined();
	});
});

describe("syncTemplatesSeen:账本跟着「存没存」走", () => {
	it("没存 → 存了:记下此刻简体出厂原文的指纹", () => {
		expect(syncTemplatesSeen({}, { liveStart: "我写的" }, {}, FACTORY)).toEqual({
			liveStart: fp("新开播"),
		});
	});

	it("会员体系默认那一句同理", () => {
		const next = { membership: { guard: { default: { template: "我写的" } } } };
		expect(syncTemplatesSeen({}, next, {}, FACTORY)).toEqual({
			"membership.guard.default.template": fp("新上舰"),
		});
	});

	it("存了 → 没存(恢复默认、用新默认、改回一字不差):账本里这一条也走", () => {
		expect(
			syncTemplatesSeen(
				{ liveStart: "我写的" },
				{},
				{ liveStart: fp("旧开播"), liveEnd: "k" },
				FACTORY,
			),
		).toEqual({ liveEnd: "k" });
	});

	it("存着改成另一句:账本不动(旧指纹要留着,提示才能继续问)", () => {
		const seen = { liveStart: fp("旧开播") };
		expect(syncTemplatesSeen({ liveStart: "一" }, { liveStart: "二" }, seen, FACTORY)).toBe(seen);
	});

	it("非文字的格(词云停用词)存了不记账", () => {
		expect(syncTemplatesSeen({}, { wordcloudStopWords: "哈哈" }, {}, FACTORY)).toEqual({});
	});

	it("不改入参", () => {
		const seen = Object.freeze({ liveEnd: "k" });
		const out = syncTemplatesSeen({}, { liveStart: "我写的" }, seen, FACTORY);
		expect(out).not.toBe(seen);
		expect(seen).toEqual({ liveEnd: "k" });
	});
});

describe("templateFingerprint", () => {
	it("内容变了指纹就变 —— 这是整套判定的地基", () => {
		expect(templateFingerprint("开播啦")).not.toBe(templateFingerprint("开播啦!"));
	});

	it("同一份内容指纹稳定 —— 否则每次启动都会误判成「默认变了」", () => {
		expect(templateFingerprint("开播啦")).toBe(templateFingerprint("开播啦"));
	});
});
