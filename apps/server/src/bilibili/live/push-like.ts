/**
 * Platform-neutral push surface used by live-engine.
 *
 * live-engine intentionally does NOT depend on `@bilibili-notify/push`; the host
 * (standalone runtime) provides a `PushLike` instance whose methods cover only
 * what this engine needs.
 *
 * The accompanying `SubItemView` and feature key types mirror the platform-neutral
 * subset of `@bilibili-notify/push`'s `SubItem` shape consumed by listener /
 * collector / template helpers.
 */

import type { CommentaryCallOverride } from "@bilibili-notify/ai";
import type { CardSkinChoice } from "@bilibili-notify/image";
import type {
	ExtraKey,
	MembershipTemplateBundle,
	MessageKindLayout,
	PushMessageRole,
} from "@bilibili-notify/internal";

/**
 * Push category enum — numeric values are the historical bilibili-notify push-type codes.
 * 只在进程内流转(推送层的翻译表按它分流、日志里打出来),**不落盘、不过 wire**:历史行与订阅、
 * 设置存的都是特性键,所以加一档、删一档都不用迁移。
 *
 * 它说的是「这是哪一种推送」:定特性键、定许不许 @全体。下播的附加项(词云、AI 总结)不是单独的
 * 一种推送,是下播那次推送里的锚点({@link LivePushAnchor}),按附加项的键认 —— 原先的 5 / 10 两档
 * 随之删掉,编号空着不复用。
 */
export enum LivePushType {
	/** 周期「正在直播」(`liveStreaming`)。 */
	Live = 0,
	StartBroadcasting = 3,
	LiveGuardBuy = 4,
	Superchat = 6,
	UserDanmakuMsg = 7,
	UserActions = 8,
	LiveEnd = 9,
	/**
	 * 重启补报(`liveStart.catchUpOnBoot`):启动时发现正在播,补一张开播。卡与文字是「正在直播」那一套,
	 * 但走开播(`liveStart`)的目标、历史记成开播、**不 @全体**。与周期那一档({@link Live})分成两档,
	 * 宿主的翻译表才分得出一个归 `liveStart`、一个归 `liveStreaming`。
	 */
	CatchUp = 11,
}

/**
 * Channel-level feature keys (mirror `@bilibili-notify/push`'s `PushFeature`).
 * Each entry on `SubItemView.target` maps to a list of resolved channel
 * identifiers; an empty / missing list means "not subscribed for this feature".
 */
export type LivePushFeature =
	| "post"
	| "liveStart"
	| "liveStreaming"
	| "liveEnd"
	| "membership"
	| "superchat"
	| "specialDanmaku"
	| "specialUserEnter";

/**
 * Master-level feature keys — the boolean toggles set per-UP. Subset of
 * `LivePushFeature` which omits `specialDanmaku` / `specialUserEnter`
 * (those are gated by `customSpecial*.enable` instead).
 */
export type LiveCreatorFeature = Exclude<LivePushFeature, "specialDanmaku" | "specialUserEnter">;

/**
 * Subset of `LiveCreatorFeature` whose subscription requires an active live-room
 * WebSocket connection. Mirrors `@bilibili-notify/push`'s `LIVE_ROOM_MASTERS`.
 */
export const LIVE_ROOM_CREATOR_KEYS: readonly LiveCreatorFeature[] = [
	"liveStart",
	"liveStreaming",
	"liveEnd",
	"membership",
	"superchat",
];

/** {@link needsLiveMonitor} 要看的那几格:有效的直播类开关,加上那两个特殊用户条件。 */
export type LiveMonitorInput = Pick<
	SubItemView,
	| "liveStart"
	| "liveStreaming"
	| "liveEnd"
	| "membership"
	| "superchat"
	| "customSpecialDanmakuUsers"
	| "customSpecialUsersEnterTheRoom"
>;

/**
 * 这位订阅要不要监听直播间:直播类主开关(`LIVE_ROOM_CREATOR_KEYS`)任一开着,或配了特别弹幕 / 特别关注进场。
 * 只看折好的生效值,不依赖房间上下文 —— 引擎判断开不开监听与统计判断「直播在不在记」都问它(只此一份)。
 * 没有特殊用户的订阅(拓展订阅)把那两格的 `enable` 传 `false`。
 */
