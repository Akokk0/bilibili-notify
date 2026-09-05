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
import type { CardKind, CardLayout, MessageKindLayout } from "@bilibili-notify/internal";

/** Push category enum — numeric values are the historical bilibili-notify push-type codes. */
export enum LivePushType {
	Live = 0,
	StartBroadcasting = 3,
	LiveGuardBuy = 4,
	/** 历史上承载词云+总结合包推送;现在仅用于词云 —— 下播的附加项,宿主映射到下播那一类。 */
	WordCloudAndLiveSummary = 5,
	Superchat = 6,
	UserDanmakuMsg = 7,
	UserActions = 8,
	LiveEnd = 9,
	/** AI 总结 —— 下播的另一个附加项,宿主同样映射到下播那一类。 */
	LiveSummary = 10,
}

/**
 * Channel-level feature keys (mirror `@bilibili-notify/push`'s `PushFeature`).
 * Each entry on `SubItemView.target` maps to a list of resolved channel
 * identifiers; an empty / missing list means "not subscribed for this feature".
 */
export type LivePushFeature =
	| "dynamic"
	| "live"
	| "liveEnd"
	| "liveGuardBuy"
	| "superchat"
	| "specialDanmaku"
	| "specialUserEnter";

/**
 * Master-level feature keys — the boolean toggles set per-UP. Subset of
 * `LivePushFeature` which omits `specialDanmaku` / `specialUserEnter`
 * (those are gated by `customSpecial*.enable` instead).
 */
export type LiveMasterFeature = Exclude<LivePushFeature, "specialDanmaku" | "specialUserEnter">;

/**
 * Subset of `LiveMasterFeature` whose subscription requires an active live-room
 * WebSocket connection. Mirrors `@bilibili-notify/push`'s `LIVE_ROOM_MASTERS`.
 */
export const LIVE_ROOM_MASTER_KEYS: readonly LiveMasterFeature[] = [
	"live",
	"liveEnd",
	"liveGuardBuy",
	"superchat",
];

/**
 * 下播的两个附加项(词云 / AI 总结):像开播的 @全体,挂在下播下面,跟着下播的开关与目标走。
 * 卡片先发,它们算好后作为同一次推送的后续消息追加。
 */
export interface LiveEndExtrasLike {
	wordcloud: boolean;
	liveSummary: boolean;
}

/** 这位 UP 要不要采集弹幕:下播开着,且至少一个附加项开着。 */
export function wantsLiveEndExtras(sub: SubItemView): boolean {
	return sub.liveEnd && (sub.liveEndExtras.wordcloud || sub.liveEndExtras.liveSummary);
}

/** Sub-level customisation blocks copied from `@bilibili-notify/push`. */
export interface CustomCardStyleLike {
	enable: boolean;
	cardColorStart?: string;
	cardColorEnd?: string;
	/** 玻璃片(内容层)透明度 0..1;透传给 generate* 的 colorOptions。 */
	glassOpacity?: number;
	/** 完全透明:内容层透明 + 无模糊;透传给 generate* 的 colorOptions。 */
	glassClear?: boolean;
	/** 背景图资产 id;透传给 generate* 的 colorOptions(renderer 经 resolveAsset 解析)。 */
	backgroundImage?: string;
	/**
	 * 该卡片类型解析后的**完整**背景图列表(>1 张时「每次推送轮换」)。adapter 折算 per-kind
	 * 时填入;推送点据它选下一张覆盖 `backgroundImage`。缺省 / ≤1 张 = 不轮换,用 `backgroundImage`。
	 */
	backgroundImages?: string[];
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
	/** 直播卡数据区:显示人气 / 点赞;透传给 generateLiveCard 的 colorOptions(缺省回退全局)。 */
	showPopularity?: boolean;
	/** 直播卡数据区:显示分区;透传给 generateLiveCard 的 colorOptions(缺省回退全局)。 */
	showArea?: boolean;
	/** 直播卡数据区:显示粉丝数据;透传给 generateLiveCard 的 colorOptions(缺省回退全局)。 */
	showFans?: boolean;
}

/**
 * 背景图轮换选择器:给定 scopeKey 与该 kind 的完整图列表,返回本次该用的背景(并在实现内
 * 推进游标)。宿主注入(独立端有 fs 持久化游标);返回 undefined = 不轮换。
 */
export type PickCardBackground = (scopeKey: string, images: string[]) => string | undefined;

export interface CustomLiveMsgLike {
	enable: boolean;
	customLiveStart?: string;
	customLive?: string;
	customLiveEnd?: string;
}

