/**
 * 推送特性(ADR-0016)的 0.x 老形状 → 最新形状,迁移这一头的用例。
 *
 * 老形状靠**形状**认,共两代:
 * - **第一代**(0.10.0 之前):wordcloud / liveSummary 各是一把特性键 —— features 顶层带着
 *   这两把键、routing 里也各有一份目标。迁移原则是「宁可多收一张卡,不能少掉一条推送」:
 *   全局 features 下播开关 = 旧下播 ∨ 词云 ∨ 总结;per-UP 覆盖(partial)三者有一个显式
 *   true → liveEnd:true、三者都显式 false → false、其余不写 liveEnd 继承全局;
 *   routing 下播目标 = 下播 ∪ 词云 ∪ 总结(保序去重)。
 * - **第二代**(0.10.0 起):`features.liveEndExtras` 小对象 + 订阅上的 `atAll` /
 *   `atAllDefaults`。只改名搬家,下播开关不动;`atAllDefaults` 等于出厂默认就不写进覆盖。
 *
 * 这批用例原先住在 `packages/internal`(`push-extras.test.ts` / `subscription-kinds.test.ts`(后来改名
 * `subscription-identity-shape.test.ts`)/ `p1-internal-guards.test.ts`),当时老数据的兜底挂在 schema 的 preprocess 上、用例是
 * 「`XxxSchema.parse(老形状)`」。兜底搬到迁移器以后它们跟着搬过来:「先过迁移函数、再 `XxxSchema.parse(…)`」,
 * **期望值一个字没改**(它们是独立的真源)。活 schema 现在只认新形状(那边的反面用例在 internal 的
 * `push-extras.test.ts` 末尾)。
 *
 * 身份格(0.x 的 `uid` / `extensionId` + `externalId` → `identity`)与这里钉的推送特性无关:行级的迁移函数不碰它,
 * 收进 `identity` 与两份合成一个文件是文件级的那一步(`migrateSubscriptionFiles`,用例在
 * `./zero-generation-subscriptions.test.ts` 与 `./zero-generation-features.test.ts`)。所以 B 站这几组的输入行带着现在的
 * `identity`,行级迁移函数原样把它带过去;拓展那一组用 0.x 盘上真有的形状(`kind` + `extensionId` + `externalId`),
 * 过 schema 之前借一步 {@link parseExtension} 换成 `identity`。
 *
 * 下面几个 `parseXxx` 先迁移,还钉三件事 —— 这才是「迁移器把老键收拾干净了」:
 * 迁出来的东西里没有老键(活 schema 对老键是剥掉或拒收,漏迁的老键在 parse 出来的值里只会悄悄不见,
 * 所以要直接看迁出来的东西);迁出来的东西再迁一遍不变(幂等);features 这一层还要求迁出来的就是 0.12
 * 的最终形状(冻住的键,见 `expectZeroFeatureFlagsShape`)—— 不拿活 schema 现算一份来比,活词表改名后两者不再相等。
 * routing / 整条订阅这两层迁完仍过活 schema(去重、`extras` 目标 ⊆ 主特性目标那条约束):那是「迁完经活 schema 装载」,
 * 是 1.0 侧的期望(今天 0.x 的键与活 schema 的键还一样;活词表改名后,这两层要在迁移之后补上 1.0 改名那一步再装载)。
 *
 * 输入一律用 `./zero-fixtures.ts` 冻住的 0.x 字面量,不取 internal 的活工厂。
 */

import { SubscriptionRoutingSchema, SubscriptionSchema } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import {
	migrateLegacyFeatureFlags,
	migrateLegacyFeatureFlagsPartial,
	migrateLegacyRouting,
} from "../features.js";
import { migrateGlobals } from "../settings.js";
import {
	migrateBiliSubscriptionRow,
	migrateExtensionSubscriptionRow,
	toIdentityRow,
} from "../subscriptions.js";
import {
	makeZeroGlobals,
	withoutZeroBilibiliApp,
	type ZeroFeatureFlags,
	zeroEmptyRouting,
	zeroEmptySubscription,
} from "./zero-fixtures.js";

