import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Disposable, MessageBus } from "@bilibili-notify/internal";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import type { WsTicketStore } from "../auth/ws-ticket.js";
import type { ConfigStore } from "../config/store.js";
import type { NodeServiceContext } from "../runtime/service-context.js";
import { attachChannelWiring, buildStateHydrate } from "./channels.js";
import { createLogChannel, type LogChannel } from "./log-channel.js";
import {
	CHANNELS,
	type ChannelName,
	ClientControlSchema,
	DEFAULT_HEARTBEAT_INTERVAL_MS,
	DEFAULT_HEARTBEAT_TIMEOUT_MS,
	MAX_CONTROL_MESSAGE_BYTES,
	SEND_BACKPRESSURE_THRESHOLD_BYTES,
	type ServerEnvelope,
	type ServerEventEnvelope,
} from "./types.js";

/** Public options accepted by `createWsServer`. */
export interface CreateWsServerOptions {
	httpServer: HttpServer;
	bus: MessageBus;
	store: ConfigStore;
	serviceCtx: NodeServiceContext;
	/** Path the upgrade handler matches. Defaults to '/ws'. */
	path?: string;
	/** Server-issued ping interval, ms. Defaults to 30s. Tests may override. */
	heartbeatIntervalMs?: number;
	/** Pong timeout, ms. Defaults to 60s. Tests may override. */
	heartbeatTimeoutMs?: number;
	/** Optional pre-built log channel. We create one if not provided. */
	logChannel?: LogChannel;
	/**
	 * Optional dashboard credentials. When set the WS upgrade handshake requires
	 * either `Authorization: Basic <b64(user:pass)>` OR a `?token=<b64(user:pass)>`
	 * query string fallback (browser WebSocket can't set custom headers).
	 * When unset, no auth check is performed (matches the HTTP layer's behaviour
	 * + bootstrap-layer warn log).
	 */
	basicAuthCredentials?: { username: string; password: string };
	/**
	 * WS upgrade ticket store。前端 WebSocket 不能附带 Authorization 头,改用
	 * `?ticket=<xxx>` 完成 upgrade。`POST /api/auth/ws-ticket` 签发的 ticket
	 * 在这里通过 consume() 验证(一次性、短时)。null = basicAuth 未启用。
	 */
	wsTicketStore?: WsTicketStore | null;
	/**
	 * Origin whitelist. When provided + non-empty, the upgrade request's
	 * `Origin` header must be in the list or the socket is destroyed before the
	 * WS handshake completes. When unset/empty, the gate is disabled.
	 */
	allowedOrigins?: readonly string[];
}

/** Public surface returned by `createWsServer`. */
export interface WsServer extends Disposable {
	/** Number of currently connected clients. Useful in tests. */
	readonly clientCount: number;
	/** Underlying ws.WebSocketServer (for advanced inspection). */
	readonly wss: WebSocketServer;
	/** Direct access to the log channel — bootstrap installs it as serviceCtx.onLog. */
	readonly logChannel: LogChannel;
}

interface WsClient {
	socket: WebSocket;
	subscriptions: Set<ChannelName>;
	/** True iff the most recent server ping has been answered. */
	alive: boolean;
	/** True iff we've already logged a backpressure-drop warning for this client. */
	backpressureWarned: boolean;
	id: number;
}

let clientSeq = 0;

/**
 * Spin up the WS layer. Mounts a single endpoint (`/ws` by default) on the
 * provided HTTP server, multiplexes 4 logical channels onto it, and bridges
 * each channel back to its source events on the MessageBus.
 *
 * Bus subscriptions are taken once for the whole process; per-client work is
 * just maintaining a `Set<ChannelName>` and writing envelopes when the client
 * is subscribed.
 */
