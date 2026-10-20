/** B 站直播间短号优先；短号为 0 时用长号。 */
export function buildRoomLink(info: { short_id: number; room_id: number }): string {
	return `https://live.bilibili.com/${info.short_id === 0 ? info.room_id : info.short_id}`;
}
