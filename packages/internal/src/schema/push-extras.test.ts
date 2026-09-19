/**
 * 附加项(ADR-0016):@全体 / 弹幕词云 / AI 总结是同一种东西 —— 挂在某把主特性下面、与
 * 本体分开发的一条消息。四把键一视同仁住在 `features.extras` 与订阅的 `extras` 上。
 *
 * 能配路由的推送类型仍是 7 个。老数据靠**形状**认,共两代:
 * - **第一代**(0.10.0 之前):wordcloud / liveSummary 各是一把特性键 —— features 顶层带着
 *   这两把键、routing 里也各有一份目标。迁移原则是「宁可多收一张卡,不能少掉一条推送」:
 *   全局 features 下播开关 = 旧下播 ∨ 词云 ∨ 总结;per-UP 覆盖(partial)三者有一个显式
 *   true → liveEnd:true、三者都显式 false → false、其余不写 liveEnd 继承全局;
 *   routing 下播目标 = 下播 ∪ 词云 ∪ 总结(保序去重)。
 * - **第二代**(0.10.0 起):`features.liveEndExtras` 小对象 + 订阅上的 `atAll` /
 *   `atAllDefaults`。只改名搬家,下播开关不动;`atAllDefaults` 等于出厂默认就不写进覆盖。
 */

import { describe, expect, it } from "vite-plus/test";
import { EXTRA_KEYS, FEATURE_KEYS, PUSH_EXTRAS } from "../constants";
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

	it("makeEmptySubscription 的 extras 正好这 4 把键,每把一张空表", () => {
		expect(SUB_BASE.extras).toEqual({
			atAllDynamic: {},
			atAllLive: {},
			wordcloud: {},
			liveSummary: {},
		});
	});

	it("每把附加项都挂在一把真的主特性下", () => {
		for (const k of EXTRA_KEYS) {
			expect(FEATURE_KEYS).toContain(PUSH_EXTRAS[k].feature);
		}
	});

	it("出厂默认:下播开着,附加项照注册表(动态 @全体 关、开播 @全体 开、词云 / 总结开)", () => {
		expect(makeDefaultGlobalConfig().defaults.features).toEqual({
			dynamic: true,
			live: true,
			liveEnd: true,
			liveGuardBuy: false,
			superchat: false,
			specialDanmaku: false,
			specialUserEnter: false,
			extras: {
				atAllDynamic: false,
				atAllLive: true,
				wordcloud: true,
				liveSummary: true,
			},
		});
	});
});

describe("全局 features 迁移", () => {
	it("第一代:下播关着、只开了词云 → 下播开、词云开、总结关;@全体 那两把补出厂默认", () => {
		const parsed = FeatureFlagsSchema.parse({ ...LEGACY_FLAGS, wordcloud: true });
		expect(parsed).toEqual({
			dynamic: true,
			live: true,
			liveEnd: true,
			liveGuardBuy: false,
			superchat: false,
			specialDanmaku: false,
			specialUserEnter: false,
			extras: {
				atAllDynamic: false,
				atAllLive: true,
				wordcloud: true,
				liveSummary: false,
			},
		});
	});

	it("第一代:三者全关 → 下播关", () => {
		const parsed = FeatureFlagsSchema.parse(LEGACY_FLAGS);
		expect(parsed.liveEnd).toBe(false);
		expect(parsed.extras.wordcloud).toBe(false);
		expect(parsed.extras.liveSummary).toBe(false);
	});

	it("第二代:liveEndExtras 改名搬进 extras,下播开关不动、@全体 补出厂默认", () => {
		const parsed = FeatureFlagsSchema.parse({
			dynamic: true,
			live: true,
			liveEnd: false,
			liveGuardBuy: false,
			superchat: false,
			specialDanmaku: false,
			specialUserEnter: false,
			liveEndExtras: { wordcloud: false, liveSummary: true },
		});
		// 第二代的 liveEnd 已经是新语义 —— 关着就是关着,别被词云 / 总结翻回来。
		expect(parsed.liveEnd).toBe(false);
		expect(parsed.extras).toEqual({
			atAllDynamic: false,
			atAllLive: true,
			wordcloud: false,
			liveSummary: true,
		});
	});

	it("新形状不再动:下播关着、附加项开着就照存(关掉下播不会被翻回来)", () => {
		const fresh = {
			...makeDefaultGlobalConfig().defaults.features,
			liveEnd: false,
			extras: {
				atAllDynamic: true,
				atAllLive: false,
				wordcloud: true,
				liveSummary: true,
			},
		};
		expect(FeatureFlagsSchema.parse(fresh)).toEqual(fresh);
	});
});

