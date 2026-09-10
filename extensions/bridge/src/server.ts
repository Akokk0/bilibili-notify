/**
 * WS 端点 —— 桥连进来的那条长连接的**传输层**。挂在宿主分配的挂载点根上;
 * **这一层不知道那是哪儿**(决策 12),它收到的 `path` 已经剥掉前缀了。
 *
 * 只管「连上、认得出是谁、握好手、活着、断得明白、一条 socket 上多条请求各认各的回执」。
 * 桥后面挂着哪些平台、怎么把一条推送译成对面听得懂的东西,是 `./adapter.ts` 的事;
 * 这里一个平台名都不认识。
 *
 * 协议规范在 `../PROTOCOL.md`,wire 形状在 `./contract.js`。
 * 每一条行为背后都有一句协议承诺,改之前先看那份文档:
 *
 * - **鉴权在 upgrade**(`Authorization: Bearer`)—— token 不对连 WS 都不开,token 也不进
 *   反代的访问日志。顺带一个副作用:浏览器的 `new WebSocket()` 设不了请求头,所以网页
 *   永远过不了这道门,这条 wire 不需要 Origin 白名单。
 * - **握手超时**:连上但迟迟不发 `hello` 的空连接不给占位子。
 * - **不认识的帧忽略、认识但畸形的帧断连 4003** —— 前者是让协议能单边演进的唯一出路。
 * - **同 token 二次连接新的赢**,而且是在**新的握完手之后**才踢老的:版本不对的重连
 *   不该干掉正在用的那条。
 * - **桥断线 → 在飞的推送立刻失败**,不排队不补推:推一条三小时前的「正在直播」比不推更糟。
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type {
	Disposable,
	ExtensionUpgrade,
	ExtensionUpgradeHandler,
	Logger,
} from "@bilibili-notify/extension";
import { type RawData, WebSocket, WebSocketServer } from "ws";
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
	type BridgeSendFrame,
	type ServerToBridgeFrame,
} from "./contract.js";
import {
	isBridgeProtocolCompatible,
	normalizeBridgeBotIcon,
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

/**
 * 一条 `send` 等回执等多久。桥那边要下载图再交给平台,给得宽一点;但**必须有上限** ——
 * 推送有时效,吊着不如早点告诉用户失败。
 */
export const DEFAULT_BRIDGE_SEND_TIMEOUT_MS = 30_000;

export interface BridgeServerOptions {
	logger: Logger;
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
	sendTimeoutMs?: number;
	/**
	 * 现在收不收这条接入。**现读** —— 折的是两个开关:桥接模块的总开关(`globals.extensions`)
	 * 与这条接入自己的 `enabled`。
	 *
	 * 与 {@link BridgeServerOptions.resolveToken} 分成两问是因为**答案不一样**:token 不认识
	 * 回 401(配置错了,别重连),认识但眼下不收回 **503**(暂时的,退避重连)。合成一问的话
	 * 用户在面板上把接入停用一下,插件那头看到的是「token 不对」,而它其实好好的。
	 */
	accepts?(connectionId: string): boolean;
	/** bot 名单来了(握手那份也算)。名单是**全量快照**,整份换掉。 */
	onBots?(connectionId: string, bots: readonly BridgeBot[]): void;
	/**
	 * 收到一条入站消息。帧原样交出去 —— 归一成 BN 内部形状是下一层的事。
	 *
	 * 给的是**整个会话**而不是一个 id:归一化要拿 bot 名单查 `selfId`(「机器人自己贴的
	 * 链接不解析」那道闸),下一层再回头 `getSession` 一次的话,查不到时只能静默丢一条
	 * 消息 —— 而这里查得到是**确定**的(下面那道 hello 闸保证了握过手)。
	 */
	onInbound?(session: BridgeSession, frame: BridgeInboundFrame): void;
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
	/**
	 * **这条桥自己连进来时用的地址**,形如 `http://192.168.1.5:8787`。
	 *
	 * 取图 URL 拿它拼。协议里那句「这条 URL 只保证桥自己可达」于是不再靠谁记得配对:
	 * 地址就是桥刚刚成功连到的那个,可达是结构上成立的。BN 自己**不知道**别人从哪个
	 * 地址找得到它(NAS / 反代 / 桌面壳各不相同),猜一个只会猜错。
	 */
	readonly origin: string;
	/**
	 * 桥**自己**在哪台机器上 —— 面板上那句「来自 192.168.1.5」。
	 *
	 * 与 `origin` 是两个方向:那个是桥连到了**我们的**哪个地址,这个是它从哪儿来。
	 * 反代后面看 `X-Forwarded-For` 的第一跳;直连就是 socket 对端。拿不到就没有。
	 */
	readonly remoteAddress?: string;
}