export function needsLiveMonitor(sub: LiveMonitorInput): boolean {
	return (
		(LIVE_ROOM_CREATOR_KEYS as readonly (keyof LiveMonitorInput)[]).some((k) => sub[k] === true) ||
		sub.customSpecialDanmakuUsers.enable ||
		sub.customSpecialUsersEnterTheRoom.enable
	);
}

/**
 * 附加项的开关(ADR-0016):挂在某把主特性下面、与本体分开发的一条消息。引擎只关心下播
 * 那两把(词云 / AI 总结)—— 它们是下播那次推送里排在卡片后面的锚点;@全体
 * 那两把归推送层。发不发给谁也归推送层,引擎照渲照算。
 */
export type PushExtrasLike = Record<ExtraKey, boolean>;

/** 这位 UP 要不要采集弹幕:下播开着,且下播那两个附加项至少一个开着。 */
export function wantsLiveEndExtras(sub: SubItemView): boolean {
	return sub.liveEnd && (sub.extras.wordcloud || sub.extras.liveSummary);
}

/** Sub-level customisation blocks copied from `@bilibili-notify/push`. */
export interface CustomCardStyleLike {
	enable: boolean;
	// 🪦 `backgroundImage` / `backgroundImages` 2026-09-20 随整条链删掉 —— 背景图归皮肤
	// 自己的 `image` 旋钮(`--bn-knob-wallpaper`),不再从样式覆盖里透传。
	/** 直播卡自定义封面资产 id(独立端专属);透传给 generateLiveCard 的 colorOptions。 */
	liveCoverImage?: string;
	/**
	 * 直播卡自定义封面的**完整**列表(>1 张时「每次推送轮换」,与背景图同一 rotator、
	 * key 维度独立)。adapter 填入;推送点选下一张覆盖 `liveCoverImage`。
	 */
	liveCoverImages?: string[];
	/**
	 * 字体家族名;透传给 generate* 的 colorOptions(缺省回退渲染器全局 config)。
	 *
	 * 这一项此前整条链都漏着:schema 存得下、resolve 算得出,但 adapter 没往这里填、
	 * 类型里也没有 —— 于是「给这位 UP 单独换个字体」选了等于没选。
	 */
	font?: string;
	/** 主人自带字体的资产 id(独立端专属);设了优先于 `font`,缺省回退全局。 */
	fontAsset?: string;
}

/**
 * 直播封面轮换选择器:给定 scopeKey(`uid:live-cover`)与完整图列表,返回本次该用的那张
 * (并在实现内推进游标)。宿主注入(独立端有 fs 持久化游标);返回 undefined = 不轮换。
 *
 * 名字里的 "Background" 是历史:它从前也管卡片背景图轮换,那条链 2026-09-20 删掉了
 * (背景图归皮肤的 `image` 旋钮),今天只剩直播封面在用。
 */
export type PickLiveCover = (scopeKey: string, images: string[]) => string | undefined;

export interface CustomLiveMsgLike {
	enable: boolean;
	customLiveStart?: string;
	customLiveStreaming?: string;
	customLiveEnd?: string;
}

export interface CustomLiveSummaryLike {
	enable: boolean;
	liveSummary?: string;
}

export interface CustomSpecialDanmakuUsersLike {
	enable: boolean;
	specialDanmakuUsers?: string[];
	msgTemplate: string;
}

export interface CustomSpecialUsersEnterTheRoomLike {
	enable: boolean;
	specialUsersEnterTheRoom?: string[];
	msgTemplate: string;
}

/** Per-feature target list (already resolved to channel identifiers). */
export type SubItemTargetLike = Partial<Record<LivePushFeature, unknown[]>>;

/**
 * Platform-neutral view of a single subscription, structurally compatible with
 * `@bilibili-notify/push`'s `SubItem`. The live engine only reads this shape; the
 * host builds the instances (folding per-UP overrides onto the globals).
 */
