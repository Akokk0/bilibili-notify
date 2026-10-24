/**
 * 0.x 最新版(0.12)的词表 —— 冻住,不随 internal 改名。
 *
 * 迁移器的 0.x 那一遍(`features.ts` / `templates.ts` / `history.ts`)认的是 0.12 当年的特性键、附加项键、默认文案、
 * 推送种类。它们从前直接取 internal 的活词表(`EXTRA_KEYS` / `PUSH_EXTRAS` / `makeDefaultGlobalConfig()` /
 * `PushKind`),活词表一改名,0.x 这一步就会悄悄吐出 1.0 的键。所以收成迁移模块自己的一份:每个值都以 tag `v0.12.0`
 * 的 `packages/internal/src/constants.ts`、`schema/common.ts`、`schema/message-layout.ts` 与 `schema/history.ts` 为准核过,
 * 今天的活词表与它字节一致(改名之前)。1.0 的改名一步(`feature-renames.ts`)拿这里的键类型当「改名之前」的一侧。
 *
 * ⚠️ 这张表是 0.x 的历史事实,不要因为 1.0 改了名就跟着改。1.0 改名那一步另写(把 0.x 的形状再迁成 1.0 的形状),
 * 不在这里。键序也是产出的一部分:`ZERO_EXTRA_KEYS` 的顺序决定迁出来的 `extras` 里键的先后,改了顺序就改了落盘的字节。
 */

/**
 * 0.x 的特性键(0.12 `FEATURE_KEYS`),按它的顺序 —— 全局 `defaults.features`、订阅的 `routing` 与 `overrides.features`
 * 用的都是这一份。1.0 的改名对照(`feature-renames.ts`)用 `satisfies Record<ZeroFeatureKey, …>` 钉着:0.x 多一个键、
 * 对照表没给去向,编译不过。
 */
export const ZERO_FEATURE_KEYS = [
	"dynamic",
	"live",
	"liveEnd",
	"liveGuardBuy",
	"superchat",
	"specialDanmaku",
	"specialUserEnter",
] as const;

export type ZeroFeatureKey = (typeof ZERO_FEATURE_KEYS)[number];

/**
 * 0.x 的内容过滤键(0.12 `ContentFiltersSchema`),按它的顺序:全局 `defaults.filters` 与订阅 `overrides.filters` 用的都是这一份。
 * 每个键在 1.0 有一个去向:改名({@link ZERO_FILTER_KEYS} 去掉 {@link ZERO_MOVED_FILTER_KEYS},`feature-renames.ts` 用
 * `satisfies Record<…, …>` 钉着:多一个键、对照表没给去向,编译不过)或搬家(两个直播阈值,`membership-moves.ts`)。
 * 改了名的是四个类型开关与两个白名单(`blockForward` / `blockArticle` / `blockDraw` / `blockAv`、`whitelistKeywords` /
 * `whitelistRegex`),`blockKeywords` / `blockRegex` 恒等;`minScPrice` / `minGuardLevel` 搬出了 `filters`(㉓d)。
 */
export const ZERO_FILTER_KEYS = [
	"blockForward",
	"blockArticle",
	"blockDraw",
	"blockAv",
	"blockKeywords",
	"blockRegex",
	"whitelistKeywords",
	"whitelistRegex",
	"minScPrice",
	"minGuardLevel",
] as const;

export type ZeroFilterKey = (typeof ZERO_FILTER_KEYS)[number];

/**
 * 0.x 过滤键里 1.0 **搬出** `filters` 的两个(㉓d):不是改名,去向是 `superchat.minAmount` 与 `membership.minRank.guard`,
 * 搬法在 `membership-moves.ts`。它们不在 `feature-renames.ts` 的改名表里 —— 表的类型是「0.x 的键去掉搬走的」。
 */
export const ZERO_MOVED_FILTER_KEYS = [
	"minScPrice",
	"minGuardLevel",
] as const satisfies readonly ZeroFilterKey[];

export type ZeroMovedFilterKey = (typeof ZERO_MOVED_FILTER_KEYS)[number];

/**
 * 0.x 的 `minGuardLevel`(B 站接口的 `guard_level`:1 = 总督、2 = 提督、3 = 舰长,数字越小档越高)→ 1.0 的 rank
 * (从 1 起、1 最低:舰长 1、提督 2、总督 3)。这是迁移自己冻住的一份换算,**不取运行时的档位表**(`bilibili-guard.ts`):
 * 迁移不依赖会变的运行时表。认不出的等级(不是 1 / 2 / 3)不在表里。
 */
export const ZERO_GUARD_LEVEL_RANKS: ReadonlyMap<number, number> = new Map([
	[1, 3],
	[2, 2],
	[3, 1],
]);

