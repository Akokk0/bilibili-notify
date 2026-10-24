/**
 * 醒目留言与会员的设置(㉓d):`defaults.superchat.minAmount`、`defaults.membership.minRank`(按体系 id)与逐订阅覆盖,
 * 以及会员文案 `templates.membership`。原先的 `filters.minScPrice` / `minGuardLevel` 与 `templates.guardBuy` 搬到了这里。
 * 期望值都是手写的字面量。
 */

import { describe, expect, it } from "vite-plus/test";
import { templateDefaultsFor } from "../../builtin-texts";
import { DEFAULT_LOCALE } from "../../i18n";
import { ContentFiltersSchema, MembershipTemplateBundleSchema } from "../common";
import { GlobalConfigSchema, makeDefaultGlobalConfig } from "../globals";
import { resolve, resolveTemplates } from "../resolve";
import {
	makeEmptySubscription,
	type Subscription,
	SubscriptionOverridesSchema,
} from "../subscriptions";

const SUB_BASE: Subscription = makeEmptySubscription({
	id: "11111111-1111-1111-1111-111111111111",
	identity: { sourceKey: "sample-source", externalId: "12345" },
});

describe("内容过滤不再带直播门槛", () => {
	it("ContentFilters 里没有 minScPrice / minGuardLevel(盘上残留的会被剥掉,不整份拒收)", () => {
		const parsed = ContentFiltersSchema.parse({
			blockReposts: false,
			blockArticles: false,
			blockKeywords: [],
			blockRegex: [],
			allowKeywords: [],
			allowRegex: [],
			minScPrice: 30,
			minGuardLevel: 2,
		});
		expect(Object.keys(parsed).sort()).toEqual([
			"allowKeywords",
			"allowRegex",
			"blockArticles",
			"blockImages",
			"blockKeywords",
			"blockRegex",
			"blockReposts",
			"blockVideos",
		]);
	});
});

describe("defaults.superchat / defaults.membership", () => {
	it("出厂两段都是空的:没配门槛 = 不设门槛", () => {
		const { defaults } = makeDefaultGlobalConfig();
		expect(defaults.superchat).toEqual({});
		expect(defaults.membership).toEqual({});
	});

	it("老配置缺这两段:补成空段,不让开机失败", () => {
		const base = makeDefaultGlobalConfig();
		const { superchat: _s, membership: _m, ...rest } = base.defaults;
		const parsed = GlobalConfigSchema.parse({
			logging: {},
			master: {},
			defaults: rest,
			ai: base.ai,
		});
		expect(parsed.defaults.superchat).toEqual({});
		expect(parsed.defaults.membership).toEqual({});
	});

	it("金额门槛 ≥ 0:负数拒收,0 与小数收;档 rank 必须是正整数,0、负数、小数都拒收", () => {
		const base = makeDefaultGlobalConfig();
		const parse = (defaults: object) =>
			GlobalConfigSchema.safeParse({ ...base, defaults: { ...base.defaults, ...defaults } });
		expect(parse({ superchat: { minAmount: 0 } }).success).toBe(true);
		expect(parse({ superchat: { minAmount: 30.5 } }).success).toBe(true);
		expect(parse({ superchat: { minAmount: -1 } }).success).toBe(false);
		expect(parse({ membership: { minRank: { guard: 2 } } }).success).toBe(true);
		expect(parse({ membership: { minRank: { guard: 0 } } }).success).toBe(false);
		expect(parse({ membership: { minRank: { guard: 1.5 } } }).success).toBe(false);
		expect(parse({ membership: { minRank: { guard: -1 } } }).success).toBe(false);
	});

	it("缺这两段补出来的默认值不共用对象:改一份不会改到下一次解析拿到的", () => {
		const base = makeDefaultGlobalConfig();
		const { superchat: _s, membership: _m, ...rest } = base.defaults;
		const parse = () =>
			GlobalConfigSchema.parse({ logging: {}, master: {}, defaults: rest, ai: base.ai }).defaults;
		const a = parse();
		a.membership.minRank = { guard: 3 };
		a.superchat.minAmount = 99;
		const b = parse();
		expect(b.membership).toEqual({});
		expect(b.superchat).toEqual({});
	});
});

describe("逐订阅覆盖的两段:无默认的纯可选", () => {
	it("只覆盖别的东西时,覆盖里不会凭空长出 superchat / membership", () => {
		const parsed = SubscriptionOverridesSchema.parse({ templates: { liveSummary: "x" } });
		expect(parsed.superchat).toBeUndefined();
		expect(parsed.membership).toBeUndefined();
		// 模板覆盖里也不会被注入整份会员文案(那会让每条订阅都被当成「已定制上舰提示」)。
		expect(parsed.templates).toEqual({ liveSummary: "x" });
	});

	it("覆盖里写 0 原样留着(0 = 这个订阅不设门槛,全局可能不是 0)", () => {
		const parsed = SubscriptionOverridesSchema.parse({ superchat: { minAmount: 0 } });
		expect(parsed.superchat).toEqual({ minAmount: 0 });
	});
});