export interface SubItemView {
	/**
	 * 这条订阅在核心里的 id(`Subscription.id`),由宿主 `buildLiveSubViewSingle` 填。直播引擎认人靠 `uid`(B 站的 uid),
	 * 但中立事件(`MembershipEvent` / `SuperchatEvent`)的 `subscriptionId` 是核心的订阅 id —— 来源不知道,由宿主带进来。
	 */
	subscriptionId: string;
	uid: string;
	uname: string;
	roomId: string;
	post: boolean;
	liveStart: boolean;
	/** 周期「正在直播」的开关(`features.liveStreaming`)。关着就不计时、不出卡。 */
	liveStreaming: boolean;
	liveEnd: boolean;
	membership: boolean;
	superchat: boolean;
	/** 见 {@link PushExtrasLike}。宿主折叠 `eff.features.extras` 后整份填入。 */
	extras: PushExtrasLike;
	target: SubItemTargetLike;
	customCardStyle: CustomCardStyleLike;
	customLiveMsg: CustomLiveMsgLike;
	/**
	 * 这条订阅上 B 站的会员体系(`guard`)的文案(`overrides.templates.membership.guard`,没覆盖就是全局那份,㉓d)。
	 * `enabled` 为 true 才用它(取法见 `membershipTemplateOf`:按事件的档位 key 取那一档,没填的格用体系默认);为 false 时
	 * 回落 {@link ListenerManagerConfig.guardTemplate}(全局那份),全局也没开就走官方上舰图 / 上舰卡。
	 */
	guardTemplate: MembershipTemplateBundle;
	customLiveSummary: CustomLiveSummaryLike;
	customSpecialDanmakuUsers: CustomSpecialDanmakuUsersLike;
	customSpecialUsersEnterTheRoom: CustomSpecialUsersEnterTheRoomLike;
	/**
	 * Per-UP 阈值 / 调度。adapter build SubItemView 时已一次性折算好
	 * (`sub.overrides.X ?? 全局 config.X`),引擎 / 监听层直接消费,无二次回退。
	 * 随 LiveScopedChange 增量推送给 LiveEngine.applyOps;`liveStreaming` 开关或
	 * `streamingIntervalHours` 变更时 engine 额外 rearm 定时器(setInterval 句柄 ms 不可变)。
	 */
	/** 醒目留言门槛(㉓d,原先是 `minScPrice`):金额低于它不推,按人民币元算;没配 = 不设门槛。 */
	minSuperchatAmount?: number;
	/** 上舰门槛(㉓d,原先是 `minGuardLevel`):档位 rank 低于它不推(1 = 舰长最低、3 = 总督);没配 = 全推。 */
	minGuardRank?: number;
	/** 周期「正在直播」的间隔,小时(1–24)。只在 {@link liveStreaming} 开着时有意义。 */
	streamingIntervalHours: number;
	/** 启动时发现正在播,补报一次开播(`liveStart.catchUpOnBoot`);只在 `liveStart` 开着时补。 */
	catchUpOnBoot: boolean;
	/**
	 * 断流接续:true 时该 UP 下播先挂起 `liveEndGraceMinutes` 分钟,等待窗口内重新开播
	 * 即判定网络抖动 / 超管掐流并接续为同一场(不发下播、不重发开播);超时未重开才真下播。
	 * adapter 已折算好(per-UP ?? 全局);缺省 false。
	 */
	liveEndGrace?: boolean;
	/** 断流接续等待时长(分钟,1–10);仅 `liveEndGrace=true` 生效,缺省 2。 */
	liveEndGraceMinutes?: number;
	/** undefined = 该 UP 无 per-UP AI 覆盖,直播总结走 AI 引擎自身配置。 */
	aiOverride?: CommentaryCallOverride;
	/**
	 * 该 UP 解析后的弹幕词云额外停用词(英文逗号分隔)。引擎记词时已按 bundled + 全局
	 * 过滤;此值在下播 dispatch 时对 sortedWords 再过滤一遍,使 per-UP 覆盖在该 UP 的
	 * 词云 / 总结热词上额外生效。undefined / 空 = 不额外过滤。
	 */
	wordcloudStopWords?: string;
	/**
	 * 该 UP 生效的**卡片皮肤 id**(ADR-0014)。宿主折叠 `eff.cardSkin`(per-UP 指了就是它,
	 * 否则全局)后填入;undefined = 内置默认皮肤。各 generate* 原样透传 —— 版式住皮肤包里,
	 * 不再逐块下发。
	 */
	cardSkin?: string;
	/**
	 * 该 UP 自己那层**皮肤旋钮覆盖**,按皮肤 id 分(`overrides.cardSkinKnobs` 原样,ADR-0014
	 * 决策 17 的 🔗)。undefined = 一枚都没单独拧。与 `cardSkin` 一起递给每一种卡的 generate*
	 * (开播 / 直播中 / 下播 / SC / 上舰 / 词云),渲染器在出图时与全局那份逐枚合并。
	 */
	cardSkinKnobs?: CardSkinChoice["cardSkinKnobs"];
	/**
	 * 该 UP 解析后的**消息版式**直播切片(块顺序 / 显隐 / 分条符 + 分隔符)。宿主折叠
	 * `eff.messageLayout.live` 后填入。覆盖开播 / 直播中 / 下播三类推送;SC / 上舰不受影响
	 * (走各自独立渲染,不经 sendLiveNotifyCard)。
	 */
	messageLayout: MessageKindLayout;
}

