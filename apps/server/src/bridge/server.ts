/**
 * `/bridge` 端点 —— 桥连进来的那条长连接的**传输层**。
 *
 * 只管「连上、认得出是谁、握好手、活着、断得明白」。桥后面挂着哪些平台、怎么把一条推送
 * 译成对面听得懂的东西,是 `platforms/bridge.ts` 的事;这里一个平台名都不认识。
 *
 * 协议规范在 `docs/protocol/bridge.md`,wire 形状在 `@bilibili-notify/contract`。
 * 每一条行为背后都有一句协议承诺,改之前先看那份文档:
 *
 * - **鉴权在 upgrade**(`Authorization: Bearer`)—— token 不对连 WS 都不开,token 也不进
 *   反代的访问日志。顺带一个副作用:浏览器的 `new WebSocket()` 设不了请求头,所以网页
 *   永远过不了这道门,这条 wire 不需要 Origin 白名单。
 * - **握手超时**:连上但迟迟不发 `hello` 的空连接不给占位子。
 * - **不认识的帧忽略、认识但畸形的帧断连 4003** —— 前者是让协议能单边演进的唯一出路。
 * - **同 token 二次连接新的赢**,而且是在**新的握完手之后**才踢老的:版本不对的重连
 *   不该干掉正在用的那条。
 */

import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
	BRIDGE_CLOSE_CODES,
	BRIDGE_HANDSHAKE_TIMEOUT_MS,
	BRIDGE_PROTOCOL_VERSION,
	type BridgeBot,
	type BridgeBotWire,
	type BridgeCloseCode,
	type BridgeHelloFrame,
	type BridgeInboundFrame,
	type BridgeInboundSubscription,
	type BridgeKind,
	type ServerToBridgeFrame,
} from "@bilibili-notify/contract";
import type { Disposable } from "@bilibili-notify/internal";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import type { NodeServiceContext } from "../runtime/service-context.js";
import {
	isBridgeProtocolCompatible,
	normalizeBridgeCapabilities,
	parseBridgeFrame,
} from "./protocol.js";

/** 服务端多久催桥说一次话。ping 本身不是判据,见 {@link DEFAULT_BRIDGE_HEARTBEAT_TIMEOUT_MS}。 */
export const DEFAULT_BRIDGE_HEARTBEAT_INTERVAL_MS = 30_000;

/** 多久没听见任何动静就踢掉。判据是「最近说过话」,不是「回过 pong」—— 桥推 bot 名单、
 * 回执、入站消息一样算活着,没必要非等一个 pong。 */
export const DEFAULT_BRIDGE_HEARTBEAT_TIMEOUT_MS = 90_000;

/** 单帧上限。对面是不受信的第三方插件,`ws` 超限自己会关 1009。 */
export const MAX_BRIDGE_FRAME_BYTES = 1024 * 1024;

export interface BridgeServerOptions {
	httpServer: HttpServer;
	serviceCtx: NodeServiceContext;
	/** 默认 `/bridge`。 */
	path?: string;
	/**
	 * token → 这是哪条桥接入(连接 id)。认不出回 `null` → upgrade 401。
	 *
	 * ⚠️ 实现方**要用定长时间比较**(`timingSafeEqual`),别拿 `===` 去撸一遍连接表 ——
	 * 这是个对外开着的口,比较耗时会漏 token 前缀。
	 */
	resolveToken(token: string): string | null;
	/** 报给桥的独立端版本。 */
	serverVersion: string;
	/** 下发给桥的入站订阅。每次握手现取 —— 它跟着 BN 的配置走。 */
	inbound(): BridgeInboundSubscription;
	handshakeTimeoutMs?: number;
	heartbeatIntervalMs?: number;
	heartbeatTimeoutMs?: number;
	/** bot 名单来了(握手那份也算)。名单是**全量快照**,整份换掉。 */
	onBots?(connectionId: string, bots: readonly BridgeBot[]): void;
	/** 收到一条入站消息。归一成 BN 内部形状是下一层的事,这里原样交出去。 */
	onInbound?(connectionId: string, frame: BridgeInboundFrame): void;
	/** 会话建立 / 消失。面板的在线状态与推送的可达性都看它。 */
	onSessionChange?(connectionId: string, connected: boolean): void;
}

