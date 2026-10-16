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
import type { ExtraKey, MembershipTemplateBundle } from "@bilibili-notify/internal";
import type { LiveWorkSettings } from "../../live/live-settings";
import type {
	LivePushAnchor,
	LivePushFeature,
	LivePushType,
	SpecialViewerSettings,
} from "../../live/live-types";

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

export interface CustomLiveSummaryLike {
	enable: boolean;
	liveSummary?: string;
}

/** Per-feature target list (already resolved to channel identifiers). */
export type SubItemTargetLike = Partial<Record<LivePushFeature, unknown[]>>;

/**
 * Platform-neutral view of a single subscription, structurally compatible with
 * `@bilibili-notify/push`'s `SubItem`. The live engine only reads this shape; the
 * host builds the instances (folding per-UP overrides onto the globals).
 */
export interface SubItemView extends LiveWorkSettings {
	/**
	 * 这条订阅在核心里的 id(`Subscription.id`),由宿主 `buildLiveSubViewSingle` 填。直播引擎认人靠 `uid`(B 站的 uid),
	 * 但中立事件(`MembershipEvent` / `SuperchatEvent`)的 `subscriptionId` 是核心的订阅 id —— 来源不知道,由宿主带进来。
	 */
	subscriptionId: string;
	uid: string;
	uname: string;
	roomId: string;
	post: boolean;
	membership: boolean;
	superchat: boolean;
	/**
	 * 特别弹幕 / 特别进场的开关(`eff.features.viewerChat` / `viewerEnter`)。要不要监听直播间是「开关 ∧ 名单上有人带它」
	 * (internal 的 `needsLiveMonitor`),名单在 {@link customSpecialDanmakuUsers} / {@link customSpecialUsersEnterTheRoom}。
	 */
	viewerChat: boolean;
	viewerEnter: boolean;
	/** 见 {@link PushExtrasLike}。宿主折叠 `eff.features.extras` 后整份填入。 */
	extras: PushExtrasLike;
	target: SubItemTargetLike;
	/**
	 * 这条订阅上 B 站的会员体系(`guard`)的文案(`overrides.templates.membership.guard`,没覆盖就是全局那份,㉓d)。
	 * `enabled` 为 true 才用它(取法见 `membershipTemplateOf`:按事件的档位 key 取那一档,没填的格用体系默认);为 false 时
	 * 回落 {@link ListenerManagerConfig.guardTemplate}(全局那份),全局也没开就走官方上舰图 / 上舰卡。
	 */
	guardTemplate: MembershipTemplateBundle;
	customLiveSummary: CustomLiveSummaryLike;
	customSpecialDanmakuUsers: SpecialViewerSettings;
	customSpecialUsersEnterTheRoom: SpecialViewerSettings;
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