const T1 = "10000000-0000-4000-8000-000000000001";
const T2 = "10000000-0000-4000-8000-000000000002";
const T3 = "10000000-0000-4000-8000-000000000003";

const SUB_BASE = zeroEmptySubscription({
	id: "11111111-1111-4111-8111-111111111111",
	identity: { sourceKey: "bilibili", externalId: "12345" },
});

/** 0.12 的七把特性键(迁完 routing / features 里的就是这几把)。 */
const NEW_KEYS = [
	"dynamic",
	"live",
	"liveEnd",
	"liveGuardBuy",
	"superchat",
	"specialDanmaku",
	"specialUserEnter",
] as const;

/** 0.12 的四把附加项键。 */
const EXTRA_KEYS_0X = ["atAllDynamic", "atAllLive", "wordcloud", "liveSummary"] as const;

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

// ── 「迁移自己把活干完」的三道钉子 ─────────────────────────────────────────────────

/** features(全局或 per-UP)这一层:顶层不许留老键。`extras.wordcloud` 是新形状的合法键,只看顶层。 */
function expectNoLegacyFeatureKeys(migrated: unknown): void {
	for (const key of ["wordcloud", "liveSummary", "liveEndExtras"]) {
		expect(migrated, `features 顶层还留着老键 ${key}`).not.toHaveProperty(key);
	}
}

/** routing 这一层:不许留词云 / 总结各自的目标列表。 */
function expectNoLegacyRoutingKeys(migrated: unknown): void {
	for (const key of ["wordcloud", "liveSummary"]) {
		expect(migrated, `routing 还留着老键 ${key}`).not.toHaveProperty(key);
	}
}

/** 一整行订阅:不许留 `atAll` / `atAllDefaults`,routing 与 `overrides.features` 也都已经是新形状。 */
function expectNoLegacyRowKeys(migrated: unknown): void {
	for (const key of ["atAll", "atAllDefaults"]) {
		expect(migrated, `订阅行上还留着老键 ${key}`).not.toHaveProperty(key);
	}
	const row = migrated as { routing?: unknown; overrides?: { features?: unknown } };
	if (row.routing !== undefined) expectNoLegacyRoutingKeys(row.routing);
	if (row.overrides?.features !== undefined) expectNoLegacyFeatureKeys(row.overrides.features);
}

/**
 * 迁出来的全局 features 就是 0.12 的最终形状:七把特性键 + `extras` 里四把附加项,全是布尔,没有别的键。
 * 从前拿活 schema 现算一份来比(`toEqual(FeatureFlagsSchema.parse(…))`);活词表改名之后「0.x 最新形状」不再等于活 schema 的形状,
 * 所以这一条钉在冻住的 0.x 键上。
 */
function expectZeroFeatureFlagsShape(migrated: unknown): asserts migrated is ZeroFeatureFlags {
	const m = migrated as Record<string, unknown>;
	expect(Object.keys(m).sort()).toEqual([...NEW_KEYS, "extras"].sort());
	for (const k of NEW_KEYS) expect(typeof m[k], k).toBe("boolean");
	const extras = m.extras as Record<string, unknown>;
	expect(Object.keys(extras).sort()).toEqual([...EXTRA_KEYS_0X].sort());
	for (const k of EXTRA_KEYS_0X) expect(typeof extras[k], `extras.${k}`).toBe("boolean");
}

/** 迁出来的 per-UP features 覆盖(partial)是 0.12 的最终形状:键只能是那七把特性键与 `extras`,值全是布尔,附加项键也只认那四把。 */
function expectZeroFeatureFlagsPartialShape(migrated: unknown): void {
	const m = migrated as Record<string, unknown>;
	for (const [k, v] of Object.entries(m)) {
		if (k === "extras") {
			for (const [ek, ev] of Object.entries(v as Record<string, unknown>)) {
				expect(EXTRA_KEYS_0X as readonly string[], `extras.${ek}`).toContain(ek);
				expect(typeof ev, `extras.${ek}`).toBe("boolean");
			}
		} else {
			expect(NEW_KEYS as readonly string[], `features.${k}`).toContain(k);
			expect(typeof v, k).toBe("boolean");
		}
	}
}

