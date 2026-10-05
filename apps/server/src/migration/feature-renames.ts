/**
 * 0.x 最新形状 → 1.0 的改名(⑬c):特性键、附加项键、文案键、版式键、订阅顶层的逐目标表(⑬d 起文案键里
 * `liveOngoing` → `liveStreaming` 也在这里;㉑a 起内容过滤的六个键也在这里)。**不是改名的搬家**(㉓d:两个直播阈值 `minScPrice` /
 * `minGuardLevel`、上舰文案 `templates.guardBuy`)在 `membership-moves.ts`,接在这一步之后;它们不在下面的改名表里,
 * 表的类型是「0.x 的键去掉搬走的」,所以 0.x 的每个键仍然必须有去向 —— 改名或搬家,漏了编译不过。
 *
 * 0.x 那一遍(`features.ts` / `templates.ts` …)吐出来的是 0.x 最新的形状,这一步在它之后串着跑,把名字换成 1.0 的:
 *
 * | 0.x | 1.0 |
 * | --- | --- |
 * | 特性键 `dynamic` / `live` / `liveGuardBuy` | `post` / `liveStart` / `membership` |
 * | 附加项键 `atAllDynamic` / `atAllLive` | `atAllPost` / `atAllLiveStart` |
 * | 文案 `templates.dynamic` / `dynamicVideo` / `liveOngoing`(账本 `templateDefaultsSeen` 的同名三个键) | `post` / `postVideo` / `liveStreaming` |
 * | 版式 `messageLayout.dynamic`(`live` 那组管开播、正在直播、下播三种消息,不改名) | `messageLayout.post` |
 * | 订阅顶层的逐目标表 `extras` | `extraTargets` |
 * | 内容过滤 `filters`(全局 `defaults.filters` 与订阅 `overrides.filters`):`blockForward` / `blockArticle` / `blockDraw` / `blockAv` | `blockReposts` / `blockArticles` / `blockImages` / `blockVideos` |
 * | 内容过滤的白名单 `whitelistKeywords` / `whitelistRegex` | `allowKeywords` / `allowRegex` |
 *
 * 值原样搬、键序不变;认不得的形状原样放过(由配置仓开机时报出来);已经是新键的数据再跑一遍不变,新老键并存时以新键为准、
 * 老键丢掉。**不碰**的同名不同义:`app.logLevels` 的 `dynamic` / `live`(日志模块名,3a)、`cardStyleByKind` 的卡种键(㉔)、
 * `ai.search.engines` 与 AI 场景、历史行的推送种类(⑱)。直播拆键里不是改名的那部分(新特性 `liveStreaming`、`pushTime` /
 * `restartPush` 拆成间隔与补报、`routing.liveStreaming` 拷贝、逐订阅按合并值算开关)在 `live-split.ts`,接在这一步的产出之后。
 *
 * 两个入口,挂法照订阅这一族已有的「0.x 最新 → 1.0」先例(`subscriptions.ts` 的 `toIdentityRow` / `toTaggedFile`):
 * - 设置:{@link renameGlobalSettingsKeys},在 `migrateGlobals` 之后(`settings.ts` 的 `migrateSettingsFiles`);
 * - 订阅一行:{@link renameSubscriptionKeys},在 0.x 的行级迁移之后、换成带 `identity` 的行之前
 *   (`subscriptions.ts` 的 `migrateSubscriptionFiles`)。
 *
 * 同一条订阅里 `routing.<主特性>` 与 `extraTargets.<附加项>` 在同一次调用里一起改完:活 schema 要求附加项目标 ⊆ 主特性
 * 目标,只改一边的话配置仓开机就拒收整个订阅文件。
 */

import type {
	ContentFilters,
	ExtraKey,
	FeatureKey,
	MessageLayout,
	TemplateBundle,
} from "@bilibili-notify/internal";
import { isPlainObject } from "./files.js";
import type {
	ZeroExtraKey,
	ZeroFeatureKey,
	ZeroFilterKey,
	ZeroMessageLayoutKey,
	ZeroMovedFilterKey,
	ZeroMovedTemplateKey,
	ZeroTemplateKey,
} from "./zero-vocabulary.js";

