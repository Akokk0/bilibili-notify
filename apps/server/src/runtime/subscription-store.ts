import type { Disposable, MessageBus, Subscription } from "@bilibili-notify/internal";
import { createSubscriptionStore, type SubscriptionStore } from "@bilibili-notify/subscription";
import type { ConfigStore } from "../config/store.js";

/**
 * Wires the in-memory {@link SubscriptionStore} (from
 * `@bilibili-notify/subscription`) to the file-backed {@link ConfigStore}.
 *
 * On boot we seed the store from disk; whenever a `config-changed` event
 * fires for the `subscriptions` scope we re-seed via `replaceAll`. The
 * store internally diffs and emits `subscription-changed` so engines can
 * apply incremental ops.
 *
 * The reverse direction (engine state mutations back to disk) goes through
 * the REST routes — `/api/subs PATCH` writes the ConfigStore which then
 * fans out via this loop.
 */
export interface SubscriptionStoreBinding extends Disposable {
	readonly store: SubscriptionStore;
}

export interface BindSubscriptionStoreOptions {
	bus: MessageBus;
	configStore: ConfigStore;
}

export function bindSubscriptionStore(
	opts: BindSubscriptionStoreOptions,
): SubscriptionStoreBinding {
	const store = createSubscriptionStore(opts.bus);
	store.replaceAll(opts.configStore.getSubscriptions());

	const sub = opts.configStore.onChange((scope) => {
		if (scope !== "subscriptions") return;
		store.replaceAll(opts.configStore.getSubscriptions());
	});

	return {
		store,
		dispose: () => sub.dispose(),
	};
}

/** Re-export so callers can type their own params without an extra import. */
export type { Subscription, SubscriptionStore };