describe("resolve:superchat 与 membership 的生效值", () => {
	it("没有覆盖:继承全局", () => {
		const globals = makeDefaultGlobalConfig();
		globals.defaults.superchat = { minAmount: 30 };
		globals.defaults.membership = { minRank: { guard: 2 } };
		const eff = resolve(SUB_BASE, globals.defaults);
		expect(eff.superchat).toEqual({ minAmount: 30 });
		expect(eff.membership).toEqual({ minRank: { guard: 2 } });
	});

	it("全局都没配:生效值也是没配(不设门槛),membership.minRank 是空表", () => {
		const eff = resolve(SUB_BASE, makeDefaultGlobalConfig().defaults);
		expect(eff.superchat.minAmount).toBeUndefined();
		expect(eff.membership).toEqual({ minRank: {} });
	});

	it("醒目留言门槛:覆盖有就用覆盖,包括 0(盖掉全局的 30)", () => {
		const globals = makeDefaultGlobalConfig();
		globals.defaults.superchat = { minAmount: 30 };
		const withOverride = (minAmount: number) =>
			resolve({ ...SUB_BASE, overrides: { superchat: { minAmount } } }, globals.defaults);
		expect(withOverride(100).superchat.minAmount).toBe(100);
		expect(withOverride(0).superchat.minAmount).toBe(0);
	});

	it("会员门槛按体系逐键合并:订阅只改了 guard,别的体系的全局门槛不被冲掉", () => {
		const globals = makeDefaultGlobalConfig();
		globals.defaults.membership = { minRank: { guard: 2, other: 3 } };
		const eff = resolve(
			{ ...SUB_BASE, overrides: { membership: { minRank: { guard: 3 } } } },
			globals.defaults,
		);
		expect(eff.membership.minRank).toEqual({ guard: 3, other: 3 });
	});

	it("会员门槛:订阅覆盖里有全局没有的体系,也带上;覆盖里写 rank 1(全推)盖掉全局的 2", () => {
		const globals = makeDefaultGlobalConfig();
		globals.defaults.membership = { minRank: { guard: 2 } };
		const eff = resolve(
			{ ...SUB_BASE, overrides: { membership: { minRank: { guard: 1, extra: 2 } } } },
			globals.defaults,
		);
		expect(eff.membership.minRank).toEqual({ guard: 1, extra: 2 });
	});

	it("生效值与全局、覆盖互不共用对象:改生效值不会改到全局", () => {
		const globals = makeDefaultGlobalConfig();
		globals.defaults.membership = { minRank: { guard: 2 } };
		const eff = resolve(SUB_BASE, globals.defaults);
		eff.membership.minRank.guard = 3;
		expect(globals.defaults.membership.minRank?.guard).toBe(2);
	});
});

describe("templates.membership —— 会员文案", () => {
	it("出厂:B 站的体系 guard 关着自定义,体系默认是「{viewer} 成为了 {name} 的{tier}！」、图片空、没有任何档的覆盖", () => {
		// 新装不存文字:盘上是空的,出厂那句由 `resolveTemplates` 现取(见 resolve-templates.test.ts)。
		expect(makeDefaultGlobalConfig().defaults.templates.membership).toEqual({});
		const factory = templateDefaultsFor(DEFAULT_LOCALE);
		expect(
			resolveTemplates(SUB_BASE, makeDefaultGlobalConfig().defaults, factory).membership("guard"),
		).toEqual({
			enabled: false,
			default: { template: "{viewer} 成为了 {name} 的{tier}！", imageUrl: "" },
			tiers: {},
		});
		expect(templateDefaultsFor(DEFAULT_LOCALE).membership).toBe(
			"{viewer} 成为了 {name} 的{tier}！",
		);
	});

	it("一个体系的文案:enabled 缺了补 false、tiers 缺了补空;体系默认的文字可缺(跟随出厂)、图片缺了补空;档里两格各自可选", () => {
		const parsed = MembershipTemplateBundleSchema.parse({
			default: { template: "t", imageUrl: "" },
		});
		expect(parsed).toEqual({ enabled: false, default: { template: "t", imageUrl: "" }, tiers: {} });
		expect(MembershipTemplateBundleSchema.parse({ enabled: true, tiers: {} })).toEqual({
			enabled: true,
			default: { imageUrl: "" },
			tiers: {},
		});
		expect(
			MembershipTemplateBundleSchema.parse({
				default: { template: "t", imageUrl: "" },
				tiers: { captain: { imageUrl: "https://img.test/c.png" }, 任意档名: {} },
			}).tiers,
		).toEqual({ captain: { imageUrl: "https://img.test/c.png" }, 任意档名: {} });
	});

	it("逐订阅覆盖:按体系各带一份;resolveTemplates 对体系整份替换,没覆盖的体系还是全局的", () => {
		const globals = makeDefaultGlobalConfig();
		const factory = templateDefaultsFor(DEFAULT_LOCALE);
		const guardOverride = {
			enabled: true,
			default: { template: "本订阅的默认", imageUrl: "" },
			tiers: { governor: { template: "总督来了" } },
		};
		const sub = {
			...SUB_BASE,
			overrides: { templates: { membership: { guard: guardOverride } } },
		};
		expect(resolveTemplates(sub, globals.defaults, factory).membership("guard")).toEqual(
			guardOverride,
		);
		// 没被覆盖的体系:还是全局那一份(这里造一个全局的第二体系验证)。
		globals.defaults.templates.membership.other = {
			enabled: false,
			default: { template: "全局的 other", imageUrl: "" },
			tiers: {},
		};
		const t2 = resolveTemplates(sub, globals.defaults, factory);
		expect(t2.membership("other").default.template).toBe("全局的 other");
		expect(t2.membership("guard")).toEqual(guardOverride);
	});

	it("没有覆盖:整份继承全局", () => {
		const globals = makeDefaultGlobalConfig();
		const factory = templateDefaultsFor(DEFAULT_LOCALE);
		globals.defaults.templates.membership.guard = {
			enabled: true,
			default: { imageUrl: "" },
			tiers: {},
		};
		expect(resolveTemplates(SUB_BASE, globals.defaults, factory).membership("guard")).toEqual({
			enabled: true,
			default: { template: factory.membership, imageUrl: "" },
			tiers: {},
		});
	});
});
