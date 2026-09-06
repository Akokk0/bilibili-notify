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
	/**
	 * 从建连到 auth-ok 的整段限时,缺省 15s。TCP 半开/认证无回执时 ws 层可能
	 * 永远没有事件 —— 超时 emit error 并关 socket,让上游重连梯子立即接手,
	 * 而不是等分钟级的活动 watchdog。
	 */
	connectTimeoutMs?: number;
}

export interface LiveClient {
	/**
	 * 这条连接是不是已经结束了 —— **哪一侧关的都算**:自己调 `close()`,或者对面 / 网络
	 * 把它断了(socket 的 `close` 事件)。只认「自己关的」会骗人:调用方拿它当「还通不通」
	 * 用,而对面断开恰恰是最常见的那种断。
	 */
	readonly closed: boolean;
	close(): void;
}

/**
 * 连接观察钩子 —— **devtools 用**,别的地方别碰。
 *
 * 每建一条连接就报一声,带着这条连接的 `onEvent`:拿到它就能往那个房间的事件漏斗里塞
 * 事件,走的是与真帧完全相同的那条回调,上游引擎一行不动、也分不出真假。全局只有一个
 * 观察者(devtools 是进程里唯一的宿主),不装就什么都不发生。
 */
export interface LiveConnectionInfo {
	roomId: number;
	onEvent: (ev: LiveEvent) => void;
	client: LiveClient;
}

export type LiveConnectionObserver = (info: LiveConnectionInfo) => void;

let connectionObserver: LiveConnectionObserver | null = null;

export function observeLiveConnections(observer: LiveConnectionObserver | null): void {
	connectionObserver = observer;
}

const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

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

	// 建连→auth-ok 整段限时。解除时机:auth-ok / 连接已终结(close 事件或主动
	// close())—— 终结后再报超时就是对着尸体补刀。
	const timeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
	let connectTimer: NodeJS.Timeout | undefined = setTimeout(() => {
		connectTimer = undefined;
		emit({
			kind: "error",
			error: new Error(`连接/认证超时(${Math.round(timeoutMs / 1000)}s 内未收到认证回执)`),
		});
		socket.close();
	}, timeoutMs);
	const clearConnectTimer = (): void => {
		if (connectTimer) clearTimeout(connectTimer);
		connectTimer = undefined;
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
					clearConnectTimer();
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

	socket.on("close", (code, reasonRaw) => {
		if (closed) return;
		clearConnectTimer();
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		heartbeatTimer = undefined;
		// ws 的 close 回调第二参是 Buffer;排障时服务器给的关闭理由值得透传。
		const reason = reasonRaw == null ? "" : String(reasonRaw);
		emit({
			kind: "closed",
			code: typeof code === "number" ? code : undefined,
			...(reason ? { reason } : {}),
		});
		// 摆在 emit **之后**:emit 自己会看这个旗子,先立就把上面这条 closed 吞了。
		closed = true;
	});

	const client: LiveClient = {
		get closed() {
			return closed;
		},
		close() {
			if (closed) return;
			closed = true;
			clearConnectTimer();
			if (heartbeatTimer) clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
			socket.close();
		},
	};
	// 交出去的是 `emit` 而不是裸 `opts.onEvent`:连接关了之后塞进来的事件同样该被丢掉。
	// 包在 try 里:这时 socket 已经建好、handler 也挂上了,观察者抛出去就等于 `client`
	// 交不出来 —— 没人再能 close 它,连接连同心跳一起变成孤儿。
	try {
		connectionObserver?.({ roomId: opts.roomId, onEvent: emit, client });
	} catch {
		// 观察者只有 devtools 一个,它出事不该带走一条真连接。
	}
	return client;
}
