import type { DeliveryResult, NotificationPayload, PushTarget } from "@bilibili-notify/internal";

/**
 * Platform adapter contract used by {@link MultiplexNotificationSink}.
 *
 * One adapter per `PushTarget.platform` family. Each adapter is constructed
 * with whatever shared deps it needs (HTTP client, WS server reference, etc.)
 * and exposes a single async `send(target, payload, opts)` method. The sink
 * dispatches by matching `target.platform`.
 *
 * Adapters should NOT throw — return `{ ok: false, err: "..." }` instead.
 * The router will retry on transient failures.
 */
export interface PlatformAdapter {
	/** Comma-separated list of platforms this adapter handles ("onebot", "webhook", "web-dashboard"). */
	readonly platforms: readonly string[];
	/** Return whether this adapter can deliver to `target` right now. */
	isAvailable(target: PushTarget): boolean;
	/** Deliver `payload` to `target`. `private=true` flips group → private semantics where applicable. */
	send(
		target: PushTarget,
		payload: NotificationPayload,
		opts?: { private?: boolean },
	): Promise<DeliveryResult>;
}
