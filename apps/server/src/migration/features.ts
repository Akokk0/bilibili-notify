/**
 * 推送特性这一组的 0.x 老形状(ADR-0016):附加项的两代(第一代顶层平铺的词云 / 总结、第二代 `liveEndExtras`)、
 * 第一代 routing 里词云 / 总结各自的目标列表、订阅上按 scope 存的 @全体(`atAll` / `atAllDefaults`)。
 * ⑥c 从 internal 的 schema preprocess 里原样收进来:活 schema 只认新形状,这些 raw → raw 的变换只在迁移时跑一次。
 *
 * 四个入口,照 zod 当年跑它们的顺序用(见 `settings.ts`、`subscriptions.ts`):
 * - 全局 `defaults.features` → {@link migrateLegacyFeatureFlags};
 * - B 站订阅整行 → {@link migrateLegacySubscription}(外层先跑),再对它的 `routing` 跑
 *   {@link migrateLegacyRouting}、对 `overrides.features` 跑不带 `force` 的 {@link migrateLegacyFeatureFlagsPartial};
 * - 拓展订阅只有后两步。
 */

import { isPlainObject } from "./files.js";
import { ZERO_EXTRA_DEFAULTS, ZERO_EXTRA_KEYS, type ZeroExtraKey } from "./zero-vocabulary.js";

// ── 附加项的两代老数据(全局 features 与 per-UP 覆盖)──────────────────────────
//
// @全体 那两把当年不住在 features 上(住在订阅的 `atAllDefaults`),它们的迁移在下面订阅那一节。

/** 第一代 / 第二代里住在 features 上的那两把附加项。 */
const LEGACY_LIVE_END_EXTRA_KEYS = ["wordcloud", "liveSummary"] as const;

/**
 * **第一代**(0.10.0 之前)的形状:词云 / 总结各是一把独立的特性键(各有开关、各有路由),
 * 平铺在 features 顶层。顶层还带着这两把键就是第一代。
 */
function hasLegacyTopLevelExtras(raw: Record<string, unknown>): boolean {
	return LEGACY_LIVE_END_EXTRA_KEYS.some((k) => k in raw);
}

/** 两代老数据里这两把附加项**真写过**的值:顶层平铺的,以及 `liveEndExtras` 里的。 */
function pickLegacyExtras(raw: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const k of LEGACY_LIVE_END_EXTRA_KEYS) if (k in raw) out[k] = raw[k];
	const nested = raw.liveEndExtras;
	if (isPlainObject(nested)) {
		for (const k of LEGACY_LIVE_END_EXTRA_KEYS) if (k in nested) out[k] = nested[k];
	}
	return out;
}

function stripLegacyExtras(raw: Record<string, unknown>): Record<string, unknown> {
	const { wordcloud: _w, liveSummary: _s, liveEndExtras: _n, ...rest } = raw;
	return rest;
}

/**
 * 全局 features 的迁移 —— 认**两代**老数据:
 *
 * - **第一代**(0.10.0 之前,顶层平铺):下播开关 = 旧下播 ∨ 词云 ∨ 总结,两把附加项照旧值。
 *   只开了词云 / 总结、没开下播的人,迁完会多收一张下播卡 ——「宁可多收一张卡,不能少掉
 *   一条推送」,CHANGELOG 有 ⚠️ 说明。
 * - **第二代**(0.10.0 到 ADR-0016 之前,`liveEndExtras` 小对象):改个名搬进 `extras`,
 *   下播开关**不动** —— 那一代的下播开关已经是新语义了。
 *
 * 两代都没有的那两把 @全体 补出厂默认:它们当年住在订阅的 `atAllDefaults` 上(per-UP 的值,
 * 见下面的 {@link migrateLegacySubscription}),全局这一层是这次新长出来的,出厂值照 `ZERO_EXTRA_DEFAULTS`
 * (0.12 的出厂值,冻在 `zero-vocabulary.ts`)。
 *
 * 新形状(已有 `extras`)一律不动:关掉下播、附加项留着开,下次加载不会被翻回来。
 */