/** 全局 features:先迁移、再钉最终形状。 */
function parseFeatures(old: unknown) {
	const migrated = migrateLegacyFeatureFlags(old);
	expectNoLegacyFeatureKeys(migrated);
	expect(migrateLegacyFeatureFlags(migrated)).toEqual(migrated);
	expectZeroFeatureFlagsShape(migrated);
	return migrated;
}

/** per-UP features 覆盖(单独一份 partial):先迁移、再钉最终形状。 */
function parseFeaturesPartial(old: unknown) {
	const migrated = migrateLegacyFeatureFlagsPartial(old);
	expectNoLegacyFeatureKeys(migrated);
	expect(migrateLegacyFeatureFlagsPartial(migrated)).toEqual(migrated);
	expectZeroFeatureFlagsPartialShape(migrated);
	return migrated as Record<string, unknown>;
}

/** routing(单独一份):先迁移、再过 schema。schema 还管去重,所以迁出来的不必等于 parse 的结果。 */
function parseRouting(old: unknown) {
	const migrated = migrateLegacyRouting(old);
	expectNoLegacyRoutingKeys(migrated);
	expect(migrateLegacyRouting(migrated)).toEqual(migrated);
	return SubscriptionRoutingSchema.parse(migrated);
}

/** 整条 B 站订阅:先迁移、再过 schema(盘上读这份用的就是 `SubscriptionSchema`)。 */
function parseBili(old: unknown) {
	const migrated = migrateBiliSubscriptionRow(old);
	expectNoLegacyRowKeys(migrated);
	expect(migrateBiliSubscriptionRow(migrated)).toEqual(migrated);
	return SubscriptionSchema.parse(migrated);
}

/**
 * 迁完的拓展订阅行(0.x 最新的形状:`kind` + `extensionId` + `externalId`)换成现在 schema 认的样子再过 schema。
 * 身份收进 `identity` 那一步归文件级的合并(见头部的说明),这里只借它过 schema。
 */
function parseExtension(migrated: unknown) {
	return SubscriptionSchema.parse(toIdentityRow(migrated, "extension"));
}

// ── 全局 features ────────────────────────────────────────────────────────────────

