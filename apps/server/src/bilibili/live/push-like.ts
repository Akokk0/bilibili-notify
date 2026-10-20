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
import type { MembershipTemplateBundle } from "@bilibili-notify/internal";
import type { LiveSettings } from "../../live/live-settings";
import type { LivePushAnchor, LivePushFeature, LivePushType } from "../../live/live-types";

// 附加项的开关、总结模板与「要不要采集弹幕」的判定住在核心的直播设置里(S8),这里原样转出去 ——
// B 站老引擎到 22-10 撤掉前仍从这个路径取。
export type { CustomLiveSummaryLike, PushExtrasLike } from "../../live/live-settings";
export { wantsLiveEndExtras } from "../../live/live-settings";

/** Per-feature target list (already resolved to channel identifiers). */
export type SubItemTargetLike = Partial<Record<LivePushFeature, unknown[]>>;

/**
 * Platform-neutral view of a single subscription, structurally compatible with
 * `@bilibili-notify/push`'s `SubItem`. The live engine only reads this shape; the
 * host builds the instances (folding per-UP overrides onto the globals).
 */
export interface SubItemView extends LiveSettings {
	/**
	 * 这条订阅在核心里的 id(`Subscription.id`),由宿主 `buildLiveSubViewSingle` 填。直播引擎认人靠 `uid`(B 站的 uid),
	 * 但中立事件(`MembershipEvent` / `SuperchatEvent`)的 `subscriptionId` 是核心的订阅 id —— 来源不知道,由宿主带进来。
	 */
	subscriptionId: string;
	uid: string;
	uname: string;
	roomId: string;
	post: boolean;
	target: SubItemTargetLike;
	/**
	 * 这条订阅上 B 站的会员体系(`guard`)的文案(`overrides.templates.membership.guard`,没覆盖就是全局那份,㉓d)。
	 * `enabled` 为 true 才用它(取法见 `membershipTemplateOf`:按事件的档位 key 取那一档,没填的格用体系默认);为 false 时
	 * 回落 {@link ListenerManagerConfig.guardTemplate}(全局那份),全局也没开就走官方上舰图 / 上舰卡。
	 */
	guardTemplate: MembershipTemplateBundle;
	/**
	 * Per-UP 阈值 / 调度。adapter build SubItemView 时已一次性折算好
	 * (`sub.overrides.X ?? 全局 config.X`),引擎 / 监听层直接消费,无二次回退。
	 * 随 LiveScopedChange 增量推送给 LiveEngine.applyOps;`liveStreaming` 开关或
	 * `streamingIntervalHours` 变更时 engine 额外 rearm 定时器(setInterval 句柄 ms 不可变)。
	 */
	/** 上舰门槛(㉓d,原先是 `minGuardLevel`):档位 rank 低于它不推(1 = 舰长最低、3 = 总督);没配 = 全推。 */
	minGuardRank?: number;
	/** undefined = 该 UP 无 per-UP AI 覆盖,直播总结走 AI 引擎自身配置。 */
	aiOverride?: CommentaryCallOverride;
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
		| "viewerChat"
		| "viewerEnter"
		| "extras"
		| "uname"
		| "roomId"
		| "liveCoverImageIds"
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

/** 锚点的定义搬去了核心的 `live/live-types.ts`(中立的);这里转出,出口名不变。 */
export type { LivePushAnchor };

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
}