describe("per-UP features 覆盖迁移(partial)", () => {
	it.each<[string, Record<string, boolean>, Record<string, unknown>]>([
		[
			"只写了 liveSummary:true",
			{ liveSummary: true },
			{ liveEnd: true, extras: { liveSummary: true } },
		],
		[
			"三者都显式 false",
			{ liveEnd: false, wordcloud: false, liveSummary: false },
			{ liveEnd: false, extras: { wordcloud: false, liveSummary: false } },
		],
		[
			"liveEnd 关、词云关、总结没写 → 不写 liveEnd(继承全局),词云那把照存",
			{ liveEnd: false, wordcloud: false },
			{ extras: { wordcloud: false } },
		],
		[
			"liveEnd 显式 true 照旧,别的键不动",
			{ liveEnd: true, dynamic: false },
			{ liveEnd: true, dynamic: false },
		],
	])("第一代:%s", (_name, raw, expected) => {
		expect(FeatureFlagsPartialSchema.parse(raw)).toEqual(expected);
	});

	it("第二代:只改名,下播开关不碰;没写过的附加项**不补默认**(补了就是凭空长出覆盖)", () => {
		const parsed = FeatureFlagsPartialSchema.parse({
			liveEnd: false,
			liveEndExtras: { wordcloud: false },
		});
		expect(parsed).toEqual({ liveEnd: false, extras: { wordcloud: false } });
	});

	it("新形状的 partial 原样通过", () => {
		const fresh = { liveEnd: false, extras: { wordcloud: false } };
		expect(FeatureFlagsPartialSchema.parse(fresh)).toEqual(fresh);
	});

	it("单看 partial,只有 liveEnd:false 分不出新老 → 照存(新形状里它就是「关下播」)", () => {
		expect(FeatureFlagsPartialSchema.parse({ liveEnd: false })).toEqual({ liveEnd: false });
	});
});

