/**
 * `resolveTemplates` 与新装的盘形状(ADR-0037 决策 10):设置里只存主人改过的文字,缺的按当前语言现取出厂。
 * 期望值来自注入字典里的那条 / 简体字典原文的字面量,不拿被测函数自己的输出当期望。
 */

import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_LOCALE, type Dict } from "../../i18n";
import { type BuiltinDicts, templateDefaultsFor, withTemplateDefaults } from "../../texts/builtin";
import zhCN from "../../texts/builtin/locales/zh-CN.json";
import { TemplateBundleSchema } from "../common";
import { GlobalSettingsSchema, makeDefaultGlobalSettings } from "../globals";
import { resolveTemplates } from "../resolve";
import { makeEmptySubscription, type Subscription } from "../subscriptions";

const SUB: Subscription = makeEmptySubscription({
	id: "11111111-1111-1111-1111-111111111111",
	identity: { sourceKey: "bilibili", externalId: "12345" },
});

// 一份只有英文开播与会员体系默认两句的注入字典,别的键打底简体
const EN: Dict = {
	"template.liveStart": "{name} is live",
	"template.membership": "{viewer} joined {name} as {tier}!",
};
const DICTS: BuiltinDicts = { "zh-CN": zhCN, "zh-TW": {}, en: EN, ja: {} };
const ZH = templateDefaultsFor("zh-CN");
const EN_DEFAULTS = templateDefaultsFor("en", DICTS);

const TEXT_KEYS = [
	"liveStart",
	"liveStreaming",
	"liveEnd",
	"liveSummary",
	"post",
	"postVideo",
	"viewerChat",
	"viewerEnter",
] as const;

describe("新装的设置形状", () => {
	it("makeDefaultGlobalSettings 的 defaults.templates 没有任何文字格", () => {
		const { templates } = makeDefaultGlobalSettings().defaults;
		for (const key of TEXT_KEYS) expect(templates[key]).toBeUndefined();
		expect(templates.membership).toEqual({});
		// 不是文字的格照今天的默认留着
		expect(templates.wordcloudStopWords).toBe("");
	});

	it("经 schema 读一遍再序列化,文字格不会被填回来(一读一写不落盘)", () => {
		const roundTrip = GlobalSettingsSchema.parse(
			JSON.parse(JSON.stringify(makeDefaultGlobalSettings())),
		);
		for (const key of TEXT_KEYS)
			expect(Object.hasOwn(roundTrip.defaults.templates, key)).toBe(false);
		expect(TemplateBundleSchema.parse({})).toEqual({ wordcloudStopWords: "", membership: {} });
	});

	it("老盘上整份存着的默认文字照样解析得进来,值原样保留", () => {
		const { membership, ...texts } = ZH;
		const parsed = TemplateBundleSchema.parse({
			...texts,
			membership: {
				guard: { enabled: false, default: { template: membership, imageUrl: "" }, tiers: {} },
			},
		});
		expect(parsed.liveStart).toBe(ZH.liveStart);
		expect(parsed.membership.guard?.default.template).toBe(ZH.membership);
	});
});

describe("resolveTemplates", () => {
	it("没存:取出厂那句(简体字典原文)", () => {
		const t = resolveTemplates(SUB, makeDefaultGlobalSettings().defaults, ZH);
		expect(t.liveStart).toBe("{name} 开播啦，当前粉丝数：{follower}");
		expect(t.post).toBe("{name}发布了一条{postNoun}");
		expect(t.membership("guard").default.template).toBe("{viewer} 成为了 {name} 的{tier}！");
	});

	it("没存、换成英文默认:取英文那条;字典里没有的键拿简体打底", () => {
		const t = resolveTemplates(SUB, makeDefaultGlobalSettings().defaults, EN_DEFAULTS);
		expect(t.liveStart).toBe("{name} is live");
		expect(t.liveEnd).toBe(ZH.liveEnd);
		expect(t.membership("guard").default.template).toBe("{viewer} joined {name} as {tier}!");
	});

	it("存了:照存的,不随语言变", () => {
		const g = makeDefaultGlobalSettings();
		g.defaults.templates.liveStart = "我自己写的";
		expect(resolveTemplates(SUB, g.defaults, EN_DEFAULTS).liveStart).toBe("我自己写的");
		expect(resolveTemplates(SUB, g.defaults, ZH).liveStart).toBe("我自己写的");
	});

	it("订阅覆盖 > 全局存的 > 出厂", () => {
		const g = makeDefaultGlobalSettings();
		g.defaults.templates.liveStart = "全局的";
		g.defaults.templates.liveEnd = "全局的下播";
		const sub: Subscription = { ...SUB, overrides: { templates: { liveStart: "订阅的" } } };
		const t = resolveTemplates(sub, g.defaults, EN_DEFAULTS);
		expect(t.liveStart).toBe("订阅的");
		expect(t.liveEnd).toBe("全局的下播");
		expect(t.liveSummary).toBe(ZH.liveSummary);
	});

	it("会员·订阅覆盖开着就整份换", () => {
		const g = makeDefaultGlobalSettings();
		g.defaults.templates.membership.guard = {
			enabled: true,
			default: { template: "全局体系默认", imageUrl: "" },
			tiers: {},
		};
		const sub: Subscription = {
			...SUB,
			overrides: {
				templates: {
					membership: {
						guard: {
							enabled: true,
							default: { imageUrl: "a.png" },
							tiers: { captain: { template: "舰" } },
						},
					},
				},
			},
		};
		// 整份换成订阅的:订阅里缺的体系默认文字取出厂,不取全局存的
		expect(resolveTemplates(sub, g.defaults, ZH).membership("guard")).toEqual({
			enabled: true,
			default: { template: "{viewer} 成为了 {name} 的{tier}！", imageUrl: "a.png" },
			tiers: { captain: { template: "舰" } },
		});
	});

	it("会员·条目里缺 default.template 取出厂那一句,其余照存", () => {
		const g = makeDefaultGlobalSettings();
		g.defaults.templates.membership.guard = {
			enabled: true,
			default: { imageUrl: "x.png" },
			tiers: {},
		};
		expect(resolveTemplates(SUB, g.defaults, EN_DEFAULTS).membership("guard")).toEqual({
			enabled: true,
			default: { template: "{viewer} joined {name} as {tier}!", imageUrl: "x.png" },
			tiers: {},
		});
	});

	it("会员·没有这个体系的条目:自定义关着、体系默认取出厂那句", () => {
		const t = resolveTemplates(SUB, makeDefaultGlobalSettings().defaults, EN_DEFAULTS);
		expect(t.membership("acme-custom")).toEqual({
			enabled: false,
			default: { template: "{viewer} joined {name} as {tier}!", imageUrl: "" },
			tiers: {},
		});
	});
});

describe("withTemplateDefaults", () => {
	it("不改入参,存着的取存的、缺的取默认", () => {
		const stored = { post: "我的作品句", membership: {} };
		const out = withTemplateDefaults(stored, ZH);
		expect(out.post).toBe("我的作品句");
		expect(out.postVideo).toBe(ZH.postVideo);
		expect(stored).toEqual({ post: "我的作品句", membership: {} });
		expect(out.wordcloudStopWords).toBe("");
		expect(out.membership).toEqual({});
	});

	it("用到的默认语言常量没偏", () => {
		expect(DEFAULT_LOCALE).toBe("zh-CN");
	});
});
