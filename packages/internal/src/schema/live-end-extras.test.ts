/**
 * 下播 = 卡片本体,词云 / AI 总结是它的两个附加项(像开播的 @全体)。
 *
 * 能配路由的推送类型缩到 7 个;wordcloud / liveSummary 从「各有开关各有路由」变成挂在
 * 下播下面的两个布尔子项 `features.liveEndExtras`,只跟着下播的开关与目标走。
 *
 * 老数据靠**形状**认:features 顶层还带 `wordcloud` / `liveSummary`,或 routing 还有这两把键,
 * 就是老的。迁移原则是「宁可多收一张卡,不能少掉一条推送」:
 * - 全局 features:下播开关 = 旧下播 ∨ 词云 ∨ 总结;两个子项照旧值
 * - per-UP 覆盖(partial):三者有一个显式 true → liveEnd:true;三者都显式 false → false;
 *   其余(有的关、有的没写)→ 不写 liveEnd,继承全局 —— 全局迁完只会更宽,不会丢推送
 * - routing:下播目标 = 下播 ∪ 词云 ∪ 总结(保序去重)
 */

import { describe, expect, it } from "vite-plus/test";
import { FEATURE_KEYS } from "../constants";
import { FeatureFlagsPartialSchema, FeatureFlagsSchema } from "./common";
import { makeDefaultGlobalConfig } from "./globals";
import { resolve } from "./resolve";
import { makeEmptySubscription, type Subscription, SubscriptionSchema } from "./subscriptions";

const T1 = "10000000-0000-4000-8000-000000000001";
const T2 = "10000000-0000-4000-8000-000000000002";
const T3 = "10000000-0000-4000-8000-000000000003";

const SUB_BASE: Subscription = makeEmptySubscription({
	id: "11111111-1111-4111-8111-111111111111",
	uid: "12345",
});

const NEW_KEYS = [
	"dynamic",
	"live",
	"liveEnd",
	"liveGuardBuy",
	"superchat",
	"specialDanmaku",
	"specialUserEnter",
] as const;

/** 老 features(9 个平铺布尔)的一份基线,各用例只改关心的那几位。 */
const LEGACY_FLAGS = {
	dynamic: true,
	live: true,
	liveEnd: false,
	liveGuardBuy: false,
	superchat: false,
	wordcloud: false,
	liveSummary: false,
	specialDanmaku: false,
	specialUserEnter: false,
};

describe("推送类型缩到 7 个", () => {
	it("FEATURE_KEYS 不再含 wordcloud / liveSummary", () => {
		expect([...FEATURE_KEYS]).toEqual([...NEW_KEYS]);
	});

	it("makeEmptySubscription 的 routing 正好这 7 把键", () => {
		expect(Object.keys(SUB_BASE.routing).sort()).toEqual([...NEW_KEYS].sort());
	});

	it("出厂默认:下播开着,两个附加项也开着", () => {
		expect(makeDefaultGlobalConfig().defaults.features).toEqual({
			dynamic: true,
			live: true,
			liveEnd: true,
			liveGuardBuy: false,
			superchat: false,
			specialDanmaku: false,
			specialUserEnter: false,
			liveEndExtras: { wordcloud: true, liveSummary: true },
		});
	});
});

describe("全局 features 迁移", () => {
	it("老形状:下播关着、只开了词云 → 下播开、词云子项开、总结子项关", () => {
		const parsed = FeatureFlagsSchema.parse({ ...LEGACY_FLAGS, wordcloud: true });
		expect(parsed).toEqual({
			dynamic: true,
			live: true,
			liveEnd: true,
			liveGuardBuy: false,
			superchat: false,
			specialDanmaku: false,
			specialUserEnter: false,
			liveEndExtras: { wordcloud: true, liveSummary: false },
		});
	});

	it("老形状:三者全关 → 下播关", () => {
		const parsed = FeatureFlagsSchema.parse(LEGACY_FLAGS);
		expect(parsed.liveEnd).toBe(false);
		expect(parsed.liveEndExtras).toEqual({ wordcloud: false, liveSummary: false });
	});

	it("新形状不再动:下播关着、子项开着就照存(关掉下播不会被翻回来)", () => {
		const fresh = {
			...makeDefaultGlobalConfig().defaults.features,
			liveEnd: false,
			liveEndExtras: { wordcloud: true, liveSummary: true },
		};
		expect(FeatureFlagsSchema.parse(fresh)).toEqual(fresh);
	});
});

