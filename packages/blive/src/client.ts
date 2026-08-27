/**
 * 直播信息流 WSS 客户端 —— 哑管道。
 *
 * 职责边界:连接 + 认证 + 心跳 + 编解码/解析进 `onEvent` 漏斗,仅此而已。
 * 连接参数(token / host_list / uid / buvid)全部由调用方注入,这里不发任何
 * HTTP;不做内部重连 —— 断线重连、退避、放弃全是 RoomSession 的策略。
 *
 * close() 之后保证静默:不再发包、不再上报任何事件(包括主动关闭的 close
 * 回声),上层不需要「有意关闭」记账。
 */

import WebSocket from "ws";
import { decodeFrames, encodePacket, WsOp } from "./codec.js";
import type { LiveEvent } from "./events.js";
import { parseCommand } from "./parser.js";

/** 客户端消费的 socket 最小面(ws 的子集),测试注入假实现。 */
export interface SocketLike {
	binaryType: string;
	on(event: string, fn: (...args: unknown[]) => void): void;
	send(data: Uint8Array): void;
	close(): void;
}

export interface DanmuHost {
	host: string;
	wssPort: number;
}

export interface LiveConnectOptions {
	/** 真实长房号(短号由调用方经预检解析)。 */
	roomId: number;
	/** 登录账号 uid。 */
	uid: number;
	/** getDanmuInfo 返回的连接 token。 */
	token: string;
	/** 真实 buvid3(finger/spi 或 cookie 罐),进认证包。 */
	buvid: string;
	/** getDanmuInfo 返回的服务器列表,取首项。 */
	hostList: DanmuHost[];
	cookieHeader?: string;
	/**
	 * **必传**,调用方从 `api.getUserAgent()` 取 —— WSS 必须与同进程的 HTTP 同
	 * 指纹(api 侧是每实例生成的自洽 Chrome 身份)。不设兜底:兜底值只会在
	 * 谁忘传时静默造出第二套指纹。
	 */
	userAgent: string;
	onEvent: (ev: LiveEvent) => void;
	/** 注入点:测试/定制 socket 工厂。缺省用 ws。 */
	createSocket?: (url: string, headers: Record<string, string>) => SocketLike;
	/** 心跳节奏,缺省 30s。 */
	heartbeatIntervalMs?: number;
}

export interface LiveClient {
	readonly closed: boolean;
	close(): void;
}

const DEFAULT_HEARTBEAT_MS = 30_000;

function defaultCreateSocket(url: string, headers: Record<string, string>): SocketLike {
	return new WebSocket(url, { headers }) as unknown as SocketLike;
}

/** 建立一条直播间信息流连接。 */
export function connectLiveRoom(opts: LiveConnectOptions): LiveClient {
	const first = opts.hostList[0];
	if (!first) throw new Error("hostList 为空");
	const url = `wss://${first.host}${first.wssPort === 443 ? "" : `:${first.wssPort}`}/sub`;
	const headers: Record<string, string> = {};
	if (opts.cookieHeader) headers.Cookie = opts.cookieHeader;
	headers["User-Agent"] = opts.userAgent;

	const socket = (opts.createSocket ?? defaultCreateSocket)(url, headers);
	socket.binaryType = "nodebuffer";

	let closed = false;
	let authReplyHandled = false;
	let heartbeatTimer: NodeJS.Timeout | undefined;

	const emit = (ev: LiveEvent): void => {
		if (closed) return;
		opts.onEvent(ev);
	};

	const sendHeartbeat = (): void => {
		if (closed) return;
		socket.send(encodePacket(WsOp.Heartbeat, {}));
	};

	socket.on("open", () => {
		if (closed) return;
		emit({ kind: "open" });
		socket.send(
			encodePacket(WsOp.Auth, {
				uid: opts.uid,
				roomid: opts.roomId,
				protover: 3,
				platform: "web",
				type: 2,
				key: opts.token,
				// 空串时省略该键(JSON.stringify 丢 undefined)—— 真机验证过的
				// 降级包形;空串 buvid 可能被服务器当无效指纹而非缺失。
				buvid: opts.buvid || undefined,
			}),
		);
	});

	socket.on("message", (data) => {
		if (closed) return;
		const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBufferLike);
		for (const packet of decodeFrames(bytes)) {
			if (packet.op === WsOp.AuthReply) {
				// 一条连接只认首个认证回执:重复回执会叠心跳定时器(旧句柄被
				// 覆盖后无人清理,close() 只清最新的)。
				if (authReplyHandled) continue;
				authReplyHandled = true;
				const code = (packet.body as { code?: unknown } | null)?.code;
				if (code === 0) {
					emit({ kind: "auth-ok" });
					sendHeartbeat();
					heartbeatTimer = setInterval(
						sendHeartbeat,
						opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS,
					);
				} else {
					// 协议成功形态恒为 {"code":0};缺 code 字段按失败处理(-1 哨兵),
					// 当成功会把认证失败伪装成 auth-ok,上层要等 watchdog 才自愈。
					emit({ kind: "auth-failed", code: typeof code === "number" ? code : -1 });
				}
				continue;
			}
			if (packet.op === WsOp.HeartbeatReply) {
				emit({ kind: "heartbeat", popularity: packet.body as number });
				continue;
			}
			if (packet.op === WsOp.Message) {
				emit(parseCommand(packet.body));
			}
		}
	});

	socket.on("error", (err) => {
		emit({ kind: "error", error: err instanceof Error ? err : new Error(String(err)) });
	});

	socket.on("close", (code) => {
		if (closed) return;
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		heartbeatTimer = undefined;
		emit({ kind: "closed", code: typeof code === "number" ? code : undefined });
	});

	return {
		get closed() {
			return closed;
		},
		close() {
			if (closed) return;
			closed = true;
			if (heartbeatTimer) clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
			socket.close();
		},
	};
}
