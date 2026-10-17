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

/**
 * `websocket()` 交出的连接 —— `ws` 的 WebSocket 的最小子集,不把第三方库的类型摆进对外面。
 *
 * 事件(`open` / `message` / `error` / `close`)用 `on` 订阅,监听器的参数照 `ws` 给:
 * `message` 是 `(data, isBinary)`,`close` 是 `(code, reason)`。**一定要挂 `error`**:
 * 握手期被关(含 `signal` 中止)时 `ws` 会先报一次 `error` 再 `close`,没人接会炸进程。
 */
export interface WebSocketLike {
	/** 二进制帧交给 `message` 监听器的形态;常用 `"nodebuffer"`。 */
	binaryType: string;
	/** 连接状态,取值照 WHATWG:0 建连中 / 1 已连上 / 2 关闭中 / 3 已关。 */
	readonly readyState: number;
	on(event: string, listener: (...args: unknown[]) => void): void;
	/** 字符串发文本帧,字节发二进制帧(`ws` 本来就这么分)。 */
	send(data: string | Uint8Array): void;
	close(): void;
}

export interface WebSocketOptions {
	/**
	 * 附加的握手头。默认头(`Cookie`、`User-Agent`)在前,这里同名(大小写不敏感)的盖过它、
	 * 留在原位置,别的追加在后面。
	 */
	headers?: Record<string, string>;
	/**
	 * 中止就关掉连接(建连时已经中止的,连接一建好就关)。握手期被关会先报一次 `error` 再 `close`。
	 * 集成停下时自动关就靠它(3a 把 `ctx.signal` 接到这里)。
	 */
	signal?: AbortSignal;
	/** 「不带身份、不碰罐」一档:握手不带 `Cookie` 与身份的 `User-Agent`,只有上面的 `headers`。 */
	bare?: boolean;
}

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