describe("per-UP features 覆盖迁移(partial)", () => {
	it.each<[string, Record<string, boolean>, Record<string, unknown>]>([
		[
			"只写了 liveSummary:true",
			{ liveSummary: true },
			{ liveEnd: true, liveEndExtras: { liveSummary: true } },
		],
		[
			"三者都显式 false",
			{ liveEnd: false, wordcloud: false, liveSummary: false },
			{ liveEnd: false, liveEndExtras: { wordcloud: false, liveSummary: false } },
		],
		[
			"liveEnd 关、词云关、总结没写 → 不写 liveEnd(继承全局),词云子项照存",
			{ liveEnd: false, wordcloud: false },
			{ liveEndExtras: { wordcloud: false } },
		],
		[
			"liveEnd 显式 true 照旧,别的键不动",
			{ liveEnd: true, dynamic: false },
			{ liveEnd: true, dynamic: false },
		],
	])("老形状:%s", (_name, raw, expected) => {
		expect(FeatureFlagsPartialSchema.parse(raw)).toEqual(expected);
	});

	it("新形状的 partial 原样通过", () => {
		const fresh = { liveEnd: false, liveEndExtras: { wordcloud: false } };
		expect(FeatureFlagsPartialSchema.parse(fresh)).toEqual(fresh);
	});

	it("单看 partial,只有 liveEnd:false 分不出新老 → 照存(新形状里它就是「关下播」)", () => {
		expect(FeatureFlagsPartialSchema.parse({ liveEnd: false })).toEqual({ liveEnd: false });
	});
});

describe("routing 迁移", () => {
	it("老形状 9 把键:下播目标 = 下播 ∪ 词云 ∪ 总结,保序去重;老键不留", () => {
		const parsed = SubscriptionSchema.parse({
			...SUB_BASE,
			routing: {
				dynamic: [],
				live: [],
				liveEnd: [T1],
				liveGuardBuy: [],
				superchat: [],
				wordcloud: [T2, T1],
				liveSummary: [T3],
				specialDanmaku: [],
				specialUserEnter: [],
			},
		});
		expect(parsed.routing.liveEnd).toEqual([T1, T2, T3]);
		expect(Object.keys(parsed.routing).sort()).toEqual([...NEW_KEYS].sort());
	});

	it("整条老订阅:routing 与 overrides.features 一起迁", () => {
		const parsed = SubscriptionSchema.parse({
			...SUB_BASE,
			routing: { ...SUB_BASE.routing, wordcloud: [T2], liveSummary: [] },
			overrides: { features: { liveEnd: false, wordcloud: true } },
		});
		expect(parsed.routing.liveEnd).toEqual([T2]);
		expect(parsed.overrides.features).toEqual({
			liveEnd: true,
			liveEndExtras: { wordcloud: true },
		});
	});

	it("老订阅(routing 还是 9 把键)里只关了 liveEnd 的覆盖 → 靠 routing 认出是老的,liveEnd 不写、继承全局", () => {
		// 单看 `{ liveEnd: false }` 分不出新老(见 partial 那组),但整条订阅能看 routing 的形状:
		// 老 routing 的订阅一定是老覆盖 —— 那位 UP 以前关的只是下播卡,词云 / 总结照收。
		const parsed = SubscriptionSchema.parse({
			...SUB_BASE,
			routing: { ...SUB_BASE.routing, wordcloud: [], liveSummary: [] },
			overrides: { features: { liveEnd: false, dynamic: false } },
		});
		expect(parsed.overrides.features).toEqual({ dynamic: false, liveEndExtras: {} });
	});

	it("新形状的订阅原样通过", () => {
		const fresh: Subscription = {
			...SUB_BASE,
			routing: { ...SUB_BASE.routing, liveEnd: [T1] },
			overrides: { features: { liveEndExtras: { liveSummary: false } } },
		};
		expect(SubscriptionSchema.parse(fresh)).toEqual(fresh);
	});
});

describe("resolve():附加项是嵌套合并", () => {
	it("per-UP 只关词云 → 总结仍继承全局,下播开关也继承", () => {
		const globals = makeDefaultGlobalConfig();
		const sub: Subscription = {
			...SUB_BASE,
			overrides: { features: { liveEndExtras: { wordcloud: false } } },
		};
		const eff = resolve(sub, globals.defaults);
		expect(eff.features.liveEnd).toBe(true);
		expect(eff.features.liveEndExtras).toEqual({ wordcloud: false, liveSummary: true });
	});

	it("没覆盖时附加项就是全局那份", () => {
		const globals = makeDefaultGlobalConfig();
		globals.defaults.features.liveEndExtras = { wordcloud: false, liveSummary: false };
		expect(resolve(SUB_BASE, globals.defaults).features.liveEndExtras).toEqual({
			wordcloud: false,
			liveSummary: false,
		});
	});
});