/** `id` 由这一层生成并配对,所以调用方给不了也不用给。 */
export type BridgeSendRequest = Omit<BridgeSendFrame, "type" | "id">;

/** 一次投递的结果。**永远不抛** —— 上面那层要的是投递结果,不是异常。 */
export interface BridgeSendOutcome {
	ok: boolean;
	err?: string;
}

export interface BridgeServer extends Disposable {
	/**
	 * 认领一条 `/ext/<id>` 底下的 WS upgrade —— 交给 `ctx.onUpgrade()`。
	 *
	 * 宿主只回答「这条 upgrade 归谁」;握手、401/503、帧上限、心跳全在这一层
	 * (ADR-0012 决策 26:**401 与 503 的区分是桥协议的语义**,翻译成宿主的枚举之后,
	 * 协议每加一档都要动核心发一版 —— 而拓展化整件事就是为了不这样)。
	 */
	upgrade: ExtensionUpgradeHandler;
	/** 已握手的会话数。没握完手的不算。 */
	readonly sessionCount: number;
	getSession(connectionId: string): BridgeSession | undefined;
	/** 当前所有已握手的会话。配置对账(接入被删 / 被停用 / token 换了)要从这一头看起。 */
	listSessions(): BridgeSession[];
	/**
	 * 发一条消息,等桥的回执。请求 ↔ 回执的配对是**传输层**的事(一条 socket 上多条
	 * 在飞),不是 adapter 的 —— adapter 只负责把 payload 译成 {@link BridgeSendRequest}。
	 */
	send(connectionId: string, request: BridgeSendRequest): Promise<BridgeSendOutcome>;
	/** 吊销 token / 删接入 / 关模块 —— 按给的 close code 把那条桥踢下线。 */
	disconnect(connectionId: string, code: BridgeCloseCode): void;
}

interface BridgeConn {
	socket: WebSocket;
	connectionId: string;
	/** 见 {@link BridgeSession.origin}。upgrade 那一刻从请求上算出来,之后不变。 */
	origin: string;
	/** 见 {@link BridgeSession.remoteAddress}。同样只在 upgrade 那一刻取一次。 */
	remoteAddress?: string;
	connectedAt: number;
	lastSeenAt: number;
	handshakeTimer?: NodeJS.Timeout;
	/**
	 * 桥在 `hello` 里自报的那些。**没握手时是 undefined** —— 「握没握手」与「桥自报了
	 * 什么」是同一件事,别拆成两格,拆了迟早出现一个「握了手但没有 kind」的态。
	 */
	hello?: { kind: BridgeKind; name?: string; version?: string };
	bots: BridgeBot[];
	/** 这条 socket 上还没回执的 `send`。断线时全部就地失败。 */
	pending: Map<string, PendingSend>;
}

interface PendingSend {
	settle(outcome: BridgeSendOutcome): void;
	timer: NodeJS.Timeout;
}

function toBot(wire: BridgeBotWire): BridgeBot {
	return {
		botId: wire.botId,
		platform: wire.platform,
		name: wire.name,
		selfId: wire.selfId,
		icon: normalizeBridgeBotIcon(wire.icon),
		capabilities: normalizeBridgeCapabilities(wire.capabilities),
	};
}

function readBearerToken(req: IncomingMessage): string | null {
	const header = req.headers.authorization;
	if (typeof header !== "string") return null;
	const prefix = "bearer ";
	if (header.slice(0, prefix.length).toLowerCase() !== prefix) return null;
	const token = header.slice(prefix.length).trim();
	return token.length > 0 ? token : null;
}

/**
 * 这条桥**是从哪个地址连到我们的** —— 取图 URL 就拿它拼。
 *
 * BN 自己不知道别人从哪儿找得到它:NAS、反代、桌面壳、Docker 端口映射各不相同,猜一个
 * 只会猜错,而猜错的症状是「群里那条消息没有图」且**一声不吭**(平台去拉图失败是静默的)。
 * `Host` 头是桥刚刚成功连上时用的那个地址,所以它是唯一一个**已被证实可达**的答案。
 *
 * 协议(RFC 6455 / HTTP/1.1)要求握手带 `Host`;真缺了就退到这条 socket 自己的本地地址,
 * 总比给一条拼不出来的 URL 强。反代后面看 `X-Forwarded-Proto` 决定 http 还是 https。
 */
