import type { WebSocketLike, WebSocketOptions } from "@bilibili-notify/internal";
import { fail, ok, type Result } from "@bilibili-notify/internal/constants";
import WebSocket from "ws";

/**
 * WebSocket 建连 —— 只管「把连接建起来、signal 中止就关」,帧、心跳、重连归调用方。
 *
 * 握手头由 {@link HttpClient.websocket} 按身份与罐子装配好交进来(那里管头序);这一层是全仓
 * 唯一 `new WebSocket(` 的地方(出网点名表),**只透传 `headers`**:`ws` 的其余默认项
 * (`Sec-WebSocket-Extensions` 的压缩协商等)一个不动,线上握手才和裸 `new WebSocket(url, { headers })`
 * 时一致。
 */

// 对外的接口类型住核心包(包之间不成环,ADR-0025 决策 6);这里转出,下游的 import 不用改。
export type { WebSocketLike, WebSocketOptions };

/**
 * 建一条连接。协议 `ws` 不收(如 `ftp:`)时回 `invalid`,不抛 —— 地址常来自主人填的设置或
 * 拓展,是输入而不是 bug。话里的地址不带 query(可能含令牌)。
 */
export function connectWebSocket(
	url: URL,
	headers: Record<string, string>,
	signal?: AbortSignal,
): Result<{ socket: WebSocketLike }> {
	let socket: WebSocket;
	try {
		socket = new WebSocket(url, { headers });
	} catch {
		return fail("invalid", `不支持的 WebSocket 地址: ${url.origin}${url.pathname}`);
	}
	if (signal) {
		const abort = () => socket.close();
		if (signal.aborted) {
			abort();
		} else {
			// 连接收摊时把监听摘掉,长寿的 signal(集成的 `ctx.signal`)不攒监听器。
			signal.addEventListener("abort", abort, { once: true });
			socket.once("close", () => signal.removeEventListener("abort", abort));
		}
	}
	return ok({ socket });
}

/**
 * 查罐子用的地址:`wss:` 按 `https:`、`ws:` 按 `http:` 算 —— 罐子只认 http(s),而 B 站的
 * SESSDATA 之类是 `Secure`,按 `wss:` 直接查会让它们静默掉线。其余协议原样(`ws` 会拒掉)。
 */
export function cookieLookupUrl(url: URL): URL {
	const lookup = new URL(url);
	if (url.protocol === "wss:") lookup.protocol = "https:";
	else if (url.protocol === "ws:") lookup.protocol = "http:";
	return lookup;
}