export function migrateLegacyFeatureFlags(raw: unknown): unknown {
	if (!isPlainObject(raw)) return raw;
	const gen1 = hasLegacyTopLevelExtras(raw);
	if (!gen1 && !("liveEndExtras" in raw)) return raw;
	const picked = pickLegacyExtras(raw);
	const extras: Record<string, unknown> = {};
	for (const k of ZERO_EXTRA_KEYS) extras[k] = k in picked ? picked[k] : ZERO_EXTRA_DEFAULTS[k];
	const out: Record<string, unknown> = { ...stripLegacyExtras(raw), extras };
	if (gen1) {
		out.liveEnd = raw.liveEnd === true || LEGACY_LIVE_END_EXTRA_KEYS.some((k) => raw[k] === true);
	}
	return out;
}

/**
 * per-UP 覆盖(partial)的迁移。覆盖是稀疏的,拿不到全局值,只能就地判 —— 只对**第一代**
 * (或 `force`)做下播开关的推断:
 * - 三者有一个显式 true → `liveEnd: true`(不管全局怎样,这位 UP 以前一定收得到东西)
 * - 三者都显式 false → `liveEnd: false`(以前什么都收不到,现在也是)
 * - 其余(有的关、有的没写)→ 不写 liveEnd,继承全局。全局迁完只会更宽,顶多多收一张卡
 *
 * 第二代只改名(`liveEndExtras` → `extras`),下播开关不碰。稀疏这一点也贯彻到附加项:
 * 只搬老数据里真写过的那几把,没写过的**不补默认** —— 补了就等于凭空长出一份覆盖。
 *
 * 单看一份 partial,只有 `{ liveEnd: false }` 分不出第一代与新形状;整条订阅能看 routing
 * 的形状,认出是第一代就传 `force` 让这份覆盖也按老规矩迁(见 {@link migrateLegacySubscription})。
 */
export function migrateLegacyFeatureFlagsPartial(raw: unknown, force = false): unknown {
	if (!isPlainObject(raw)) return raw;
	const gen1 = hasLegacyTopLevelExtras(raw);
	if (!force && !gen1 && !("liveEndExtras" in raw)) return raw;
	const already = isPlainObject(raw.extras) ? raw.extras : {};
	const stripped = stripLegacyExtras(raw);
	const extras = { ...already, ...pickLegacyExtras(raw) };
	// 第二代只改名:`liveEnd` 已经是新语义,原样留着。
	if (!gen1 && !force) return { ...stripped, extras };
	const trio = [raw.liveEnd, ...LEGACY_LIVE_END_EXTRA_KEYS.map((k) => raw[k])];
	const { liveEnd: _l, ...rest } = stripped;
	const out: Record<string, unknown> = { ...rest, extras };
	if (trio.includes(true)) out.liveEnd = true;
	else if (trio.every((v) => v === false)) out.liveEnd = false;
	return out;
}

// ── 第一代 routing ──────────────────────────────────────────────────────────────

/**
 * 第一代 routing 的形状:词云 / 总结曾各是一把特性键、各有一份目标列表。迁成
 * 「下播目标 = 下播 ∪ 词云 ∪ 总结」(保序:先下播、再词云、再总结;去重交给活 schema 上 routing 的
 * transform),老键不留。新形状(没这两把键)原样过。
 */
const LEGACY_ROUTING_KEYS = ["wordcloud", "liveSummary"] as const;

function isLegacyRouting(raw: unknown): raw is Record<string, unknown> {
	return typeof raw === "object" && raw !== null && LEGACY_ROUTING_KEYS.some((k) => k in raw);
}

