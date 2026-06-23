/**
 * Platform-neutral subset of the koishi `BilibiliPush` surface used by live-engine.
 *
 * live-engine intentionally does NOT depend on `@bilibili-notify/push` (which
 * still pulls in koishi). Adapters (the Koishi shell or the standalone runtime)
 * provide a `PushLike` instance whose methods cover only what this engine needs.
 *
 * The accompanying `SubItemView` and feature key types mirror the platform-neutral
 * subset of `@bilibili-notify/push`'s `SubItem` shape consumed by listener /
 * collector / template helpers — same approach as `ai-engine/src/tools.ts`.
 */

import type { CommentaryCallOverride } from "@bilibili-notify/ai";

/** Push category enum — numeric values are the historical bilibili-notify push-type codes. */
export enum LivePushType {
	Live = 0,
	StartBroadcasting = 3,
	LiveGuardBuy = 4,
	/** 历史上承载词云+总结合包推送;现在仅用于词云,总结走 {@link LiveSummary}。 */
	WordCloudAndLiveSummary = 5,
	Superchat = 6,
	UserDanmakuMsg = 7,
	UserActions = 8,
	LiveEnd = 9,
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
	| "wordcloud"
	| "liveSummary"
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
	"wordcloud",
	"liveSummary",
];

/** Sub-level customisation blocks copied from `@bilibili-notify/push`. */
export interface CustomCardStyleLike {
	enable: boolean;
	cardColorStart?: string;
	cardColorEnd?: string;
}

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
 * adapter is responsible for providing instances (the Koishi shell hands its
 * `SubItem`s through unchanged, since their fields match by name).
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
	wordcloud: boolean;
	liveSummary: boolean;
	target: SubItemTargetLike;
	customCardStyle: CustomCardStyleLike;
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
}

export type SubscriptionsView = Record<string, SubItemView>;

/**
 * Scoped change object — mirrors `koishi-plugin-bilibili-notify`'s
 * `SubChange` so the koishi adapter can forward incremental subscription
 * updates without translation.
 */
export type LiveScopedChange = { scope: "live" } & Partial<
	Pick<
		SubItemView,
		| "live"
		| "liveEnd"
		| "liveGuardBuy"
		| "superchat"
		| "wordcloud"
		| "liveSummary"
		| "uname"
		| "roomId"
		| "customCardStyle"
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
 * `content` is intentionally `unknown` — the koishi adapter passes koishi's
 * `h(...)` element fragments while the standalone adapter will pass its own
 * `NotificationPayload`. The engine only forwards the value through.
 */
export interface PushLike {
	broadcastToTargets(uid: string, content: unknown, type: LivePushType): Promise<void>;
	sendPrivateMsg(content: string): Promise<void>;
}
