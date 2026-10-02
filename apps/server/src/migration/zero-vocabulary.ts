/**
 * 0.x 最新版(0.12)的词表 —— 冻住,不随 internal 改名。
 *
 * 迁移器的 0.x 那一遍(`features.ts` / `templates.ts` / `history.ts`)认的是 0.12 当年的特性键、附加项键、默认文案、
 * 推送种类。它们从前直接取 internal 的活词表(`EXTRA_KEYS` / `PUSH_EXTRAS` / `makeDefaultGlobalConfig()` /
 * `PushKind`),活词表一改名,0.x 这一步就会悄悄吐出 1.0 的键。所以收成迁移模块自己的一份:每个值都以 tag `v0.12.0`
 * 的 `packages/internal/src/constants.ts` 与 `schema/history.ts` 为准核过,今天的活词表与它字节一致(改名之前)。
 *
 * ⚠️ 这张表是 0.x 的历史事实,不要因为 1.0 改了名就跟着改。1.0 改名那一步另写(把 0.x 的形状再迁成 1.0 的形状),
 * 不在这里。键序也是产出的一部分:`ZERO_EXTRA_KEYS` 的顺序决定迁出来的 `extras` 里键的先后,改了顺序就改了落盘的字节。
 */

/** 0.x 的附加项键,按 0.12 `EXTRA_KEYS` 的顺序。 */
export const ZERO_EXTRA_KEYS = ["atAllDynamic", "atAllLive", "wordcloud", "liveSummary"] as const;

export type ZeroExtraKey = (typeof ZERO_EXTRA_KEYS)[number];

/** 0.x 附加项的出厂开关(0.12 `PUSH_EXTRAS[k].default`)。迁移只读这一格,别的格(主特性 / 标签 / 能力)用不着。 */
export const ZERO_EXTRA_DEFAULTS: Readonly<Record<ZeroExtraKey, boolean>> = {
	atAllDynamic: false,
	atAllLive: true,
	wordcloud: true,
	liveSummary: true,
};

/**
 * 0.x 最新一版的默认文案(0.12 `DEFAULT_TEMPLATES`)里**迁移会写回去**的那几条:旧默认对得上就改写成它们
 * (见 `templates.ts`)。别的文案迁移不读,不收进来。上舰那三档只留各自的模板字符串。
 */
export const ZERO_DEFAULT_TEMPLATES = {
	liveStart: "{name} 开播啦，当前粉丝数：{follower}",
	liveOngoing: "{name} 正在直播，已播 {time}，累计观看：{watched}",
	liveEnd: "{name} 下播啦，本次直播了 {time}，粉丝变化 {follower_change}",
	dynamic: "{name}发布了一条动态",
	dynamicVideo: "{name}发布了新视频",
	guardBuy: {
		captain: "{uname} 成为了 {mname} 的舰长！",
		commander: "{uname} 成为了 {mname} 的提督！",
		governor: "{uname} 成为了 {mname} 的总督！",
	},
} as const;

/** 0.x 的推送种类(0.12 `PushKind`):开播与周期「正在直播」共用一把特性键,历史上却是两种推送,所以多一个 `live-ongoing`。 */
export type ZeroPushKind =
	| "dynamic"
	| "live"
	| "live-ongoing"
	| "live-end"
	| "guard"
	| "sc"
	| "special-danmaku"
	| "special-enter";
