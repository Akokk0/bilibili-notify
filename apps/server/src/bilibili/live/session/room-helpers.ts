import type { Failure } from "@bilibili-notify/internal";
import type { LiveRoomDanmakuResponse } from "../../api/index.js";
import { t as serverText } from "../../i18n.js";

type LiveRoomDanmaku = LiveRoomDanmakuResponse["data"];

export class LiveRoomAccessDeniedError extends Error {
	constructor(readonly reason: string) {
		super(serverText("bilibili.live.session.room-helpers.text.1", { value0: reason }));
		this.name = "LiveRoomAccessDeniedError";
	}
}

export class LiveRoomPreflightBlockedError extends Error {
	constructor(readonly reason: string) {
		super(serverText("bilibili.live.session.room-helpers.text.2", { value0: reason }));
		this.name = "LiveRoomPreflightBlockedError";
	}
}

export function reasonOfFailure(failure: Failure): string {
	const message = failure.message ? ` message=${failure.message}` : "";
	return serverText("bilibili.live.session.room-helpers.text.3", {
		value0: failure.upstreamCode ?? failure.code,
		value1: message,
	});
}

export function describeLiveRoomDanmakuAccessDenied(info: LiveRoomDanmaku): string | undefined {
	if (!info) return serverText("bilibili.live.session.room-helpers.text.4");
	const token = typeof info.token === "string" ? info.token.trim() : "";
	if (!token) return serverText("bilibili.live.session.room-helpers.text.5");
	if (!Array.isArray(info.host_list) || info.host_list.length === 0) {
		return serverText("bilibili.live.session.room-helpers.text.6");
	}
	return undefined;
}
