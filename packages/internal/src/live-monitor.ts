/**
 * 「这条订阅要不要监听直播」的唯一判定(ADR-0027 决策 1)。
 *
 * 零依赖子路径 `@bilibili-notify/internal/live-monitor`:服务端(直播引擎开监听、统计记不记、首页「直播」那一格)
 * 与面板(「没开直播推送,不会被监听」那句)读的是同一份,所以**只许有 type import**
 * (`scripts/__tests__/internal-package.test.mjs` 钉着)。
 */

import type { FeatureKey } from "./features";

/** 直播类的五把主开关 —— 任一开着,这条订阅就要监听直播间。 */
export const LIVE_ROOM_CREATOR_KEYS = [
	"liveStart",
	"liveStreaming",
	"liveEnd",
	"membership",
	"superchat",
] as const;

export type LiveRoomCreatorKey = (typeof LIVE_ROOM_CREATOR_KEYS)[number];

/** {@link needsLiveMonitor} 要看的开关:五把直播类,加上两把特别开关。 */
export type LiveMonitorFeatures = Record<
	LiveRoomCreatorKey | "viewerChat" | "viewerEnter",
	boolean
>;

/**
 * {@link needsLiveMonitor} 的入参:折好的开关(`resolve` 之后的 `features`,多出来的键不看)与订阅的特别关注名单
 * (`sub.specialViewers`,只看每个条目带哪些特性键)。调用处直接递这两样,不自己摆,也不自己做「开关 ∧ 名单」。
 */
export interface LiveMonitorInput {
	features: LiveMonitorFeatures;
	specialViewers: readonly { features: readonly FeatureKey[] }[];
}

/**
 * 这条订阅要不要监听直播间:五把直播类主开关任一开着,或某把特别开关开着、**且**名单上有人带这一把
 * (`viewerChat` 对 `viewerChat`,`viewerEnter` 对 `viewerEnter`)。开关关着,名单上有人也不监听;开关开着而名单上
 * 没人带它,同样不监听。只看折好的生效值,不看有没有推送目标、不依赖房间上下文。
 * 拓展订阅没有设置特别关注的入口,名单天然是空。
 */
export function needsLiveMonitor(sub: LiveMonitorInput): boolean {
	const listed = (feature: FeatureKey) =>
		sub.specialViewers.some((v) => v.features.includes(feature));
	return (
		LIVE_ROOM_CREATOR_KEYS.some((k) => sub.features[k]) ||
		(sub.features.viewerChat && listed("viewerChat")) ||
		(sub.features.viewerEnter && listed("viewerEnter"))
	);
}
