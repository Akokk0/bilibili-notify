/**
 * Reconnecting WS client for /ws. One socket per `connectWs(...)`; channels are
 * remembered across reconnects so hooks don't have to re-subscribe.
 *
 * Server protocol (apps/standalone/server/src/ws/types.ts):
 *   client → server: { type: 'subscribe'|'unsubscribe', channels: ChannelName[] }
 *                    { type: 'ping' | 'pong' }
 *   server → client: { type: ChannelName, event: string, ts, data }
 *                    { type: 'ping'|'pong'|'subscribed'|'unsubscribed'|'error', ... }
 */

export type ChannelName = "auth" | "push-events" | "log" | "state";

export interface WsEnvelope {
	type: string;
	event?: string;
	ts: string;
	data?: unknown;
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

const RECONNECT_DELAY_MS = 2_000;

function defaultUrl(): string {
	return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}

export function connectWs(url = defaultUrl()): WsClient {
	const handlers = new Set<(env: WsEnvelope) => void>();
	const statusHandlers = new Set<(status: WsStatus) => void>();
	const subscribed = new Set<ChannelName>();

	let socket: WebSocket | null = null;
	let status: WsStatus = "connecting";
	let closedByUser = false;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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

	function open(): void {
		setStatus("connecting");
		const s = new WebSocket(url);
		socket = s;

		s.addEventListener("open", () => {
			setStatus("open");
			if (subscribed.size > 0) {
				send({ type: "subscribe", channels: [...subscribed] });
			}
		});

		s.addEventListener("message", (ev) => {
			let env: WsEnvelope;
			try {
				env = JSON.parse(ev.data) as WsEnvelope;
			} catch {
				return;
			}
			if (env.type === "ping") {
				send({ type: "pong" });
				return;
			}
			for (const h of handlers) h(env);
		});

		s.addEventListener("close", () => {
			socket = null;
			setStatus("closed");
			if (!closedByUser) scheduleReconnect();
		});

		s.addEventListener("error", () => {
			// "close" will follow; reconnect is handled there.
		});
	}

	function scheduleReconnect(): void {
		if (reconnectTimer || closedByUser) return;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			if (!closedByUser) open();
		}, RECONNECT_DELAY_MS);
	}

	open();

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