export function migrateLegacyRouting(raw: unknown): unknown {
	if (!isLegacyRouting(raw)) return raw;
	const { wordcloud, liveSummary, ...rest } = raw;
	const lists = [rest.liveEnd, wordcloud, liveSummary].filter(Array.isArray);
	return { ...rest, liveEnd: lists.flat() };
}

// ── 整条老订阅 ──────────────────────────────────────────────────────────────────

/** @全体 那两把附加项当年住在订阅上,按 scope 存 —— `atAll.<scope>` / `atAllDefaults.<scope>`。 */
const LEGACY_AT_ALL_SCOPES = [
	["dynamic", "atAllDynamic"],
	["live", "atAllLive"],
] as const satisfies ReadonlyArray<readonly [string, ZeroExtraKey]>;

/**
 * 整条老订阅的迁移,两件事:
 *
 * 1. **第一代的 features 覆盖**。routing 自己认得出新老(见 {@link migrateLegacyRouting});
 *    `overrides.features` 单看分不出 —— `{ liveEnd: false }` 在第一代与新形状里长得一样,
 *    含义却不同:第一代只关了下播卡(词云 / 总结照收),新的是整个下播都关。所以 routing
 *    是第一代就把这份覆盖也按老规矩迁(`force`),别让那位 UP 的词云 / 总结跟着没了。
 *
 * 2. **@全体 并进附加项**(ADR-0016 决策 2)。`atAll.<scope>` 是 per-目标 三态表,1:1 搬到
 *    `extras.atAll<Scope>`;`atAllDefaults.<scope>` 是 per-UP 的值,搬进 per-UP 覆盖层。
 *    ⚠️ `atAllDefaults` 是必填带默认的,**老数据里人人都有** —— 等于出厂默认就不写,
 *    否则每条订阅都会凭空长出一份无意义的 per-UP 覆盖。
 *
 * 新形状(没有 `atAll` / `atAllDefaults`)这两件事都不做。
 */
export function migrateLegacySubscription(raw: unknown): unknown {
	if (!isPlainObject(raw)) return raw;
	const sub = raw;
	const legacyRouting = isLegacyRouting(sub.routing);
	const atAll = isPlainObject(sub.atAll) ? sub.atAll : undefined;
	const atAllDefaults = isPlainObject(sub.atAllDefaults) ? sub.atAllDefaults : undefined;
	if (!legacyRouting && !atAll && !atAllDefaults) return raw;

	const overrides = isPlainObject(sub.overrides) ? sub.overrides : undefined;
	// features 覆盖先就地归一(第一代要 force,第二代只改名),@全体 的默认值再往上加 ——
	// 否则后跑的那一步(`overrides.features` 自己的迁移)会拿老形状重算一遍 `extras`,把刚写进去的 @全体 抹掉。
	let features =
		overrides?.features === undefined
			? undefined
			: migrateLegacyFeatureFlagsPartial(overrides.features, legacyRouting);

	const perUpDefaults: Record<string, unknown> = {};
	for (const [scope, key] of LEGACY_AT_ALL_SCOPES) {
		const value = atAllDefaults?.[scope];
		if (typeof value !== "boolean" || value === ZERO_EXTRA_DEFAULTS[key]) continue;
		perUpDefaults[key] = value;
	}
	if (Object.keys(perUpDefaults).length > 0) {
		const base = isPlainObject(features) ? features : {};
		const baseExtras = isPlainObject(base.extras) ? base.extras : {};
		features = { ...base, extras: { ...baseExtras, ...perUpDefaults } };
	}

	const { atAll: _a, atAllDefaults: _d, ...rest } = sub;
	const out: Record<string, unknown> = { ...rest };
	if (features !== undefined) out.overrides = { ...(overrides ?? {}), features };

	if (atAll) {
		const extras = isPlainObject(sub.extras) ? { ...sub.extras } : {};
		for (const [scope, key] of LEGACY_AT_ALL_SCOPES) {
			if (scope in atAll) extras[key] = atAll[scope];
		}
		out.extras = extras;
	}
	return out;
}