/**
 * 0.x 特别关注名单条目 `kinds` 的取值(0.12 `SpecialUserSchema`:`z.enum(["enter", "danmaku"])`),按它的顺序。
 * 1.0 的名单条目装特性键(`features`),`special-viewers.ts` 用 `satisfies Record<ZeroSpecialUserKind, …>` 钉着去向。
 */
export const ZERO_SPECIAL_USER_KINDS = ["enter", "danmaku"] as const;

export type ZeroSpecialUserKind = (typeof ZERO_SPECIAL_USER_KINDS)[number];

/** 0.x 的文案键(0.12 `TemplateBundleSchema`),按它的顺序;`templateDefaultsSeen` 账本点路径的第一段也是它们。 */
export const ZERO_TEMPLATE_KEYS = [
	"liveStart",
	"liveOngoing",
	"liveEnd",
	"liveSummary",
	"dynamic",
	"dynamicVideo",
	"wordcloudStopWords",
	"specialDanmaku",
	"specialUserEnter",
	"guardBuy",
] as const;

export type ZeroTemplateKey = (typeof ZERO_TEMPLATE_KEYS)[number];

/** 0.x 文案键里 1.0 **搬出** `templates` 原位的一个(㉓d):`guardBuy` 成了 `membership.guard`,搬法在 `membership-moves.ts`。 */
export const ZERO_MOVED_TEMPLATE_KEYS = ["guardBuy"] as const satisfies readonly ZeroTemplateKey[];

export type ZeroMovedTemplateKey = (typeof ZERO_MOVED_TEMPLATE_KEYS)[number];

/** 0.x 上舰三档的 role 键(0.12 `GuardBundleSchema`),按它的顺序;1.0 的档 key 与它们同名。 */
export const ZERO_GUARD_ROLES = ["captain", "commander", "governor"] as const;

export type ZeroGuardRole = (typeof ZERO_GUARD_ROLES)[number];

/** 0.x 消息版式里带版式的两组(0.12 `MessageLayoutSchema` 去掉 `version`):作品叫 `dynamic`,直播叫 `live`。 */
export const ZERO_MESSAGE_LAYOUT_KEYS = ["dynamic", "live"] as const;

export type ZeroMessageLayoutKey = (typeof ZERO_MESSAGE_LAYOUT_KEYS)[number];

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

/**
 * 0.x 从第一版起就有的四份内置人格 id,按 0.x 出厂清单的顺序。迁移只按 id 认、不比对内容,
 * 也不读 1.0 运行时的内置表:以后改文案或增删人格都不能反过来改变零代产出。
 */
export const ZERO_BUILTIN_PRESET_IDS = ["gentle-maid", "tsundere", "analyst", "genki"] as const;

/**
 * 0.x 的推送种类(0.12 `PushKind`),历史行的 `kind` 就是它:开播与周期「正在直播」共用一把特性键,历史上却是两种推送,
 * 所以多一个 `live-ongoing`。1.0 把历史行那一格改叫 `feature`、值换成特性键(`history.ts` 的对照表用 `satisfies
 * Record<ZeroPushKind, …>` 钉着:这里多一种、对照表没给去向,编译不过)。
 */
export const ZERO_PUSH_KINDS = [
	"dynamic",
	"live",
	"live-ongoing",
	"live-end",
	"guard",
	"sc",
	"special-danmaku",
	"special-enter",
] as const;

export type ZeroPushKind = (typeof ZERO_PUSH_KINDS)[number];

/**
 * 0.x 的推送载荷种类(0.12 `NotificationPayload` 的 `kind`),重推原件(`history/repush/<日>/<行 id>.json`)里每条消息的
 * 载荷就是其中一种。1.0 把图集那一种改叫 `image-group`(`history.ts` 的对照表用 `satisfies Record<ZeroPayloadKind, …>`
 * 钉着:这里多一种、对照表没给去向,编译不过);守卫 13 拿这张表给每一种各造一份旧原件、迁完用真的仓读回
 * (`__tests__/repush-snapshot-payloads.test.ts`)。
 */
export const ZERO_PAYLOAD_KINDS = [
	"text",
	"image",
	"composite",
	"forward-images",
	"miniapp-card",
] as const;

export type ZeroPayloadKind = (typeof ZERO_PAYLOAD_KINDS)[number];

/** 0.x 卡片设置里按卡种分开存的键(0.12 `CardStyleByKindSchema`):只有 `live` 下的直播封面有人读,别的卡种下的东西丢掉。 */
export const ZERO_CARD_KIND_KEYS = ["live", "dynamic", "sc", "guard"] as const;

/** 0.x 里唯一内置的卡片皮肤 id。0.x 的卡片皮肤整体不迁(老皮肤格式作废),所以指针只有指它的才留。 */
export const ZERO_BUILTIN_CARD_SKIN_ID = "default";
