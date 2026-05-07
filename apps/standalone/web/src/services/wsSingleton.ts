/**
 * Process-wide singleton over `connectWs`. React hooks share one socket; all
 * subscribers see the same envelope stream. Channel subscriptions are sticky —
 * the WS layer survives StrictMode double-mount and component unmounts.
 */

import { type ChannelName, connectWs, type WsClient, type WsEnvelope, type WsStatus } from "./ws";

let client: WsClient | null = null;

function ensure(): WsClient {
	if (!client) client = connectWs();
	return client;
}

export function subscribeChannels(channels: ChannelName[]): void {
	ensure().subscribe(channels);
}

export function onWsEvent(handler: (env: WsEnvelope) => void): () => void {
	return ensure().on(handler);
}

export function onWsStatus(handler: (status: WsStatus) => void): () => void {
	return ensure().onStatus(handler);
}

export function getWsStatus(): WsStatus {
	return ensure().status();
}