export type SubscriptionsView = Record<string, SubItemView>;

/**
 * Scoped change object — the host forwards incremental subscription updates as these.
 */
export type LiveScopedChange = { scope: "live" } & Partial<
	Pick<
		SubItemView,
		| "liveStart"
		| "liveStreaming"
		| "liveEnd"
		| "membership"
		| "superchat"
		| "extras"
		| "uname"
		| "roomId"
		| "customCardStyle"
		| "customLiveMsg"
		| "guardTemplate"
		| "customLiveSummary"
		| "customSpecialDanmakuUsers"
		| "customSpecialUsersEnterTheRoom"
		| "minSuperchatAmount"
		| "minGuardRank"
		| "streamingIntervalHours"
		| "catchUpOnBoot"
		| "liveEndGrace"
		| "liveEndGraceMinutes"
		| "aiOverride"
		| "wordcloudStopWords"
		| "cardSkin"
		| "cardSkinKnobs"
		| "messageLayout"
	>
>;

export type DynamicScopedChange = { scope: "dynamic" } & Partial<Pick<SubItemView, "post">>;

export type TargetScopedChange = { scope: "target" } & Pick<SubItemView, "target">;

export type LiveSubChange = LiveScopedChange | DynamicScopedChange | TargetScopedChange;

export type LiveSubscriptionOp =
	| { kind: "add"; sub: SubItemView }
	| { kind: "delete"; uid: string }
	| { kind: "update"; uid: string; changes: LiveSubChange[] };

/**
 * 一次直播推送里的一个锚点 —— 推送层 `PushAnchor` 在引擎这一侧的样子:本体(开播 / 下播卡、
 * 上舰、醒目留言……),或一个附加项(下播的词云、AI 总结)。锚点按先后发。
 *
 * 内容的类型有意是 `unknown`:它是宿主 `contentBuilder` 造出来的东西,引擎只原样递回去。
 */
export interface LivePushAnchor {
	/** 本体(`main`)还是附加项(`extra`)。 */
	role: PushMessageRole;
	/** 附加项的键:给了按那张三态表筛目标(词云、总结各一把)。只对 `extra` 有意义。 */
	extra?: ExtraKey;
	/**
	 * 这个锚点的消息,只收一串:一条消息就是单元素,几条是分条序列(同一目标顺序发、一条失败
	 * 中止该目标这个锚点里的后续条)。也可以是一个「等会儿给」的约定(词云、总结还在做);
	 * 最后为空就跳过,做的时候出错由推送层记一条警告并跳过。
	 */
	messages: unknown[] | Promise<unknown[] | undefined>;
}

/**
 * 一次直播推送,整个交给宿主:本体加它的附加项是同一次(历史落同一行)。`type` 定特性键、
 * 定许不许 @全体(只有开播许);`uid` 由宿主换成订阅 id。
 */
export interface LivePush {
	uid: string;
	type: LivePushType;
	/** 按顺序排好的锚点。本体至多一个,有的话排第一个。 */
	anchors: LivePushAnchor[];
}

/** Push-out interface required by live-engine. */
export interface PushLike {
	/**
	 * 把一次直播推送交给推送层。开关、静音与免扰在交出去那一刻判一次;本体发完时返回,
	 * 附加项在后台按锚点先后接着发。
	 */
	push(push: LivePush): Promise<void>;
	sendPrivateMsg(content: string): Promise<void>;
}
