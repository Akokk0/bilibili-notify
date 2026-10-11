import type {
	CustomSpecialDanmakuUsersLike,
	CustomSpecialUsersEnterTheRoomLike,
	LiveCreatorFeature,
} from "./live-types";

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
export interface LiveMonitorInput {
	liveStart: boolean;
	liveStreaming: boolean;
	liveEnd: boolean;
	membership: boolean;
	superchat: boolean;
	customSpecialDanmakuUsers: CustomSpecialDanmakuUsersLike;
	customSpecialUsersEnterTheRoom: CustomSpecialUsersEnterTheRoomLike;
}

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