describe("routing 迁移", () => {
	it("第一代 9 把键:下播目标 = 下播 ∪ 词云 ∪ 总结,保序去重;老键不留", () => {
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

	it("整条第一代订阅:routing 与 overrides.features 一起迁", () => {
		const parsed = SubscriptionSchema.parse({
			...SUB_BASE,
			routing: { ...SUB_BASE.routing, wordcloud: [T2], liveSummary: [] },
			overrides: { features: { liveEnd: false, wordcloud: true } },
		});
		expect(parsed.routing.liveEnd).toEqual([T2]);
		expect(parsed.overrides.features).toEqual({
			liveEnd: true,
			extras: { wordcloud: true },
		});
	});

	it("第一代订阅(routing 还是 9 把键)里只关了 liveEnd 的覆盖 → 靠 routing 认出是老的,liveEnd 不写、继承全局", () => {
		// 单看 `{ liveEnd: false }` 分不出新老(见 partial 那组),但整条订阅能看 routing 的形状:
		// 第一代 routing 的订阅一定是第一代覆盖 —— 那位 UP 以前关的只是下播卡,词云 / 总结照收。
		const parsed = SubscriptionSchema.parse({
			...SUB_BASE,
			routing: { ...SUB_BASE.routing, wordcloud: [], liveSummary: [] },
			overrides: { features: { liveEnd: false, dynamic: false } },
		});
		expect(parsed.overrides.features).toEqual({ dynamic: false, extras: {} });
	});

	it("新形状的订阅原样通过", () => {
		const fresh: Subscription = {
			...SUB_BASE,
			routing: { ...SUB_BASE.routing, liveEnd: [T1] },
			overrides: { features: { extras: { liveSummary: false } } },
		};
		expect(SubscriptionSchema.parse(fresh)).toEqual(fresh);
	});
});

describe("resolve():附加项是嵌套合并", () => {
	it("per-UP 只关词云 → 总结仍继承全局,下播开关也继承", () => {
		const globals = makeDefaultGlobalConfig();
		const sub: Subscription = {
			...SUB_BASE,
			overrides: { features: { extras: { wordcloud: false } } },
		};
		const eff = resolve(sub, globals.defaults);
		expect(eff.features.liveEnd).toBe(true);
		expect(eff.features.extras).toEqual({
			atAllDynamic: false,
			atAllLive: true,
			wordcloud: false,
			liveSummary: true,
		});
	});

	it("没覆盖时附加项就是全局那份", () => {
		const globals = makeDefaultGlobalConfig();
		globals.defaults.features.extras = {
			atAllDynamic: true,
			atAllLive: false,
			wordcloud: false,
			liveSummary: false,
		};
		expect(resolve(SUB_BASE, globals.defaults).features.extras).toEqual({
			atAllDynamic: true,
			atAllLive: false,
			wordcloud: false,
			liveSummary: false,
		});
	});
});

describe("@全体 并进附加项(第二代订阅的迁移)", () => {
	/**
	 * 一条第二代订阅:@全体 住在订阅自己的两格上。`atAllDefaults` 是**必填带默认**的,
	 * 所以老数据里人人都有 —— 迁移的关键就在这儿。
	 */
	function legacyAtAllSub(over: {
		routing?: Partial<Subscription["routing"]>;
		atAll?: Record<string, Record<string, boolean>>;
		atAllDefaults?: { dynamic: boolean; live: boolean };
		overrides?: Record<string, unknown>;
	}): Record<string, unknown> {
		const { extras: _gone, ...base } = SUB_BASE;
		return {
			...base,
			routing: { ...SUB_BASE.routing, ...over.routing },
			atAllDefaults: over.atAllDefaults ?? { dynamic: false, live: true },
			atAll: over.atAll ?? { dynamic: {}, live: {} },
			overrides: over.overrides ?? {},
		};
	}

	it("atAll.<scope> 是 per-目标 三态表 → 1:1 搬进 extras.atAll<Scope>", () => {
		const parsed = SubscriptionSchema.parse(
			legacyAtAllSub({
				routing: { dynamic: [T1], live: [T2] },
				atAll: { dynamic: { [T1]: true }, live: { [T2]: false } },
			}),
		);
		expect(parsed.extras.atAllDynamic).toEqual({ [T1]: true });
		expect(parsed.extras.atAllLive).toEqual({ [T2]: false });
		// 新长出来的那两把留空 —— 老数据里没有 per-目标 的词云 / 总结,别凭空造。
		expect(parsed.extras.wordcloud).toEqual({});
		expect(parsed.extras.liveSummary).toEqual({});
	});

	it("搬完仍守「附加项的目标 ⊆ 主特性目标」:key 不在 routing 里就拒收", () => {
		expect(() =>
			SubscriptionSchema.parse(
				legacyAtAllSub({
					routing: { dynamic: [] },
					atAll: { dynamic: { [T1]: true }, live: {} },
				}),
			),
		).toThrow(/extras\.atAllDynamic keys must be a subset of routing\.dynamic/);
	});

	it("那条约束按注册表遍历 —— 词云那把守的是 routing.liveEnd", () => {
		const base = SubscriptionSchema.parse(legacyAtAllSub({ routing: { liveEnd: [T1] } }));
		expect(() =>
			SubscriptionSchema.parse({ ...base, extras: { ...base.extras, wordcloud: { [T2]: false } } }),
		).toThrow(/extras\.wordcloud keys must be a subset of routing\.liveEnd/);
		expect(
			SubscriptionSchema.parse({
				...base,
				extras: { ...base.extras, wordcloud: { [T1]: false } },
			}).extras.wordcloud,
		).toEqual({ [T1]: false });
	});

	it("atAllDefaults 等于出厂默认 → 一个字都不写进 overrides", () => {
		// 不这么办的话,每条订阅都会凭空长出一份无意义的 per-UP 覆盖。
		const parsed = SubscriptionSchema.parse(
			legacyAtAllSub({ atAllDefaults: { dynamic: false, live: true } }),
		);
		expect(parsed.overrides.features).toBeUndefined();
	});

	it("atAllDefaults 不等于出厂默认 → 只写不一样的那把,已有的 features 覆盖不受影响", () => {
		const parsed = SubscriptionSchema.parse(
			legacyAtAllSub({
				atAllDefaults: { dynamic: true, live: true },
				overrides: { features: { dynamic: false } },
			}),
		);
		expect(parsed.overrides.features).toEqual({
			dynamic: false,
			extras: { atAllDynamic: true },
		});
	});

	it("第二代的两处一起迁:liveEndExtras 与 atAllDefaults 落进同一份 extras 覆盖", () => {
		const parsed = SubscriptionSchema.parse(
			legacyAtAllSub({
				atAllDefaults: { dynamic: false, live: false },
				overrides: { features: { liveEndExtras: { wordcloud: false } } },
			}),
		);
		expect(parsed.overrides.features).toEqual({
			extras: { wordcloud: false, atAllLive: false },
		});
	});

	it("新形状的订阅(已有 extras、没有 atAll)原样通过", () => {
		const fresh: Subscription = {
			...SUB_BASE,
			routing: { ...SUB_BASE.routing, live: [T1] },
			extras: { ...SUB_BASE.extras, atAllLive: { [T1]: true } },
		};
		expect(SubscriptionSchema.parse(fresh)).toEqual(fresh);
	});
});
