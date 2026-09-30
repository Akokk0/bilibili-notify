/**
 * Reconnecting WS client for /ws. One socket per `connectWs(...)`; channels are
 * remembered across reconnects so hooks don't have to re-subscribe.
 *
 * Wire 契约(channel 名 / envelope / 事件表 `WsEvents`)见 `@bilibili-notify/contract` 的 ws 部分;
 * 服务端的控制帧校验在 apps/server/src/ws/types.ts。
 */

import {
	CHANNELS,
	type ChannelName,
	type WsControlEnvelope,
	type WsEnvelope,
	type WsEventEnvelope,
} from "@bilibili-notify/contract";
import { withDesktopTokenHeader, withDesktopTokenQuery } from "./desktop-token";

export type { ChannelName, WsEnvelope };

/** 控制帧的 `type`。写成按类型穷举的表:contract 加一种控制帧,这里不补就编译不过。 */
const CONTROL_TYPES: Record<WsControlEnvelope["type"], true> = {
	subscribed: true,
	unsubscribed: true,
	ping: true,
	pong: true,
	error: true,
};
const CHANNEL_NAMES: ReadonlySet<string> = new Set(CHANNELS);

/**
 * 收到的一帧:外形对得上 contract 的 `WsEnvelope` 才交出去,对不上回 `null`(丢掉)。
 *
 * 服务端不一定总发合法帧(版本错开、代理改包),所以这里只核外形 —— 控制帧认 `type`,事件帧认
 * 频道与事件名是字符串。**`data` 不在这里核**:hook 读它的时候照旧按格判空,那一层防御别删。
 */
export function wsEnvelopeOf(raw: unknown): WsEnvelope | null {
	if (typeof raw !== "object" || raw === null) return null;
	const { type, event } = raw as { type?: unknown; event?: unknown };
	if (typeof type !== "string") return null;
	if (Object.hasOwn(CONTROL_TYPES, type)) return raw as WsControlEnvelope;
	if (CHANNEL_NAMES.has(type) && typeof event === "string") return raw as WsEventEnvelope;
	return null;
}

/**
 * 这一帧是不是 `channel` 频道的 `event`;是的话 `data` 按 contract 的事件表(`WsEvents`)定型。
 */
export function isWsEvent<C extends ChannelName, E extends WsEventEnvelope<C>["event"]>(
	env: WsEnvelope,
	channel: C,
	event: E,
): env is WsEnvelope & Extract<WsEventEnvelope<C>, { event: E }> {
	return env.type === channel && "event" in env && env.event === event;
}

export type WsStatus = "connecting" | "open" | "closed";

export interface WsClient {
	subscribe(channels: ChannelName[]): void;
	unsubscribe(channels: ChannelName[]): void;
	on(handler: (env: WsEnvelope) => void): () => void;
	onStatus(handler: (status: WsStatus) => void): () => void;
	status(): WsStatus;
	close(): void;
}

// WS1:指数退避 + equal-jitter + 上限。后端 down / 持续 401 时不再每 2s 风暴
// 重连(还附带每次 fetchWsTicket)。连上即复位。
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

function defaultBaseUrl(): string {
	return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}

/**
 * 拿一次性 ticket 用于 WS 鉴权。后端 basicAuth 未启用时返回 `{ ticket: null }`,
 * 前端拼 URL 时跳过 `?ticket=`。失败时返回 null,让 open() 用裸 URL 尝试 —
 * 服务端会回 401 触发重连退避;不至于卡住。
 */
