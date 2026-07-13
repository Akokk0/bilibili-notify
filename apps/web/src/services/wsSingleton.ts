/**
 * Process-wide singleton over `connectWs`. React hooks share one socket; all
 * subscribers see the same envelope stream. Channel subscriptions and handlers
 * are owned *here* (not on the client instance) so they survive being
 * disconnected and replayed onto a fresh socket.
 *
 * Auth gating (Q3/Q5): `setWsEnabled(false)` tears the socket down (logout or
 * mid-session cookie expiry — otherwise the ticket fetch would 401-spam on
 * reconnect backoff); `setWsEnabled(true)` rebuilds it and replays the
 * remembered channels + handlers. A cold pre-login load never reaches here
 * because the channel hooks live under `<AuthGate>`'s gated subtree.
 */

import { type ChannelName, connectWs, type WsClient, type WsEnvelope, type WsStatus } from "./ws";

let client: WsClient | null = null;
let enabled = true;
let lastStatus: WsStatus = "closed";

const desired = new Set<ChannelName>();
const eventHandlers = new Set<(env: WsEnvelope) => void>();
const statusHandlers = new Set<(status: WsStatus) => void>();
let detachers: Array<() => void> = [];

function bind(): void {
	if (client || !enabled) return;
	const c = connectWs();
	client = c;
	if (desired.size > 0) c.subscribe([...desired]);
	detachers = [
		c.on((env) => {
			for (const h of eventHandlers) h(env);
		}),
		c.onStatus((status) => {
			lastStatus = status;
			for (const h of statusHandlers) h(status);
		}),
	];
}

function unbind(): void {
	for (const d of detachers.splice(0)) d();
	client?.close();
	client = null;
	if (lastStatus !== "closed") {
		lastStatus = "closed";
		for (const h of statusHandlers) h("closed");
	}
}

function ensure(): void {
	if (!client && enabled) bind();
}

/** Enable/disable the socket. Driven by the dashboard session state. */
export function setWsEnabled(next: boolean): void {
	if (enabled === next) return;
	enabled = next;
	if (enabled) bind();
	else unbind();
}

export function subscribeChannels(channels: ChannelName[]): void {
	for (const ch of channels) desired.add(ch);
	ensure();
	client?.subscribe(channels);
}

export function onWsEvent(handler: (env: WsEnvelope) => void): () => void {
	eventHandlers.add(handler);
	ensure();
	return () => {
		eventHandlers.delete(handler);
	};
}