export function bridgeOrigin(req: IncomingMessage): string {
	const forwarded = req.headers["x-forwarded-proto"];
	const declared = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
	const encrypted = "encrypted" in req.socket && req.socket.encrypted === true;
	const scheme = declared || (encrypted ? "https" : "http");
	return `${scheme}://${req.headers.host ?? localAuthority(req)}`;
}

/**
 * 桥从哪台机器连进来的。反代会把真实来源放在 `X-Forwarded-For` 的第一跳,直连就看 socket
 * 对端;IPv4 走在 IPv6 栈上时 Node 报的是 `::ffff:192.168.1.5`,那层壳对人没有意义,剥掉。
 */
export function bridgeRemoteAddress(req: IncomingMessage): string | undefined {
	const forwarded = req.headers["x-forwarded-for"];
	const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
	const raw = first || req.socket.remoteAddress;
	if (!raw) return undefined;
	return raw.startsWith("::ffff:") ? raw.slice("::ffff:".length) : raw;
}

/** `Host` 缺席时的兜底:这条 socket 落在本机哪个地址、哪个端口上。IPv6 要加方括号。 */
function localAuthority(req: IncomingMessage): string {
	const address = req.socket.localAddress ?? "127.0.0.1";
	const host = address.includes(":") ? `[${address}]` : address;
	return `${host}:${req.socket.localPort ?? 80}`;
}

