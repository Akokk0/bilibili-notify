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
 * carries the session (groupId, userId, …). The sink dispatches by
 * matching `adapter.platform`.
 *
 * Adapters should NOT throw — return `{ ok: false, err: "..." }` instead.
 * The router will retry on transient failures.
 */
/**
 * Connection-level probe outcome. Distinct from {@link DeliveryResult} so the
 * caller can tell "this platform doesn't support a no-message probe" apart
 * from "probe ran and failed".
 */
export interface ProbeResult {
	/** `true` = reachable; `false` = reachable test failed; `null` = adapter has no probe protocol */
	ok: boolean | null;
	latencyMs: number;
	err?: string;
}

export interface PlatformAdapter {
	/** Platforms this adapter handles ("onebot" / "webhook"). */
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
	/**
	 * Side-effect-free reachability probe. Used by the adapter status indicator
	 * and the auto-poller. Implementations that have no out-of-band ping should
	 * return `{ ok: null }` so the UI can render "probe unsupported".
	 */
	probe(adapter: PushAdapter): Promise<ProbeResult>;
	/**
	 * Stateful adapters only — called once at boot and again on every
	 * `config-changed: adapters`. Reconcile live connections / listeners against
	 * the current adapter set (start / stop / rebind). MUST be idempotent and
	 * cheap (no-op when nothing changed) and MUST NOT write config or trigger a
	 * probe (would loop back through `config-changed`).
	 */
	reconcile?(adapters: readonly PushAdapter[]): void;
	/** Stateful adapters only — close all connections / listeners / timers on shutdown. Idempotent. */
	dispose?(): void | Promise<void>;
}
