/**
 * 直播的中立小类型:推送是哪一种、特性键、订阅上的直播卡样式与「特别用户」两块设置的形状。
 * 所有直播来源共用(ADR-0019 决策 65 / 67),不认 uid、不认房间数据。
 */

import type {
	ExtraKey,
	MessageLayoutSegment,
	PushMessageRole,
	SpecialViewer,
} from "@bilibili-notify/internal";

/**
 * 一次直播推送里的一个锚点 —— 推送层 `PushAnchor` 在引擎这一侧的样子:本体(开播 / 下播卡、
 * 上舰、醒目留言……),或一个附加项(下播的词云、AI 总结)。锚点按先后发。
 *
 * 一条消息是一串中立的文字 / 图片段;锚点只决定这些消息先后发,不认具体平台的消息形状。
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
	messages: MessageLayoutSegment[][] | Promise<MessageLayoutSegment[][] | undefined>;
	/**
	 * AI 写的那一份(只有下播的总结有):形状同 `messages`,由推送层按目标挑用这份还是 `messages`
	 * (ADR-0032)。没有 AI 版就**不带这一格**(键缺失),不是 `undefined` 值;约定兑现成 `undefined`
	 * 或被拒绝 = 这次没做出来,所有目标用 `messages`。
	 */
	aiMessages?: MessageLayoutSegment[][] | Promise<MessageLayoutSegment[][] | undefined>;
}

/**
 * Push category enum — numeric values are the historical bilibili-notify push-type codes.
 * 只在进程内流转(推送层的翻译表按它分流、日志里打出来),**不落盘、不过 wire**:历史行与订阅、
 * 设置存的都是特性键,所以加一档、删一档都不用迁移。
 *
 * 它说的是「这是哪一种推送」:定特性键、定许不许 @全体。下播的附加项(词云、AI 总结)不是单独的
 * 一种推送,是下播那次推送里的锚点(`LivePushAnchor`),按附加项的键认 —— 原先的 5 / 10 两档
 * 随之删掉,编号空着不复用。
 */
export enum LivePushType {
	/** 周期「正在直播」(`liveStreaming`)。 */
	Live = 0,
	StartBroadcasting = 3,
	LiveGuardBuy = 4,
	Superchat = 6,
	ViewerChat = 7,
	ViewerEnter = 8,
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
	| "viewerChat"
	| "viewerEnter";

/**
 * Master-level feature keys — the boolean toggles set per-UP. Subset of
 * `LivePushFeature` which omits `viewerChat` / `viewerEnter`
 * (those are gated by the special viewer list instead).
 */
export type LiveCreatorFeature = Exclude<LivePushFeature, "viewerChat" | "viewerEnter">;

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

/**
 * 特别关注的一块设置:订阅的名单加这一种互动的文案。「特别弹幕」「特别进场」两块同形;名单上谁带哪把特性键
 * 由条目的 `features` 说了算,没有单独的 `enable`(开关归推送层判)。
 */
export interface SpecialViewerSettings {
	specialViewers: readonly SpecialViewer[];
	template: string;
}