export function createBridgeServer(opts: BridgeServerOptions): BridgeServer {
	const log = opts.logger;
	const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? BRIDGE_HANDSHAKE_TIMEOUT_MS;
	const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_BRIDGE_HEARTBEAT_INTERVAL_MS;
	const heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? DEFAULT_BRIDGE_HEARTBEAT_TIMEOUT_MS;
	const sendTimeoutMs = opts.sendTimeoutMs ?? DEFAULT_BRIDGE_SEND_TIMEOUT_MS;

	const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BRIDGE_FRAME_BYTES });
	/** 所有还连着的 socket,含没握完手的。 */
	const conns = new Set<BridgeConn>();
	/** 连接 id → **当前**那条已握手的会话。一条接入同时只有一个。 */
	const sessions = new Map<string, BridgeConn>();

	// ---------------- 收发 -----------------------------------------------------

	/** 回「送出去了没有」—— `send` 要拿它决定「立刻失败」还是「等回执」。 */
	function sendFrame(conn: BridgeConn, frame: ServerToBridgeFrame): boolean {
		if (conn.socket.readyState !== WebSocket.OPEN) return false;
		try {
			conn.socket.send(JSON.stringify(frame));
			return true;
		} catch (err) {
			log.warn(`bridge ${conn.connectionId} send failed: ${String(err)}`);
			return false;
		}
	}

	/**
	 * 桥断了 → 在飞的**立刻失败**,不排队不补推。协议里写死的:推送有时效,补推一条
	 * 三小时前的「正在直播」比不推更糟。
	 */
	function failPending(conn: BridgeConn, err: string): void {
		for (const entry of [...conn.pending.values()]) entry.settle({ ok: false, err });
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
		failPending(conn, "桥断开了");
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
				// 上面那道 hello 闸保证了握过手,所以快照必然在;这个 `if` 只是收窄类型。
				const session = snapshot(conn);
				if (session) opts.onInbound?.(session, frame);
				break;
			}
			case "result": {
				const entry = conn.pending.get(frame.id);
				if (!entry) {
					// 超时之后才回来的,或者桥自己编的 id。**忽略** —— 帧本身是好的,
					// 断连不合适;而已经结算过的那条投递也不该被翻案。
					log.debug(`bridge ${conn.connectionId} sent a result for an unknown id`);
					break;
				}
				entry.settle({ ok: frame.ok, err: frame.err });
				break;
			}
			case "pong":
				break;
		}
	}

	// ---------------- HTTP upgrade ---------------------------------------------

	function reject(
		socket: Duplex,
		status: "401 Unauthorized" | "404 Not Found" | "503 Service Unavailable",
	): void {
		try {
			socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
		} catch {
			// 尽力而为,反正下面要 destroy
		}
		try {
			socket.destroy();
		} catch {
			// 已经没了
		}
	}

	function accept(
		socket: WebSocket,
		connectionId: string,
		origin: string,
		remoteAddress: string | undefined,
	): void {
		const now = Date.now();
		const conn: BridgeConn = {
			socket,
			connectionId,
			origin,
			remoteAddress,
			connectedAt: now,
			lastSeenAt: now,
			bots: [],
			pending: new Map(),
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

	const onUpgrade = ({ req, socket, head, path }: ExtensionUpgrade): void => {
		// 到这儿的一定是 `/ext/bridge` 底下的(宿主已经按前缀分过),但**底下还有别的路**
		// —— 取图口就是 `/blob/<id>`。只有挂载点根那一条是 WS。
		if (path !== "" && path !== "/") {
			reject(socket, "404 Not Found");
			return;
		}
		const token = readBearerToken(req);
		const connectionId = token ? opts.resolveToken(token) : null;
		if (!connectionId) {
			log.warn("bridge upgrade rejected: missing or invalid token");
			reject(socket, "401 Unauthorized");
			return;
		}
		if (opts.accepts && !opts.accepts(connectionId)) {
			// 认得这个 token,只是眼下不收 —— 模块关了 / 这条接入停用了。503 而不是 401:
			// 插件据此退避重连,用户把开关拨回来,它自己就回来了。
			log.info(`bridge upgrade deferred: ${connectionId} is off`);
			reject(socket, "503 Service Unavailable");
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) =>
			accept(ws, connectionId, bridgeOrigin(req), bridgeRemoteAddress(req)),
		);
	};
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
		// upgrade 那一路不用摘 —— 它挂在 ctx 上,`dispose()` 之后宿主根本不会再叫过来。
		// 1001 = Going Away,**两种收摊都是真话**:BN 关机,或者主人把桥拓展的开关关了
		// (热卸载,ADR-0012 决策 10)。桥分不出这两者 —— ctx 只说「收摊」,不说为什么,
		// 而对插件来说该做的事也一样:退避重连。所以别在这儿写「服务器要关了」。
		for (const conn of [...conns]) close(conn, 1001, "bridge going away");
		try {
			wss.close();
		} catch {
			// 已经没了
		}
	};

	function send(connectionId: string, request: BridgeSendRequest): Promise<BridgeSendOutcome> {
		const conn = sessions.get(connectionId);
		if (!conn) return Promise.resolve({ ok: false, err: "桥没连着" });
		const id = randomUUID();
		return new Promise<BridgeSendOutcome>((resolve) => {
			// 只结算一次:超时、回执、断线三路都可能先到,后到的那些看见 pending 里
			// 没有这一格就散了。
			const settle = (outcome: BridgeSendOutcome): void => {
				const entry = conn.pending.get(id);
				if (!entry) return;
				clearTimeout(entry.timer);
				conn.pending.delete(id);
				resolve(outcome);
			};
			const timer = setTimeout(
				() => settle({ ok: false, err: `桥 ${sendTimeoutMs}ms 内没给回执` }),
				sendTimeoutMs,
			);
			conn.pending.set(id, { settle, timer });
			if (!sendFrame(conn, { type: "send", id, ...request })) {
				settle({ ok: false, err: "桥没连着" });
			}
		});
	}

	function snapshot(conn: BridgeConn): BridgeSession | undefined {
		if (!conn.hello) return undefined;
		return {
			connectionId: conn.connectionId,
			kind: conn.hello.kind,
			name: conn.hello.name,
			version: conn.hello.version,
			bots: conn.bots,
			connectedAt: conn.connectedAt,
			origin: conn.origin,
			remoteAddress: conn.remoteAddress,
		};
	}

	return {
		upgrade: onUpgrade,
		dispose,
		send,
		get sessionCount() {
			return sessions.size;
		},
		getSession(connectionId) {
			const conn = sessions.get(connectionId);
			return conn ? snapshot(conn) : undefined;
		},
		listSessions() {
			return [...sessions.values()].flatMap((conn) => snapshot(conn) ?? []);
		},
		disconnect(connectionId, code) {
			const conn = sessions.get(connectionId);
			if (conn) close(conn, code, "closed by the server");
		},
	};
}
