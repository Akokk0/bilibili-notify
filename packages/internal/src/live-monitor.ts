/**
 * 「这条订阅要不要监听直播」的唯一判定(ADR-0027 决策 1)。
 *
 * 零依赖子路径 `@bilibili-notify/internal/live-monitor`:服务端(直播引擎开监听、统计记不记、首页「直播」那一格)
 * 与面板(「没开直播推送,不会被监听」那句)读的是同一份,所以**只许有 type import**
 * (`constants-imports.test.ts` 钉着)。
 */

/** 直播类的五把主开关 —— 任一开着,这条订阅就要监听直播间。 */
export const LIVE_ROOM_CREATOR_KEYS = [
	"liveStart",
	"liveStreaming",
	"liveEnd",
	"membership",
	"superchat",
] as const;

export type LiveRoomCreatorKey = (typeof LIVE_ROOM_CREATOR_KEYS)[number];

/** 订阅的特别关注名单上,有人带哪几把特性键(`viewerChat` / `viewerEnter`)。 */
export interface SpecialUserFlags {
	/** 名单上有人带 `viewerChat`。 */
	viewerChat: boolean;
	/** 名单上有人带 `viewerEnter`。 */
	viewerEnter: boolean;
}

/** {@link needsLiveMonitor} 要看的那几格:折好的直播类开关,加上那两个特别关注条件。 */
export type LiveMonitorInput = Record<LiveRoomCreatorKey, boolean> & SpecialUserFlags;

/**
 * 一条订阅的特别关注条件:看它的 `specialViewers` 里有没有人带对应的特性键。拓展订阅没有设置特别关注的入口,
 * 这两格天然是空(与「传关」同一个结果)。
 */
export function specialUserFlagsOf(sub: {
	specialViewers: readonly { features: readonly string[] }[];
}): SpecialUserFlags {
	return {
		viewerChat: sub.specialViewers.some((v) => v.features.includes("viewerChat")),
		viewerEnter: sub.specialViewers.some((v) => v.features.includes("viewerEnter")),
	};
}

/**
 * 「订阅 → 判定的入参」:折好的五把直播类开关(`resolve` 之后的 `features`,多出来的键不看)加两个特别关注
 * 条件({@link specialUserFlagsOf})。服务端统计与首页「直播」那一格都从这里摆,不各写一遍。
 */
export function liveMonitorInputOf(
	features: Record<LiveRoomCreatorKey, boolean>,
	special: SpecialUserFlags,
): LiveMonitorInput {
	return {
		liveStart: features.liveStart,
		liveStreaming: features.liveStreaming,
		liveEnd: features.liveEnd,
		membership: features.membership,
		superchat: features.superchat,
		...special,
	};
}

/**
 * 这条订阅要不要监听直播间:五把直播类主开关任一开着,或配了特别弹幕 / 特别进场用户。
 * 只看折好的生效值,不看有没有推送目标、不依赖房间上下文。
 */
export function needsLiveMonitor(sub: LiveMonitorInput): boolean {
	return LIVE_ROOM_CREATOR_KEYS.some((k) => sub[k]) || sub.viewerChat || sub.viewerEnter;
}
