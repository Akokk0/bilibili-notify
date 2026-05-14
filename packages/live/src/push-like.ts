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

/** Push category enum — value-compatible with `@bilibili-notify/push`'s `PushType`. */
export enum LivePushType {
	Live = 0,
	StartBroadcasting = 3,
	LiveGuardBuy = 4,
	WordCloudAndLiveSummary = 5,
	Superchat = 6,
	UserDanmakuMsg = 7,
	UserActions = 8,
	LiveEnd = 9,
}

/**
 * Channel-level feature keys (mirror `@bilibili-notify/push`'s `PushFeature`).
 * Each entry on `SubItemView.target` maps to a list of resolved channel
 * identifiers; an empty / missing list means "not subscribed for this feature".
 */
export type LivePushFeature =
	| "dynamic"
	| "dynamicAtAll"
	| "live"
	| "liveAtAll"
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
	dynamicAtAll: boolean;
	live: boolean;
	liveAtAll: boolean;
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
	 * 这些字段不上 LiveScopedChange —— LiveEngine.applyOps 只把 routing 布尔合进
	 * 活跃 sub,新阈值要等下次监听重建(用户改完订阅或服务重启)才生效。同步热重载
	 * 的修法见审计文档 #4。
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
		| "liveAtAll"
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
	>
>;

export type DynamicScopedChange = { scope: "dynamic" } & Partial<
	Pick<SubItemView, "dynamic" | "dynamicAtAll">
>;

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