/** 一条**已握手**的桥会话的只读快照。 */
export interface BridgeSession {
	readonly connectionId: string;
	readonly kind: BridgeKind;
	readonly name?: string;
	readonly version?: string;
	readonly bots: readonly BridgeBot[];
	readonly connectedAt: number;
}

export interface BridgeServer extends Disposable {
	/** 已握手的会话数。没握完手的不算。 */
	readonly sessionCount: number;
	getSession(connectionId: string): BridgeSession | undefined;
	/** 吊销 token / 删接入 / 关模块 —— 按给的 close code 把那条桥踢下线。 */
	disconnect(connectionId: string, code: BridgeCloseCode): void;
}

interface BridgeConn {
	socket: WebSocket;
	connectionId: string;
	connectedAt: number;
	lastSeenAt: number;
	handshakeTimer?: NodeJS.Timeout;
	/**
	 * 桥在 `hello` 里自报的那些。**没握手时是 undefined** —— 「握没握手」与「桥自报了
	 * 什么」是同一件事,别拆成两格,拆了迟早出现一个「握了手但没有 kind」的态。
	 */
	hello?: { kind: BridgeKind; name?: string; version?: string };
	bots: BridgeBot[];
}

function toBot(wire: BridgeBotWire): BridgeBot {
	return {
		botId: wire.botId,
		platform: wire.platform,
		name: wire.name,
		selfId: wire.selfId,
		capabilities: normalizeBridgeCapabilities(wire.capabilities),
	};
}

/** `/bridge` 与 `/bridge?x=1` 算,`/bridge/blob/…`(HTTP 取图口)与 `/bridgefoo` 不算。 */
function matchesPath(url: string, path: string): boolean {
	return url === path || url.startsWith(`${path}?`);
}

function readBearerToken(req: IncomingMessage): string | null {
	const header = req.headers.authorization;
	if (typeof header !== "string") return null;
	const prefix = "bearer ";
	if (header.slice(0, prefix.length).toLowerCase() !== prefix) return null;
	const token = header.slice(prefix.length).trim();
	return token.length > 0 ? token : null;
}

