/**
 * Minimal WS client. Connects to /ws on the same origin, exposes
 * subscribe/unsubscribe + an envelope listener. Auto-reconnect is intentionally
 * left to higher-level hooks so they can hydrate state on each reconnect.
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

export interface WsClient {
	subscribe(channels: ChannelName[]): void;
	unsubscribe(channels: ChannelName[]): void;
	on(handler: (env: WsEnvelope) => void): () => void;
	close(): void;
}

export function connectWs(
	url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
): WsClient {
	const socket = new WebSocket(url);
	const handlers = new Set<(env: WsEnvelope) => void>();
	const pendingSubs: ChannelName[] = [];

	socket.addEventListener("open", () => {
		if (pendingSubs.length > 0) {
			socket.send(JSON.stringify({ type: "subscribe", channels: pendingSubs.splice(0) }));
		}
	});

	socket.addEventListener("message", (ev) => {
		let env: WsEnvelope;
		try {
			env = JSON.parse(ev.data) as WsEnvelope;
		} catch {
			return;
		}
		for (const h of handlers) h(env);
	});

	return {
		subscribe(channels) {
			if (socket.readyState === WebSocket.OPEN) {
				socket.send(JSON.stringify({ type: "subscribe", channels }));
			} else {
				pendingSubs.push(...channels);
			}
		},
		unsubscribe(channels) {
			if (socket.readyState === WebSocket.OPEN) {
				socket.send(JSON.stringify({ type: "unsubscribe", channels }));
			}
		},
		on(handler) {
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
			};
		},
		close() {
			socket.close();
		},
	};
}
