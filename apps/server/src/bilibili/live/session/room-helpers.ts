import type { Failure } from "@bilibili-notify/internal";
import type { LiveRoomDanmakuResponse } from "../../api/index.js";

type DanmakuInfo = LiveRoomDanmakuResponse["data"];

export class LiveRoomAccessDeniedError extends Error {
	constructor(readonly reason: string) {
		super(`弹幕连接不可用：${reason}，可能是加密/付费/测试房或当前账号无权限访问`);
		this.name = "LiveRoomAccessDeniedError";
	}
}

export class LiveRoomPreflightBlockedError extends Error {
	constructor(readonly reason: string) {
		super(`弹幕连接预检被风控拦截：${reason}`);
		this.name = "LiveRoomPreflightBlockedError";
	}
}

export function reasonOfFailure(failure: Failure): string {
	const message = failure.message ? ` message=${failure.message}` : "";
	return `B 站返回 code=${failure.upstreamCode ?? failure.code}${message}`;
}

export function describeLiveRoomDanmakuAccessDenied(info: DanmakuInfo): string | undefined {
	if (!info) return "B 站未返回弹幕连接信息";
	const token = typeof info.token === "string" ? info.token.trim() : "";
	if (!token) return "B 站未返回弹幕 token";
	if (!Array.isArray(info.host_list) || info.host_list.length === 0) {
		return "B 站未返回弹幕服务器列表";
	}
	return undefined;
}