export interface CustomGuardBuyLike {
	enable: boolean;
	guardBuyMsg?: string;
	captainImgUrl?: string;
	supervisorImgUrl?: string;
	governorImgUrl?: string;
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
	uid: string;
	uname: string;
	roomId: string;
	dynamic: boolean;
	live: boolean;
	liveEnd: boolean;
	liveGuardBuy: boolean;
	superchat: boolean;
	/** 见 {@link LiveEndExtrasLike}。宿主折叠 `eff.features.liveEndExtras` 后填入。 */
	liveEndExtras: LiveEndExtrasLike;
	target: SubItemTargetLike;
	customCardStyle: CustomCardStyleLike;
	/**
	 * 按卡片类型的样式覆盖(per-kind)。adapter 已用 `resolveCardStyleForKind` 把
	 * 「全局基准 → 全局类型 → UP 基准 → UP 类型」折算成每 kind 的**完整** colorOptions
	 * (enable:true);各 generate* 调用点优先取本 kind 的条目,缺失则回退基准
	 * {@link customCardStyle}。缺省时全部回退基准。
	 */
	customCardStyleByKind?: Partial<Record<CardKind, CustomCardStyleLike>>;
	customLiveMsg: CustomLiveMsgLike;
	customGuardBuy: CustomGuardBuyLike;
	customLiveSummary: CustomLiveSummaryLike;
	customSpecialDanmakuUsers: CustomSpecialDanmakuUsersLike;
	customSpecialUsersEnterTheRoom: CustomSpecialUsersEnterTheRoomLike;
	/**
	 * Per-UP 阈值 / 调度。adapter build SubItemView 时已一次性折算好
	 * (`sub.overrides.X ?? 全局 config.X`),引擎 / 监听层直接消费,无二次回退。
	 * 随 LiveScopedChange 增量推送给 LiveEngine.applyOps;pushTime 变更时
	 * engine 额外 rearm 定时器(setInterval 句柄 ms 不可变)。
	 */
	minScPrice: number;
	minGuardLevel: 1 | 2 | 3;
	pushTime: number;
	restartPush: boolean;
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
	 * 该 UP 解析后的卡片版式描述符(块顺序 / 显隐;guard 含 badgeSide)。adapter 已折算好
	 * (per-UP 整份覆盖 ?? 全局)。各 generate* 渲染时取对应卡片的切片;undefined = 走默认版式。
	 */
	cardLayout?: CardLayout;
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
		| "live"
		| "liveEnd"
		| "liveGuardBuy"
		| "superchat"
		| "liveEndExtras"
		| "uname"
		| "roomId"
		| "customCardStyle"
		| "customCardStyleByKind"
		| "customLiveMsg"
		| "customGuardBuy"
		| "customLiveSummary"
		| "customSpecialDanmakuUsers"
		| "customSpecialUsersEnterTheRoom"
		| "minScPrice"
		| "minGuardLevel"
		| "pushTime"
		| "restartPush"
		| "liveEndGrace"
		| "liveEndGraceMinutes"
		| "aiOverride"
		| "wordcloudStopWords"
		| "cardLayout"
		| "messageLayout"
	>
>;

export type DynamicScopedChange = { scope: "dynamic" } & Partial<Pick<SubItemView, "dynamic">>;

export type TargetScopedChange = { scope: "target" } & Pick<SubItemView, "target">;

export type LiveSubChange = LiveScopedChange | DynamicScopedChange | TargetScopedChange;

export type LiveSubscriptionOp =
	| { type: "add"; sub: SubItemView }
	| { type: "delete"; uid: string }
	| { type: "update"; uid: string; changes: LiveSubChange[] };

/**
 * Push-out interface required by live-engine. Mirrors the methods on
 * `@bilibili-notify/push`'s `BilibiliPush` we actually call.
 *
 * `content` is intentionally `unknown` — the host passes its own
 * `NotificationPayload`; the engine only forwards the value through.
 */
/**
 * 一次广播的身份与角色。`pushId`:同一次推送可以分好几次广播(下播卡先发,词云 / 总结算好了
 * 再发),传同一个,宿主的历史就落在同一行里追加;不传 = 宿主自己起一个。`role`:这段
 * 消息是本体还是附加项,缺省本体。
 */
export interface LiveBroadcastOptions {
	pushId?: string;
	role?: "main" | "extra";
}

export interface PushLike {
	broadcastToTargets(
		uid: string,
		content: unknown,
		type: LivePushType,
		opts?: LiveBroadcastOptions,
	): Promise<void>;
	/**
	 * 消息版式分条:一次推送拆成多条消息的序列广播(语义同 dynamic 端 PushLike 的
	 * broadcastDynamicSequence:同 target 顺序发、某条失败中止该 target 后续条、
	 * @全体只跟首条)。
	 */
	broadcastSequenceToTargets(
		uid: string,
		contents: unknown[],
		type: LivePushType,
		opts?: LiveBroadcastOptions,
	): Promise<void>;
	sendPrivateMsg(content: string): Promise<void>;
}
