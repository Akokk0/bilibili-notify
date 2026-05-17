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
	| "specialUserEnterTheRoom";

/**
 * Master-level feature keys — the boolean toggles set per-UP. Subset of
 * `LivePushFeature` which omits `specialDanmaku` / `specialUserEnterTheRoom`
 * (those are gated by `customSpecial*.enable` instead).
 */
export type LiveMasterFeature = Exclude<
	LivePushFeature,
	"specialDanmaku" | "specialUserEnterTheRoom"
>;

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
	 * Per-UP 覆盖项。adapter 已通过 `resolve(sub, defaults)` 折叠 globals + overrides,
	 * 这里只保留实际跟全局可能不同的字段;undefined 表示「按全局走」。room-session /
	 * room-session-base / live-summary-requester 在用值前一律 `?? ctx.config.X` 回退。
	 *
	 * 这些字段也会随 LiveScopedChange 增量推送给 LiveEngine.applyOps,Object.assign
	 * 合进活跃 sub 后,SC / 上舰 / restartPush / liveSummary 调用点会读到新值;pushTime
	 * 因 setInterval 句柄 ms 不可变,engine 在 update 时检测变化后会单独 rearm。
	 */
	minScPrice?: number;
	minGuardLevel?: 1 | 2 | 3;
	pushTime?: number;
	restartPush?: boolean;
	aiOverride?: CommentaryCallOverride;
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
		| "aiOverride"
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
