import type {
	DeliveryResult,
	Logger,
	NotificationPayload,
	PushAdapter,
	PushTarget,
} from "@bilibili-notify/internal";
import type { PlatformAdapter } from "./types.js";

/**
 * Web-dashboard "platform". This is not a real outbound channel — it's a
 * passthrough that signals the dashboard's notification center to display the
 * payload. The actual delivery happens via the WS `push-events` channel, which
 * is fed by the bus's `history-recorded` event emitted by the history layer.
 *
 * As a {@link PlatformAdapter} it merely returns ok and lets the
 * MultiplexNotificationSink record the entry in HistoryStore. The dashboard
 * receives every history-recorded entry over the WS channel and renders
 * whatever has `target.platform === 'web-dashboard'` in the notification UI.
 */
export interface WebDashboardAdapterOptions {
	logger: Logger;
}

export function createWebDashboardAdapter(_opts: WebDashboardAdapterOptions): PlatformAdapter {
	return {
		platforms: ["web-dashboard"],
		isAvailable(adapter: PushAdapter, target: PushTarget): boolean {
			return (
				adapter.platform === "web-dashboard" &&
				target.platform === "web-dashboard" &&
				adapter.enabled &&
				target.enabled
			);
		},
		async send(
			adapter: PushAdapter,
			target: PushTarget,
			_payload: NotificationPayload,
			_opts?: { private?: boolean },
		): Promise<DeliveryResult> {
			if (adapter.platform !== "web-dashboard" || target.platform !== "web-dashboard") {
				return {
					ok: false,
					latencyMs: 0,
					err: `wrong platform: adapter=${adapter.platform} target=${target.platform}`,
				};
			}
			return { ok: true, latencyMs: 0 };
		},
	};
}