// ── 改名对照表 ──────────────────────────────────────────────────────────────────
//
// 五张表都写成 `satisfies Record<0.x 的键类型, 1.0 的键类型>`:0.x 的哪个键漏了去向、或去向不是 1.0 的活键,
// 编译不过。没改名的键也写出来(恒等),这样「漏了」和「没改」分得开。参照 `zero-generation.ts` 的
// `ZERO_GENERATION_MOVES` 与 internal `constants.ts` 的 `SUBSCRIPTION_EVENT_FEATURES`。
// 过滤键与文案键两张表的键类型是「0.x 的键去掉搬家的」(`Exclude<…, ZeroMoved…>`):搬走的键去向在 `membership-moves.ts`,
// 不是 1.0 `ContentFilters` / `TemplateBundle` 里的键,硬塞进表里只能靠类型断言糊过去 —— 这里不糊。

/** 特性键:全局 `defaults.features`、订阅的 `routing` 与 `overrides.features` 共用。 */
const FEATURE_KEY_RENAMES = {
	dynamic: "post",
	live: "liveStart",
	liveEnd: "liveEnd",
	liveGuardBuy: "membership",
	superchat: "superchat",
	specialDanmaku: "specialDanmaku",
	specialUserEnter: "specialUserEnter",
} as const satisfies Record<ZeroFeatureKey, FeatureKey>;

/** 附加项键:`features.extras` 与订阅顶层的逐目标表共用。 */
const EXTRA_KEY_RENAMES = {
	atAllDynamic: "atAllPost",
	atAllLive: "atAllLiveStart",
	wordcloud: "wordcloud",
	liveSummary: "liveSummary",
} as const satisfies Record<ZeroExtraKey, ExtraKey>;

/** 文案键:`templates`(全局与逐订阅覆盖)与 `templateDefaultsSeen` 账本点路径的第一段共用。 */
const TEMPLATE_KEY_RENAMES = {
	liveStart: "liveStart",
	liveOngoing: "liveStreaming",
	liveEnd: "liveEnd",
	liveSummary: "liveSummary",
	dynamic: "post",
	dynamicVideo: "postVideo",
	wordcloudStopWords: "wordcloudStopWords",
	specialDanmaku: "specialDanmaku",
	specialUserEnter: "specialUserEnter",
} as const satisfies Record<Exclude<ZeroTemplateKey, ZeroMovedTemplateKey>, keyof TemplateBundle>;

/** 版式的两组(`version` 不在表里,原样过):作品改名,直播不改。 */
const MESSAGE_LAYOUT_KEY_RENAMES = {
	dynamic: "post",
	live: "live",
} as const satisfies Record<ZeroMessageLayoutKey, Exclude<keyof MessageLayout, "version">>;

/**
 * 内容过滤键:`defaults.filters` 与订阅的 `overrides.filters` 共用。四个类型开关改叫复数名词,白名单改叫 `allow*`;
 * `blockKeywords` / `blockRegex` 原样。两个直播阈值搬出了 `filters`(㉓d),不在这张表里,这一步原样带过、由
 * `membership-moves.ts` 接着搬。
 */
const FILTER_KEY_RENAMES = {
	blockForward: "blockReposts",
	blockArticle: "blockArticles",
	blockDraw: "blockImages",
	blockAv: "blockVideos",
	blockKeywords: "blockKeywords",
	blockRegex: "blockRegex",
	whitelistKeywords: "allowKeywords",
	whitelistRegex: "allowRegex",
} as const satisfies Record<Exclude<ZeroFilterKey, ZeroMovedFilterKey>, keyof ContentFilters>;

/** 订阅顶层的逐目标表。 */
const SUBSCRIPTION_KEY_RENAMES = { extras: "extraTargets" } as const;

// ── 换键的零件 ──────────────────────────────────────────────────────────────────

type KeyRename = (key: string) => string;
type ValueRewrite = (value: unknown) => unknown;

/** 一张对照表 → 换键函数:表里有的换,没有的原样(`Object.hasOwn`:`constructor` 这类键别从原型上取到东西)。 */
function byTable(table: Readonly<Record<string, string>>): KeyRename {
	return (key) => (Object.hasOwn(table, key) ? (table[key] as string) : key);
}