describe("全局 features 迁移", () => {
	it("第一代:下播关着、只开了词云 → 下播开、词云开、总结关;@全体 那两把补出厂默认", () => {
		const parsed = parseFeatures({ ...LEGACY_FLAGS, wordcloud: true });
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
		const parsed = parseFeatures(LEGACY_FLAGS);
		expect(parsed.liveEnd).toBe(false);
		expect(parsed.extras.wordcloud).toBe(false);
		expect(parsed.extras.liveSummary).toBe(false);
	});

	it("第二代:liveEndExtras 改名搬进 extras,下播开关不动、@全体 补出厂默认", () => {
		const parsed = parseFeatures({
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

	// 补默认用的是迁移器自己冻着的 0.12 出厂值(`zero-vocabulary.ts`)。别的用例里词云 / 总结要么两把都写了、要么都没写,
	// 单写一把时没写的那把落在出厂默认上 —— 这条把「词云 / 总结出厂都是开」钉在 0.x 的字面量上。
	it("第二代:liveEndExtras 里只写了一把 → 没写的那把补 0.12 的出厂默认(词云 / 总结出厂都是开)", () => {
		const base = {
			dynamic: true,
			live: true,
			liveEnd: true,
			liveGuardBuy: false,
			superchat: false,
			specialDanmaku: false,
			specialUserEnter: false,
		};
		expect(parseFeatures({ ...base, liveEndExtras: { liveSummary: false } }).extras).toEqual({
			atAllDynamic: false,
			atAllLive: true,
			wordcloud: true,
			liveSummary: false,
		});
		expect(parseFeatures({ ...base, liveEndExtras: { wordcloud: false } }).extras).toEqual({
			atAllDynamic: false,
			atAllLive: true,
			wordcloud: false,
			liveSummary: true,
		});
	});

	it("新形状不再动:下播关着、附加项开着就照存(关掉下播不会被翻回来)", () => {
		const fresh = {
			...makeZeroGlobals().defaults.features,
			liveEnd: false,
			extras: {
				atAllDynamic: true,
				atAllLive: false,
				wordcloud: true,
				liveSummary: true,
			},
		};
		// 新形状过迁移函数原样不变。
		expect(migrateLegacyFeatureFlags(fresh)).toEqual(fresh);
		expect(parseFeatures(fresh)).toEqual(fresh);
	});
});

// ── 整份 globals ─────────────────────────────────────────────────────────────────

describe("整份 globals 迁移", () => {
	function globalsWith(features: unknown): Record<string, unknown> {
		const base = makeZeroGlobals();
		return { ...base, defaults: { ...base.defaults, features } };
	}

	/** 整份 globals 去掉 `defaults.features` 之后剩下的部分 —— 迁移只该动那一格。 */
	function withoutFeatures(globals: unknown): unknown {
		const g = globals as { defaults: Record<string, unknown> };
		return { ...g, defaults: { ...g.defaults, features: null } };
	}

	it("第一代 defaults.features 经整份 globals 照样迁(其余键一个不动)", () => {
		const input = globalsWith({ ...LEGACY_FLAGS, wordcloud: true });
		const migrated = migrateGlobals(input);
		expect((migrated as { defaults: { features: unknown } }).defaults.features).toEqual({
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
		expectNoLegacyFeatureKeys((migrated as { defaults: { features: unknown } }).defaults.features);
		expect(withoutFeatures(migrated)).toEqual(withoutFeatures(input));
		// 幂等。
		expect(migrateGlobals(migrated)).toEqual(migrated);
	});

	it("新形状的整份 globals 过迁移函数原样不变", () => {
		// 要的是「设置迁移器无事可做」的整份:去掉 B 站那三格(1.0 搬进了 settings/bilibili.json,见 `zero-fixtures.ts`)。
		const fresh = withoutZeroBilibiliApp(makeZeroGlobals());
		expect(migrateGlobals(fresh)).toEqual(fresh);
	});

	it.each([
		["不是对象", null],
		["没有 defaults", { app: {} }],
		["defaults 不是对象", { app: {}, defaults: 3 }],
		["defaults 里没有 features", { app: {}, defaults: {} }],
	])("认不得的形状原样放过(%s)", (_name, raw) => {
		expect(migrateGlobals(raw)).toEqual(raw);
	});
});

// ── per-UP features 覆盖(partial)──────────────────────────────────────────────────

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
		expect(parseFeaturesPartial(raw)).toEqual(expected);
	});

	it("第二代:只改名,下播开关不碰;没写过的附加项**不补默认**(补了就是凭空长出覆盖)", () => {
		const parsed = parseFeaturesPartial({
			liveEnd: false,
			liveEndExtras: { wordcloud: false },
		});
		expect(parsed).toEqual({ liveEnd: false, extras: { wordcloud: false } });
	});

	it("新形状的 partial 原样通过", () => {
		const fresh = { liveEnd: false, extras: { wordcloud: false } };
		expect(migrateLegacyFeatureFlagsPartial(fresh)).toEqual(fresh);
		expect(parseFeaturesPartial(fresh)).toEqual(fresh);
	});

	it("单看 partial,只有 liveEnd:false 分不出新老 → 照存(新形状里它就是「关下播」)", () => {
		expect(parseFeaturesPartial({ liveEnd: false })).toEqual({ liveEnd: false });
	});

	// internal 里没有对应用例:那边的 partial schema 不带 `force`,这一条路只有整条订阅认得出第一代 routing 时才走
	// (见下面「整条第一代订阅」),这里直接钉住迁移函数的这个参数。
	it("force:单看 partial 分不出的 liveEnd:false 也按第一代迁 → 词云 / 总结没写,不写 liveEnd(继承全局)", () => {
		const migrated = migrateLegacyFeatureFlagsPartial({ liveEnd: false, dynamic: false }, true);
		expect(migrated).toEqual({ dynamic: false, extras: {} });
		expectZeroFeatureFlagsPartialShape(migrated);
	});
});

// ── routing ──────────────────────────────────────────────────────────────────────

describe("routing 迁移", () => {
	it("第一代 9 把键:下播目标 = 下播 ∪ 词云 ∪ 总结,保序去重;老键不留", () => {
		const parsed = parseBili({
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
		const parsed = parseBili({
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
		const parsed = parseBili({
			...SUB_BASE,
			routing: { ...SUB_BASE.routing, wordcloud: [], liveSummary: [] },
			overrides: { features: { liveEnd: false, dynamic: false } },
		});
		expect(parsed.overrides.features).toEqual({ dynamic: false, extras: {} });
	});

	it("新形状的订阅原样通过", () => {
		const fresh = {
			...SUB_BASE,
			routing: { ...SUB_BASE.routing, liveEnd: [T1] },
			overrides: { features: { extras: { liveSummary: false } } },
		};
		expect(migrateBiliSubscriptionRow(fresh)).toEqual(fresh);
		expect(parseBili(fresh)).toEqual(fresh);
	});

	// 原出自 p1-internal-guards.test.ts(那边现在只喂新形状、纯钉去重)。这里留着带第一代老键(词云 / 总结各一份空表)的
	// 输入:迁完的 routing 仍要能被去重,迁移不该把重复目标搞丢、也不该让去重那一步接不上。
	it("同 feature 重复 target 解析后归一(幂等,不 reject)", () => {
		const dup = "550e8400-e29b-41d4-a716-446655440000";
		const parsed = parseRouting({
			dynamic: [dup, dup, dup],
			live: [dup],
			liveEnd: [],
			liveGuardBuy: [],
			superchat: [],
			wordcloud: [],
			liveSummary: [],
			specialDanmaku: [],
			specialUserEnter: [],
		});
		expect(parsed.dynamic).toEqual([dup]);
		expect(parsed.live).toEqual([dup]);
	});

	it("新形状的 routing 原样通过", () => {
		const fresh = { ...SUB_BASE.routing, liveEnd: [T1, T2] };
		expect(migrateLegacyRouting(fresh)).toEqual(fresh);
		expect(parseRouting(fresh)).toEqual(fresh);
	});
});

// ── @全体 并进附加项 ─────────────────────────────────────────────────────────────

describe("@全体 并进附加项(第二代订阅的迁移)", () => {
	/**
	 * 一条第二代订阅:@全体 住在订阅自己的两格上。`atAllDefaults` 是**必填带默认**的,
	 * 所以老数据里人人都有 —— 迁移的关键就在这儿。
	 */
	function legacyAtAllSub(over: {
		routing?: Partial<typeof SUB_BASE.routing>;
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
		const parsed = parseBili(
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
			parseBili(
				legacyAtAllSub({
					routing: { dynamic: [] },
					atAll: { dynamic: { [T1]: true }, live: {} },
				}),
			),
		).toThrow(/extras\.atAllDynamic keys must be a subset of routing\.dynamic/);
	});

	it("那条约束按注册表遍历 —— 词云那把守的是 routing.liveEnd", () => {
		const base = parseBili(legacyAtAllSub({ routing: { liveEnd: [T1] } }));
		expect(() =>
			parseBili({ ...base, extras: { ...base.extras, wordcloud: { [T2]: false } } }),
		).toThrow(/extras\.wordcloud keys must be a subset of routing\.liveEnd/);
		expect(
			parseBili({
				...base,
				extras: { ...base.extras, wordcloud: { [T1]: false } },
			}).extras.wordcloud,
		).toEqual({ [T1]: false });
	});

	it("atAllDefaults 等于出厂默认 → 一个字都不写进 overrides", () => {
		// 不这么办的话,每条订阅都会凭空长出一份无意义的 per-UP 覆盖。
		const parsed = parseBili(legacyAtAllSub({ atAllDefaults: { dynamic: false, live: true } }));
		expect(parsed.overrides.features).toBeUndefined();
	});

	it("atAllDefaults 不等于出厂默认 → 只写不一样的那把,已有的 features 覆盖不受影响", () => {
		const parsed = parseBili(
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
		const parsed = parseBili(
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
		const fresh = {
			...SUB_BASE,
			routing: { ...SUB_BASE.routing, live: [T1] },
			extras: { ...SUB_BASE.extras, atAllLive: { [T1]: true } },
		};
		expect(migrateBiliSubscriptionRow(fresh)).toEqual(fresh);
		expect(parseBili(fresh)).toEqual(fresh);
	});

	// 原出自 subscription-kinds.test.ts,当时钉的是「老数据迁移经联合那一份也跑」(迁移挂在 schema 上)。现在钉的是盘上真实的
	// 形状:0.x 的行身份在顶层 `uid`、没有 `identity`,迁移器照样认得出是老订阅;身份格行级迁移函数不碰(留给文件那一步
	// 收进 `identity`),所以过 schema 之前把 `identity` 补上。
	it("盘上身份还在顶层 uid 的第二代订阅行:@全体 并进 extras,uid 原样留着交给文件级那一步", () => {
		const { identity, ...diskRow } = SUB_BASE;
		const migrated = migrateBiliSubscriptionRow({
			...diskRow,
			uid: identity.externalId,
			routing: { ...SUB_BASE.routing, dynamic: [T1] },
			atAll: { dynamic: { [T1]: true } },
		});
		expectNoLegacyRowKeys(migrated);
		expect(migrated).toMatchObject({ uid: "12345" });
		const parsed = SubscriptionSchema.parse({ ...(migrated as object), identity });
		expect(parsed.extras.atAllDynamic).toEqual({ [T1]: true });
	});
});

// ── 拓展订阅 ─────────────────────────────────────────────────────────────────────
//
// 这一组 internal 里没有对应用例(那边没人拿老形状喂过 schema):拓展订阅一行只有 routing 与
// `overrides.features` 两步,没有 B 站那行外层的 @全体 / `force` —— 迁移函数把「行」这一层的组合也钉住。

describe("拓展订阅一行的迁移", () => {
	function extRow(over: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			kind: "extension",
			id: "22222222-2222-4222-8222-222222222222",
			extensionId: "douyin",
			externalId: "MS4wLjABAAAA-sec_uid",
			enabled: true,
			groups: [],
			routing: zeroEmptyRouting(),
			overrides: {},
			...over,
		};
	}

	it("第一代 routing 与第二代 overrides.features 各迁各的", () => {
		const migrated = migrateExtensionSubscriptionRow(
			extRow({
				routing: {
					...(extRow().routing as object),
					liveEnd: [T1],
					wordcloud: [T2],
					liveSummary: [],
				},
				overrides: { features: { liveEnd: false, liveEndExtras: { wordcloud: false } } },
			}),
		);
		expectNoLegacyRowKeys(migrated);
		expect(migrateExtensionSubscriptionRow(migrated)).toEqual(migrated);
		const parsed = parseExtension(migrated);
		expect(parsed.routing.liveEnd).toEqual([T1, T2]);
		expect(parsed.overrides.features).toEqual({ liveEnd: false, extras: { wordcloud: false } });
	});

	it("没有 B 站那一行的外层步骤:第一代 routing 不会让 overrides.features 走 force", () => {
		const row = extRow({
			routing: { ...(extRow().routing as object), wordcloud: [], liveSummary: [] },
			overrides: { features: { liveEnd: false, dynamic: false } },
		});
		const migrated = migrateExtensionSubscriptionRow(row) as { overrides: { features: unknown } };
		// B 站那一行在同样的输入上会把这份覆盖迁成 `{ dynamic: false, extras: {} }`(见 routing 那一组);
		// 拓展这一行只做 routing 与 features 各自的判定,单看 `{ liveEnd: false }` 分不出新老 → 照存。
		expect(migrated.overrides.features).toEqual({ liveEnd: false, dynamic: false });
	});

	it("新形状的拓展订阅原样不变", () => {
		const fresh = extRow({ overrides: { features: { extras: { wordcloud: false } } } });
		expect(migrateExtensionSubscriptionRow(fresh)).toEqual(fresh);
		expect(parseExtension(migrateExtensionSubscriptionRow(fresh)).overrides).toEqual({
			features: { extras: { wordcloud: false } },
		});
	});
});