export function createWsServer(opts: CreateWsServerOptions): WsServer {
	const path = opts.path ?? "/ws";
	const heartbeatInterval = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
	const heartbeatTimeout = opts.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
	const log = opts.serviceCtx.logger;
	const logChannel = opts.logChannel ?? createLogChannel();

	const wss = new WebSocketServer({ noServer: true });
	const clients = new Set<WsClient>();
	// roster[channel] = clients subscribed to that channel — O(1) fan-out.
	const roster: Record<ChannelName, Set<WsClient>> = {
		auth: new Set(),
		"push-events": new Set(),
		log: new Set(),
		state: new Set(),
	};

	// ---------------- HTTP upgrade ---------------------------------------------
	const allowedOrigins = (opts.allowedOrigins ?? []).filter((o) => o.length > 0);
	const originGateEnabled = allowedOrigins.length > 0;
	const creds = opts.basicAuthCredentials;
	// Pre-compute the expected base64(user:pass) once.
	const expectedToken = creds
		? Buffer.from(`${creds.username}:${creds.password}`, "utf8").toString("base64")
		: null;

	const rejectUnauthorized = (socket: Duplex): void => {
		try {
			socket.write(
				"HTTP/1.1 401 Unauthorized\r\n" +
					'WWW-Authenticate: Basic realm="bilibili-notify"\r\n' +
					"Connection: close\r\n" +
					"Content-Length: 0\r\n" +
					"\r\n",
			);
		} catch {
			// best-effort; we destroy regardless.
		}
		try {
			socket.destroy();
		} catch {
			// already gone
		}
	};

	const checkAuth = (req: IncomingMessage): boolean => {
		if (!expectedToken) return true;
		// 1) Authorization: Basic <b64>(curl / 服务端到服务端常用)。
		const header = req.headers.authorization;
		if (header && typeof header === "string") {
			const m = /^Basic\s+(.+)$/i.exec(header.trim());
			if (m && m[1] === expectedToken) return true;
		}
		const url = req.url ?? "";
		const q = url.indexOf("?");
		if (q >= 0) {
			const params = new URLSearchParams(url.slice(q + 1));
			// 2) `?ticket=<xxx>` — 浏览器走这条:`POST /api/auth/ws-ticket` 签发一次性 ticket,
			//    消费后立刻失效。不会让真实凭证落进反代访问日志。
			const ticket = params.get("ticket");
			if (ticket && opts.wsTicketStore?.consume(ticket)) return true;
			// 3) `?token=<b64>` — 历史 fallback,把真实 basic-auth 凭证拼进 URL。**会被反代
			//    日志记下**,不推荐;仅保留给已部署的旧 curl 脚本。前端不应再使用这条。
			const token = params.get("token");
			if (token && token === expectedToken) return true;
		}
		return false;
	};

	const checkOrigin = (req: IncomingMessage): boolean => {
		if (!originGateEnabled) return true;
		const origin = req.headers.origin;
		if (!origin || typeof origin !== "string") return false;
		return allowedOrigins.includes(origin);
	};

	const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
		// We only handle our own path; anything else is rejected so that other
		// modules (or future routes) can claim their own paths via `server.on('upgrade')`.
		const url = req.url ?? "";
		if (!url.startsWith(path)) {
			// Another upgrade handler may want this; do nothing instead of destroying.
			return;
		}
		// Origin gate first — if a request is not from a trusted origin we don't
		// even tell it auth is required, just terminate.
		if (!checkOrigin(req)) {
			log.warn(`ws upgrade rejected: origin=${String(req.headers.origin)} not in allowedOrigins`);
			try {
				socket.destroy();
			} catch {
				// already gone
			}
			return;
		}
		// Auth gate — emit a real 401 so curl/clients see the right code.
		if (!checkAuth(req)) {
			log.warn("ws upgrade rejected: missing or invalid auth");
			rejectUnauthorized(socket);
			return;
		}
		wss.handleUpgrade(req, socket, head, (socket) => {
			wss.emit("connection", socket, req);
		});
	};
	opts.httpServer.on("upgrade", onUpgrade);

	// ---------------- Send helpers ---------------------------------------------
	function sendRaw(client: WsClient, envelope: ServerEnvelope): void {
		if (client.socket.readyState !== WebSocket.OPEN) return;
		// Backpressure: if the kernel send buffer is over threshold, drop and warn once.
		if (client.socket.bufferedAmount > SEND_BACKPRESSURE_THRESHOLD_BYTES) {
			if (!client.backpressureWarned) {
				client.backpressureWarned = true;
				log.warn(
					`ws client ${client.id} buffered>${SEND_BACKPRESSURE_THRESHOLD_BYTES}B, dropping messages`,
				);
			}
			return;
		}
		// Reset the warn flag when buffer drains below threshold.
		if (client.backpressureWarned && client.socket.bufferedAmount === 0) {
			client.backpressureWarned = false;
		}
		try {
			client.socket.send(JSON.stringify(envelope));
		} catch (err) {
			log.warn(`ws client ${client.id} send failed: ${String(err)}`);
		}
	}

	function broadcast(envelope: ServerEventEnvelope): void {
		const channelClients = roster[envelope.type];
		if (!channelClients || channelClients.size === 0) return;
		// Snapshot to avoid mutation-during-iteration if a send triggers a close.
		for (const c of [...channelClients]) sendRaw(c, envelope);
	}

	// ---------------- Channel wiring (single bus subscription set) -------------
	const wiring = attachChannelWiring({
		bus: opts.bus,
		store: opts.store,
		log: logChannel,
		publish: broadcast,
	});

	// ---------------- Heartbeat ------------------------------------------------
	let heartbeatHandle: NodeJS.Timeout | undefined;
	const heartbeat = (): void => {
		const now = Date.now();
		for (const client of [...clients]) {
			if (!client.alive) {
				log.warn(`ws client ${client.id} timed out (no pong); terminating`);
				try {
					client.socket.terminate();
				} catch {
					// already gone
				}
				continue;
			}
			client.alive = false;
			sendRaw(client, { type: "ping", ts: new Date(now).toISOString() });
		}
	};
	if (heartbeatInterval > 0) {
		heartbeatHandle = setInterval(heartbeat, heartbeatInterval);
		// Also stash a hard timeout: a client whose pong never lands by
		// `heartbeatTimeout` ms after a ping is terminated. We use the heartbeat
		// loop itself for this — `client.alive` is reset on pong; flipped to
		// false by ping; if still false at the next tick, we kill it. The user
		// can tune intervals for their environment.
		// Choose loop frequency to honour the timeout precisely.
	}
	// In addition, set a slow watchdog at the timeout cadence to handle the case
	// where the heartbeatInterval is much larger than the timeout (we still want
	// to evict stale clients within the timeout window after issuing a ping).
	let watchdogHandle: NodeJS.Timeout | undefined;
	if (heartbeatTimeout > 0) {
		watchdogHandle = setInterval(
			() => {
				const cutoff = Date.now() - heartbeatTimeout;
				for (const client of [...clients]) {
					// `lastPongAt` is updated on every pong/control msg; if absent (never replied)
					// we use connection time.
					const last = (client as WsClient & { lastPongAt?: number }).lastPongAt ?? 0;
					if (last > 0 && last < cutoff) {
						log.warn(`ws client ${client.id} pong overdue; terminating`);
						try {
							client.socket.terminate();
						} catch {
							// already gone
						}
					}
				}
			},
			Math.max(50, Math.floor(heartbeatTimeout / 2)),
		);
	}

	// ---------------- Connection handler ---------------------------------------
	wss.on("connection", (socket: WebSocket) => {
		const client: WsClient & { lastPongAt: number } = {
			socket,
			subscriptions: new Set<ChannelName>(),
			alive: true,
			backpressureWarned: false,
			id: ++clientSeq,
			lastPongAt: Date.now(),
		};
		clients.add(client);
		log.debug(`ws client ${client.id} connected (total=${clients.size})`);

		const cleanup = (): void => {
			if (!clients.delete(client)) return;
			for (const ch of client.subscriptions) roster[ch].delete(client);
			client.subscriptions.clear();
			log.debug(`ws client ${client.id} disconnected (total=${clients.size})`);
		};

		socket.on("close", cleanup);
		socket.on("error", (err) => {
			log.warn(`ws client ${client.id} socket error: ${String(err)}`);
			cleanup();
		});

		socket.on("message", (raw: RawData) => {
			// Reject oversized control messages with close 1009.
			const size = byteLength(raw);
			if (size > MAX_CONTROL_MESSAGE_BYTES) {
				try {
					socket.close(1009, "control message too large");
				} catch {
					// ignore
				}
				return;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw.toString("utf8"));
			} catch (_err) {
				sendRaw(client, {
					type: "error",
					message: "invalid_json",
					ts: new Date().toISOString(),
				});
				return;
			}
			const result = ClientControlSchema.safeParse(parsed);
			if (!result.success) {
				sendRaw(client, {
					type: "error",
					message: "invalid_control_message",
					issues: result.error.issues,
					ts: new Date().toISOString(),
				});
				return;
			}
			handleControl(client, result.data);
		});
	});

	function handleControl(
		client: WsClient & { lastPongAt: number },
		msg: import("./types.js").ClientControl,
	): void {
		// Any control frame counts as liveness — refresh tracking.
		client.alive = true;
		client.lastPongAt = Date.now();

		switch (msg.type) {
			case "subscribe": {
				const added: ChannelName[] = [];
				for (const ch of msg.channels) {
					if (!client.subscriptions.has(ch)) {
						client.subscriptions.add(ch);
						roster[ch].add(client);
						added.push(ch);
					}
				}
				sendRaw(client, {
					type: "subscribed",
					channels: [...client.subscriptions],
					ts: new Date().toISOString(),
				});
				// Hydrate `state` immediately so the dashboard can render.
				if (added.includes("state")) {
					sendRaw(client, buildStateHydrate(opts.store));
				}
				break;
			}
			case "unsubscribe": {
				for (const ch of msg.channels) {
					if (client.subscriptions.delete(ch)) roster[ch].delete(client);
				}
				sendRaw(client, {
					type: "unsubscribed",
					channels: msg.channels,
					ts: new Date().toISOString(),
				});
				break;
			}
			case "ping": {
				sendRaw(client, { type: "pong", ts: new Date().toISOString() });
				break;
			}
			case "pong": {
				// Heartbeat ack — already updated `alive` and `lastPongAt` above.
				break;
			}
		}
	}

	// ---------------- Disposal -------------------------------------------------
	const dispose = (): void => {
		if (heartbeatHandle) clearInterval(heartbeatHandle);
		if (watchdogHandle) clearInterval(watchdogHandle);
		opts.httpServer.off("upgrade", onUpgrade);
		wiring.dispose();
		for (const client of [...clients]) {
			try {
				client.socket.close(1001, "server shutting down");
			} catch {
				// ignore
			}
		}
		clients.clear();
		for (const k of CHANNELS) roster[k].clear();
		try {
			wss.close();
		} catch {
			// ignore
		}
	};

	return {
		dispose,
		get clientCount() {
			return clients.size;
		},
		wss,
		logChannel,
	};
}

function byteLength(raw: RawData): number {
	if (Buffer.isBuffer(raw)) return raw.byteLength;
	if (raw instanceof ArrayBuffer) return raw.byteLength;
	if (Array.isArray(raw)) return raw.reduce((acc, b) => acc + b.byteLength, 0);
	return 0;
}