/**
 * 换一张对象的键,键序不变。`values` 按**换名之前**的键给要往里走一层的值(没给的原样)。新键已经在对象里时以它为准:
 * 老键那一项丢掉。不是普通对象的原样回(同一个值)。
 */
function renameKeys(
	value: unknown,
	rename: KeyRename,
	values: Readonly<Record<string, ValueRewrite>> = {},
): unknown {
	if (!isPlainObject(value)) return value;
	const entries: Array<[string, unknown]> = [];
	for (const [key, inner] of Object.entries(value)) {
		const next = rename(key);
		if (next !== key && Object.hasOwn(value, next)) continue;
		entries.push([next, Object.hasOwn(values, key) ? (values[key] as ValueRewrite)(inner) : inner]);
	}
	// `Object.fromEntries` 走的是 CreateDataProperty:JSON 里一个叫 `__proto__` 的键也只是个普通键。
	return Object.fromEntries(entries);
}

const renameFeatureMap: ValueRewrite = (value) => renameKeys(value, byTable(FEATURE_KEY_RENAMES));

const renameExtraMap: ValueRewrite = (value) => renameKeys(value, byTable(EXTRA_KEY_RENAMES));

/** 全局 `defaults.features` 与逐订阅 `overrides.features`:特性键 + 里面 `extras` 的附加项键(**那个 `extras` 不改名**)。 */
const renameFeatureFlags: ValueRewrite = (value) =>
	renameKeys(value, byTable(FEATURE_KEY_RENAMES), { extras: renameExtraMap });

/** 全局 `defaults.filters` 与逐订阅 `overrides.filters`:稀疏的覆盖只换写过的键,没写的不会长出来。 */
const renameFilters: ValueRewrite = (value) => renameKeys(value, byTable(FILTER_KEY_RENAMES));

const renameTemplates: ValueRewrite = (value) => renameKeys(value, byTable(TEMPLATE_KEY_RENAMES));

const renameMessageLayout: ValueRewrite = (value) =>
	renameKeys(value, byTable(MESSAGE_LAYOUT_KEY_RENAMES));

/** 账本的键是点路径(`guardBuy.captain.template`):换第一段,后面的原样;值是指纹,原样。 */
const renameTemplateLedger: ValueRewrite = (value) =>
	renameKeys(value, (key) => {
		const [head = "", ...rest] = key.split(".");
		return [byTable(TEMPLATE_KEY_RENAMES)(head), ...rest].join(".");
	});

// ── 入口 ────────────────────────────────────────────────────────────────────────

/**
 * 整份全局设置(0.x 最新形状,`state/globals.json` → `settings/core.json`)的 raw → raw:`defaults` 里的特性开关、
 * 内容过滤、文案、版式与账本换成 1.0 的键。认不得的形状原样放过。
 */
export function renameGlobalSettingsKeys(raw: unknown): unknown {
	return renameKeys(raw, (key) => key, {
		defaults: (defaults) =>
			renameKeys(defaults, (key) => key, {
				features: renameFeatureFlags,
				filters: renameFilters,
				templates: renameTemplates,
				messageLayout: renameMessageLayout,
				templateDefaultsSeen: renameTemplateLedger,
			}),
	});
}

/**
 * 一条订阅(0.x 最新形状,B 站或拓展)的 raw → raw:`routing`、顶层的逐目标表 `extras` → `extraTargets`(含里面的附加项键)、
 * 与 `overrides` 里的 `features` / `filters` / `templates` / `messageLayout` 一次改完。认不得的形状原样放过。
 */
export function renameSubscriptionKeys(row: unknown): unknown {
	return renameKeys(row, byTable(SUBSCRIPTION_KEY_RENAMES), {
		routing: renameFeatureMap,
		extras: renameExtraMap,
		extraTargets: renameExtraMap,
		overrides: (overrides) =>
			renameKeys(overrides, (key) => key, {
				features: renameFeatureFlags,
				filters: renameFilters,
				templates: renameTemplates,
				messageLayout: renameMessageLayout,
			}),
	});
}