async function fetchWsTicket(): Promise<string | null> {
	try {
		const res = await fetch("/api/auth/ws-ticket", {
			method: "POST",
			headers: withDesktopTokenHeader(),
			credentials: "include",
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { ticket: string | null };
		return body.ticket ?? null;
	} catch {
		return null;
	}
}

function buildWsUrl(baseUrl: string, ticket: string | null): string {
	const url = new URL(withDesktopTokenQuery(baseUrl));
	if (ticket) url.searchParams.set("ticket", ticket);
	return url.toString();
}

export function connectWs(baseUrl = defaultBaseUrl()): WsClient {
	const handlers = new Set<(env: WsEnvelope) => void>();
	const statusHandlers = new Set<(status: WsStatus) => void>();
	const subscribed = new Set<ChannelName>();

	let socket: WebSocket | null = null;
	let status: WsStatus = "connecting";
	let closedByUser = false;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	// WS2:open() 在 await fetchWsTicket 期间可重入,旧实现会创建第二个
	// WebSocket 并覆盖 socket 引用、泄漏首连(其 close 又排重连 → 雪崩)。
	let connecting = false;
	let reconnectAttempts = 0;

	function nextReconnectDelay(): number {
		const exp = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
		reconnectAttempts++;
		// equal jitter:一半固定 + 一半随机,避免多客户端同步重连雪崩。
		return exp / 2 + Math.random() * (exp / 2);
	}

	function setStatus(next: WsStatus): void {
		if (status === next) return;
		status = next;
		for (const h of statusHandlers) h(next);
	}

	function send(payload: unknown): boolean {
		if (socket && socket.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify(payload));
			return true;
		}
		return false;
	}

	async function open(): Promise<void> {
		// WS2:已有连接在进行 / 已有活跃 socket / 用户已关 → 不重复建连。
		if (closedByUser || connecting) return;
		if (socket && socket.readyState !== WebSocket.CLOSED) return;
		connecting = true;
		setStatus("connecting");
		try {
			const ticket = await fetchWsTicket();
			if (closedByUser) return;
			const url = buildWsUrl(baseUrl, ticket);
			const s = new WebSocket(url);
			socket = s;

			s.addEventListener("open", () => {
				reconnectAttempts = 0; // WS1:连上即复位退避
				setStatus("open");
				if (subscribed.size > 0) {
					send({ type: "subscribe", channels: [...subscribed] });
				}
			});

			s.addEventListener("message", (ev) => {
				let env: WsEnvelope | null;
				try {
					env = wsEnvelopeOf(JSON.parse(ev.data));
				} catch {
					return;
				}
				if (!env) return;
				if (env.type === "ping") {
					send({ type: "pong" });
					return;
				}
				for (const h of handlers) h(env);
			});

			s.addEventListener("close", () => {
				// WS2:仅当前 socket 的 close 才触发重连;被覆盖的陈旧 socket
				// close 不得再排重连(否则雪崩)。
				if (socket !== s) return;
				socket = null;
				setStatus("closed");
				if (!closedByUser) scheduleReconnect();
			});

			s.addEventListener("error", () => {
				// "close" will follow; reconnect is handled there.
			});
		} finally {
			connecting = false;
		}
	}

	function scheduleReconnect(): void {
		if (reconnectTimer || closedByUser) return;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			if (!closedByUser) void open();
		}, nextReconnectDelay());
	}

	void open();

	return {
		subscribe(channels) {
			const added: ChannelName[] = [];
			for (const ch of channels) {
				if (!subscribed.has(ch)) {
					subscribed.add(ch);
					added.push(ch);
				}
			}
			if (added.length > 0) send({ type: "subscribe", channels: added });
		},
		unsubscribe(channels) {
			const removed: ChannelName[] = [];
			for (const ch of channels) {
				if (subscribed.delete(ch)) removed.push(ch);
			}
			if (removed.length > 0) send({ type: "unsubscribe", channels: removed });
		},
		on(handler) {
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
			};
		},
		onStatus(handler) {
			statusHandlers.add(handler);
			handler(status);
			return () => {
				statusHandlers.delete(handler);
			};
		},
		status() {
			return status;
		},
		close() {
			closedByUser = true;
			if (reconnectTimer) {
				clearTimeout(reconnectTimer);
				reconnectTimer = null;
			}
			if (socket) socket.close();
		},
	};
}
