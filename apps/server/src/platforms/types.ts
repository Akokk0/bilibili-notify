import type {
	DeliveryResult,
	NotificationPayload,
	PushAdapter,
	PushTarget,
} from "@bilibili-notify/internal";

/**
 * Platform adapter contract used by {@link MultiplexNotificationSink}.
 *
 * One adapter per `PushAdapter.platform` family. Each platform adapter is
 * constructed with shared deps (HTTP client, WS server reference, etc.) and
 * exposes a single async `send(adapter, target, payload, opts)` method —
 * `adapter` carries the connection params (baseUrl, token, …), `target`
 * carries the session (groupId, dashboardUser, …). The sink dispatches by
 * matching `adapter.platform`.
 *
 * Adapters should NOT throw — return `{ ok: false, err: "..." }` instead.
 * The router will retry on transient failures.
 */
export interface PlatformAdapter {
	/** Platforms this adapter handles ("onebot" / "webhook" / "web-dashboard"). */
	readonly platforms: readonly string[];
	/** Return whether this adapter can deliver to `target` (via `adapter`) right now. */
	isAvailable(adapter: PushAdapter, target: PushTarget): boolean;
	/** Deliver `payload` to `target` over `adapter`. `private=true` flips group → private semantics where applicable. */
	send(
		adapter: PushAdapter,
		target: PushTarget,
		payload: NotificationPayload,
		opts?: { private?: boolean },
	): Promise<DeliveryResult>;
}
