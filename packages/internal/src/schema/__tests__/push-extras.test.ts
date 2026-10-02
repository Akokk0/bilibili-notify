/**
 * 附加项(ADR-0016):@全体 / 弹幕词云 / AI 总结是同一种东西 —— 挂在某把主特性下面、与
 * 本体分开发的一条消息。四把键一视同仁住在 `features.extras` 与订阅的 `extraTargets` 上。
 *
 * 能配路由的推送类型是 8 个。0.x 的老形状 —— 第一代(wordcloud / liveSummary 各是一把特性键)、
 * 第二代(`liveEndExtras` 小对象 + 订阅上的 `atAll` / `atAllDefaults`)—— **不在这里认**:它们只在开新代时
 * 由迁移器改写一次(`apps/server/src/migration/features.ts`,用例在 `apps/server/src/migration/__tests__/`),
 * 活 schema 只认新形状。文件末尾那一组钉住这一点。
 */

import { describe, expect, it } from "vite-plus/test";
import { EXTRA_KEYS, FEATURE_KEYS, PUSH_EXTRAS } from "../../constants";
import { FeatureFlagsPartialSchema, FeatureFlagsSchema } from "../common";
import { makeDefaultGlobalConfig } from "../globals";
import { resolve } from "../resolve";
import {
	makeEmptySubscription,
	type Subscription,
	SubscriptionRoutingSchema,
	SubscriptionSchema,
} from "../subscriptions";

const T1 = "10000000-0000-4000-8000-000000000001";
const T2 = "10000000-0000-4000-8000-000000000002";
const T3 = "10000000-0000-4000-8000-000000000003";

const SUB_BASE: Subscription = makeEmptySubscription({
	id: "11111111-1111-4111-8111-111111111111",
	identity: { sourceKey: "bilibili", externalId: "12345" },
});

const NEW_KEYS = [
	"post",
	"liveStart",
	"liveStreaming",
	"liveEnd",
	"membership",
	"superchat",
	"specialDanmaku",
	"specialUserEnter",
] as const;

/**
 * 第一代 features(9 个平铺布尔)的一份基线 —— 只拿来喂「活 schema 不再认老形状」那一组。特性键写 1.0 的名字:
 * 这一组要钉的是第一代的**形状**(顶层平铺的词云 / 总结、没有 `extras`),不该因为特性键没改名先红。
 */
const LEGACY_FLAGS = {
	post: true,
	liveStart: true,
	liveStreaming: false,
	liveEnd: false,
	membership: false,
	superchat: false,
	wordcloud: false,
	liveSummary: false,
	specialDanmaku: false,
	specialUserEnter: false,
};

describe("推送类型缩到 8 个", () => {
	it("FEATURE_KEYS 不再含 wordcloud / liveSummary", () => {
		expect([...FEATURE_KEYS]).toEqual([...NEW_KEYS]);
	});

	it("全局特性开关的 schema 是从 FEATURE_KEYS 摊出来的:键 = 八把特性键 + extras,不另手写一份", () => {
		expect(Object.keys(FeatureFlagsSchema.shape)).toEqual([...FEATURE_KEYS, "extras"]);
	});

	it("makeEmptySubscription 的 routing 正好这 8 把键", () => {
		expect(Object.keys(SUB_BASE.routing).sort()).toEqual([...NEW_KEYS].sort());
	});

	it("makeEmptySubscription 的 extraTargets 正好这 4 把键,每把一张空表", () => {
		expect(SUB_BASE.extraTargets).toEqual({
			atAllPost: {},
			atAllLiveStart: {},
			wordcloud: {},
			liveSummary: {},
		});
	});

	it("每把附加项都挂在一把真的主特性下", () => {
		for (const k of EXTRA_KEYS) {
			expect(FEATURE_KEYS).toContain(PUSH_EXTRAS[k].feature);
		}
	});

	it("出厂默认:下播开着,附加项照注册表(作品 @全体 关、开播 @全体 开、词云 / 总结开)", () => {
		expect(makeDefaultGlobalConfig().defaults.features).toEqual({
			post: true,
			liveStart: true,
			liveStreaming: false,
			liveEnd: true,
			membership: false,
			superchat: false,
			specialDanmaku: false,
			specialUserEnter: false,
			extras: {
				atAllPost: false,
				atAllLiveStart: true,
				wordcloud: true,
				liveSummary: true,
			},
		});
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
			atAllPost: false,
			atAllLiveStart: true,
			wordcloud: false,
			liveSummary: true,
		});
	});

	it("没覆盖时附加项就是全局那份", () => {
		const globals = makeDefaultGlobalConfig();
		globals.defaults.features.extras = {
			atAllPost: true,
			atAllLiveStart: false,
			wordcloud: false,
			liveSummary: false,
		};
		expect(resolve(SUB_BASE, globals.defaults).features.extras).toEqual({
			atAllPost: true,
			atAllLiveStart: false,
			wordcloud: false,
			liveSummary: false,
		});
	});
});

describe("活 schema 不再认老形状(那是迁移器的事)", () => {
	// schema 上没有 preprocess:喂老形状进来得到的是「不认」或「剥掉老键」,而不是「悄悄帮你迁」。
	// 谁把老数据的兜底加回 schema,这几条就红 —— 那会让同一份迁移逻辑在 schema 和迁移器里各住一份。

	it("第一代全局 features(顶层 wordcloud / liveSummary、没有 extras)→ 拒收", () => {
		expect(FeatureFlagsSchema.safeParse({ ...LEGACY_FLAGS, wordcloud: true }).success).toBe(false);
	});

	it("第一代 routing:词云 / 总结的目标不会并进下播,老键被剥掉、liveEnd 只剩它自己那份", () => {
		const parsed = SubscriptionRoutingSchema.parse({
			post: [],
			liveStart: [],
			liveStreaming: [],
			liveEnd: [T1],
			membership: [],
			superchat: [],
			wordcloud: [T2],
			liveSummary: [T3],
			specialDanmaku: [],
			specialUserEnter: [],
		});
		expect(parsed.liveEnd).toEqual([T1]);
		expect(Object.keys(parsed).sort()).toEqual([...NEW_KEYS].sort());
	});

	it("per-UP 覆盖里的第一代键不会被搬进 extras:wordcloud 被剥掉,liveEnd 不被改写", () => {
		expect(FeatureFlagsPartialSchema.parse({ liveEnd: false, wordcloud: true })).toEqual({
			liveEnd: false,
		});
	});

	it("订阅上的 atAll / atAllDefaults 不会并进 extraTargets / overrides:老键被剥掉,extraTargets 留空表", () => {
		const { extraTargets: _gone, ...base } = SUB_BASE;
		const parsed = SubscriptionSchema.parse({
			...base,
			routing: { ...SUB_BASE.routing, liveStart: [T1] },
			// 0.x 第二代的老键,故意还是 0.x 的名字:这一条钉的是「老形状不被认」。
			atAllDefaults: { dynamic: true, live: false },
			atAll: { live: { [T1]: true } },
		});
		expect(parsed.extraTargets.atAllLiveStart).toEqual({});
		expect(parsed.overrides.features).toBeUndefined();
		expect(parsed).not.toHaveProperty("atAll");
		expect(parsed).not.toHaveProperty("atAllDefaults");
	});
});