export function createBridgeServer(opts: BridgeServerOptions): BridgeServer {
	const path = opts.path ?? "/bridge";
	const log = opts.serviceCtx.logger;
	const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? BRIDGE_HANDSHAKE_TIMEOUT_MS;
	const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_BRIDGE_HEARTBEAT_INTERVAL_MS;
	const heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? DEFAULT_BRIDGE_HEARTBEAT_TIMEOUT_MS;

	const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BRIDGE_FRAME_BYTES });
	/** 所有还连着的 socket,含没握完手的。 */
	const conns = new Set<BridgeConn>();
	/** 连接 id → **当前**那条已握手的会话。一条接入同时只有一个。 */
	const sessions = new Map<string, BridgeConn>();

	// ---------------- 收发 -----------------------------------------------------

	function sendFrame(conn: BridgeConn, frame: ServerToBridgeFrame): void {
		if (conn.socket.readyState !== WebSocket.OPEN) return;
		try {
			conn.socket.send(JSON.stringify(frame));
		} catch (err) {
			log.warn(`bridge ${conn.connectionId} send failed: ${String(err)}`);
		}
	}

	/**
	 * 从两张表里摘掉。**幂等**,而且**认身份不认 id**。
	 *
	 * 今天 {@link close} 是同步摘的,所以「新的赢」那条路上轮不到这道判断。它挡的是把
	 * `sessions.set(新的)` 挪到 `close(老的)` 之前 —— 那时老连接晚到的 close 事件会拿
	 * 同一个 id 把刚建好的会话删掉,而且面板上看是「连上了又莫名其妙掉了」。
	 */
	function drop(conn: BridgeConn): void {
		if (!conns.delete(conn)) return;
		if (conn.handshakeTimer) {
			clearTimeout(conn.handshakeTimer);
			conn.handshakeTimer = undefined;
		}
		if (sessions.get(conn.connectionId) === conn) {
			sessions.delete(conn.connectionId);
			opts.onSessionChange?.(conn.connectionId, false);
		}
	}

	function close(conn: BridgeConn, code: number, reason: string): void {
		try {
			conn.socket.close(code, reason);
		} catch {
			// 已经没了
		}
		// close 事件是异步的,这中间它不该再被当成活着的会话。
		drop(conn);
	}

	function terminate(conn: BridgeConn, why: string): void {
		log.warn(`bridge ${conn.connectionId} ${why}; terminating`);
		try {
			conn.socket.terminate();
		} catch {
			// 已经没了
		}
		drop(conn);
	}

	// ---------------- 握手 -----------------------------------------------------

	function onHello(conn: BridgeConn, frame: BridgeHelloFrame): void {
		if (conn.hello) {
			log.warn(`bridge ${conn.connectionId} sent a second hello`);
			close(conn, BRIDGE_CLOSE_CODES.badFrame, "hello is the first frame, and only once");
			return;
		}
		if (!isBridgeProtocolCompatible(frame.protocol)) {
			log.warn(
				`bridge ${conn.connectionId} speaks protocol v${frame.protocol.major}.${frame.protocol.minor}, ` +
					`we speak v${BRIDGE_PROTOCOL_VERSION.major}.${BRIDGE_PROTOCOL_VERSION.minor}`,
			);
			close(conn, BRIDGE_CLOSE_CODES.incompatibleProtocol, "incompatible protocol major");
			return;
		}
		if (conn.handshakeTimer) {
			clearTimeout(conn.handshakeTimer);
			conn.handshakeTimer = undefined;
		}
		conn.hello = {
			kind: frame.bridge.kind,
			name: frame.bridge.name,
			version: frame.bridge.version,
		};
		conn.bots = frame.bots.map(toBot);

		// 新的赢 —— 但只在这里(握手已成)才踢老的。放在 upgrade 那步的话,一个版本
		// 对不上的重连就能把正在用的会话打下线。
		const previous = sessions.get(conn.connectionId);
		if (previous && previous !== conn) {
			log.info(`bridge ${conn.connectionId} replaced by a newer connection`);
			close(previous, BRIDGE_CLOSE_CODES.replaced, "replaced by a newer connection");
		}
		sessions.set(conn.connectionId, conn);

		sendFrame(conn, {
			type: "welcome",
			protocol: { ...BRIDGE_PROTOCOL_VERSION },
			server: { version: opts.serverVersion },
			inbound: opts.inbound(),
		});
		log.info(
			`bridge ${conn.connectionId} connected (${conn.hello.kind}, ${conn.bots.length} bot(s))`,
		);
		opts.onSessionChange?.(conn.connectionId, true);
		opts.onBots?.(conn.connectionId, conn.bots);
	}

	// ---------------- 收帧 -----------------------------------------------------

	function onMessage(conn: BridgeConn, raw: RawData): void {
		conn.lastSeenAt = Date.now();
		let payload: unknown;
		try {
			payload = JSON.parse(raw.toString("utf8"));
		} catch {
			close(conn, BRIDGE_CLOSE_CODES.badFrame, "invalid json");
			return;
		}
		const parsed = parseBridgeFrame(payload);
		if (!parsed.ok) {
			if (parsed.reason === "unknown-type") {
				// 桥比我们新。忽略是协议写死的 —— 断在这里等于每次插件加一种帧就打死老 BN。
				log.debug(`bridge ${conn.connectionId} sent unknown frame "${parsed.type}"; ignoring`);
				return;
			}
			log.warn(`bridge ${conn.connectionId} sent a malformed frame: ${parsed.message}`);
			close(conn, BRIDGE_CLOSE_CODES.badFrame, "malformed frame");
			return;
		}
		const frame = parsed.frame;
		if (frame.type === "hello") {
			onHello(conn, frame);
			return;
		}
		if (!conn.hello) {
			log.warn(`bridge ${conn.connectionId} sent "${frame.type}" before hello`);
			close(conn, BRIDGE_CLOSE_CODES.badFrame, "hello must come first");
			return;
		}
		switch (frame.type) {
			case "bots": {
				// 全量快照,整份换掉 —— 增量合并会在丢帧时留下一个永远不消失的幽灵 bot。
				conn.bots = frame.bots.map(toBot);
				opts.onBots?.(conn.connectionId, conn.bots);
				break;
			}
			case "inbound": {
				opts.onInbound?.(conn.connectionId, frame);
				break;
			}
			case "result": {
				// 请求 ↔ 回执的关联在下一片;眼下没人发 `send`,所以也不会有回执。
				break;
			}
			case "pong":
				break;
		}
	}

	// ---------------- HTTP upgrade ---------------------------------------------

	function rejectUnauthorized(socket: Duplex): void {
		try {
			socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
		} catch {
			// 尽力而为,反正下面要 destroy
		}
		try {
			socket.destroy();
		} catch {
			// 已经没了
		}
	}

	function accept(socket: WebSocket, connectionId: string): void {
		const now = Date.now();
		const conn: BridgeConn = {
			socket,
			connectionId,
			connectedAt: now,
			lastSeenAt: now,
			bots: [],
		};
		conns.add(conn);
		if (handshakeTimeoutMs > 0) {
			conn.handshakeTimer = setTimeout(() => {
				log.warn(`bridge ${connectionId} never sent hello`);
				close(conn, BRIDGE_CLOSE_CODES.handshakeTimeout, "handshake timeout");
			}, handshakeTimeoutMs);
		}
		socket.on("message", (raw: RawData) => onMessage(conn, raw));
		socket.on("close", () => drop(conn));
		socket.on("error", (err) => {
			log.warn(`bridge ${connectionId} socket error: ${String(err)}`);
			drop(conn);
		});
	}

	const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
		// 别的路径**什么都不做**(不是 destroy)—— dashboard 那条 `/ws` 也挂在同一个
		// HTTP server 上,得留给它自己的处理器。
		if (!matchesPath(req.url ?? "", path)) return;
		const token = readBearerToken(req);
		const connectionId = token ? opts.resolveToken(token) : null;
		if (!connectionId) {
			log.warn("bridge upgrade rejected: missing or invalid token");
			rejectUnauthorized(socket);
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => accept(ws, connectionId));
	};
	opts.httpServer.on("upgrade", onUpgrade);

	// ---------------- 心跳 -----------------------------------------------------

	let heartbeatHandle: NodeJS.Timeout | undefined;
	if (heartbeatIntervalMs > 0) {
		heartbeatHandle = setInterval(() => {
			for (const conn of [...conns]) {
				if (conn.hello) sendFrame(conn, { type: "ping" });
			}
		}, heartbeatIntervalMs);
	}

	let watchdogHandle: NodeJS.Timeout | undefined;
	if (heartbeatTimeoutMs > 0) {
		watchdogHandle = setInterval(
			() => {
				const cutoff = Date.now() - heartbeatTimeoutMs;
				for (const conn of [...conns]) {
					if (conn.lastSeenAt < cutoff) terminate(conn, "went quiet");
				}
			},
			Math.max(20, Math.floor(heartbeatTimeoutMs / 2)),
		);
	}

	// ---------------- 对外 -----------------------------------------------------

	const dispose = (): void => {
		if (heartbeatHandle) clearInterval(heartbeatHandle);
		if (watchdogHandle) clearInterval(watchdogHandle);
		opts.httpServer.off("upgrade", onUpgrade);
		for (const conn of [...conns]) close(conn, 1001, "server shutting down");
		try {
			wss.close();
		} catch {
			// 已经没了
		}
	};

	return {
		dispose,
		get sessionCount() {
			return sessions.size;
		},
		getSession(connectionId) {
			const conn = sessions.get(connectionId);
			if (!conn?.hello) return undefined;
			return {
				connectionId: conn.connectionId,
				kind: conn.hello.kind,
				name: conn.hello.name,
				version: conn.hello.version,
				bots: conn.bots,
				connectedAt: conn.connectedAt,
			};
		},
		disconnect(connectionId, code) {
			const conn = sessions.get(connectionId);
			if (conn) close(conn, code, "closed by the server");
		},
	};
}
