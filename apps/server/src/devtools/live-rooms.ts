import type { LiveConnectionInfo, LiveEvent } from "@bilibili-notify/blive";

/**
 * 直播间连接登记 —— blive 的连接观察钩子(`observeLiveConnections`)把每条连接报到这里,
 * 记住「房号 → 那条连接的 onEvent」。直播类场景按房号往里塞事件:走的是与真帧完全相同
 * 的回调,上游 room-session 分不出真假,也就一行不用动。
 *
 * 连接关了就当没有(blive 那头 `emit` 本来也会丢),同一房间重连以最新那条为准。
 */
export interface LiveRoomHandle {
	inject(ev: LiveEvent): void;
}

export interface LiveRooms {
	/** 交给 `observeLiveConnections` 的那个回调。 */
	observe(info: LiveConnectionInfo): void;
	find(roomId: number): LiveRoomHandle | undefined;
	/** 现在连着的房号。 */
	rooms(): number[];
}

export function createLiveRooms(): LiveRooms {
	const byRoom = new Map<number, LiveConnectionInfo>();

	function live(roomId: number): LiveConnectionInfo | undefined {
		const info = byRoom.get(roomId);
		if (!info) return undefined;
		if (info.client.closed) {
			byRoom.delete(roomId);
			return undefined;
		}
		return info;
	}

	return {
		observe(info) {
			byRoom.set(info.roomId, info);
		},
		find(roomId) {
			const info = live(roomId);
			return info ? { inject: (ev) => info.onEvent(ev) } : undefined;
		},
		rooms: () => [...byRoom.keys()].filter((id) => live(id) !== undefined),
	};
}
