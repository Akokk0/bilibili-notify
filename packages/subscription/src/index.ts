import type { MessageBus, Subscription, SubscriptionOp } from "@bilibili-notify/internal";

/**
 * In-memory subscription collection with diff + emit.
 * Persistence is the caller's concern: koishi/core seeds from koishi config,
 * standalone seeds from ConfigStore. Both call replaceAll() on load.
 */
export interface SubscriptionStore {
	/** Return a snapshot of all subscriptions (shallow copy). */
	list(): Subscription[];
	/** Find a subscription by uid; returns undefined if not found. */
	findByUid(uid: string): Subscription | undefined;
	/** Find a subscription by its stable id; returns undefined if not found. */
	findById(id: string): Subscription | undefined;
	/**
	 * Insert or replace a subscription (match by id).
	 * Emits 'subscription-changed' with an add or update op.
	 */
	upsert(sub: Subscription): void;
	/**
	 * Remove a subscription by its stable id.
	 * Emits 'subscription-changed' with a remove op if found.
	 * Returns the removed subscription, or undefined if not found.
	 */
	removeById(id: string): Subscription | undefined;
	/**
	 * Replace the entire collection atomically.
	 * Computes the diff against the previous state and emits 'subscription-changed'
	 * with the resulting ops (may be empty if nothing changed).
	 */
	replaceAll(next: Subscription[]): void;
}

/** Compute an op list representing how prev → next changed (keyed by id). */
export function diff(prev: Subscription[], next: Subscription[]): SubscriptionOp[] {
	const ops: SubscriptionOp[] = [];
	const prevMap = new Map(prev.map((s) => [s.id, s]));
	const nextMap = new Map(next.map((s) => [s.id, s]));

	for (const [id, sub] of prevMap) {
		if (!nextMap.has(id)) ops.push({ type: "remove", id, uid: sub.uid });
	}
	for (const [id, sub] of nextMap) {
		if (!prevMap.has(id)) {
			ops.push({ type: "add", sub });
		} else {
			// Deep-compare: simple JSON check is sufficient for the schema types.
			const prev = prevMap.get(id);
			if (JSON.stringify(prev) !== JSON.stringify(sub)) {
				ops.push({ type: "update", sub });
			}
		}
	}
	return ops;
}

/** Factory function producing an in-memory SubscriptionStore. */
export function createSubscriptionStore(bus: MessageBus): SubscriptionStore {
	let subs: Subscription[] = [];

	return {
		list() {
			return [...subs];
		},
		findByUid(uid) {
			return subs.find((s) => s.uid === uid);
		},
		findById(id) {
			return subs.find((s) => s.id === id);
		},
		upsert(sub) {
			const idx = subs.findIndex((s) => s.id === sub.id);
			const ops: SubscriptionOp[] = idx === -1 ? [{ type: "add", sub }] : [{ type: "update", sub }];
			if (idx === -1) {
				subs = [...subs, sub];
			} else {
				subs = [...subs.slice(0, idx), sub, ...subs.slice(idx + 1)];
			}
			bus.emit("subscription-changed", ops);
		},
		removeById(id) {
			const idx = subs.findIndex((s) => s.id === id);
			if (idx === -1) return undefined;
			const removed = subs[idx];
			subs = [...subs.slice(0, idx), ...subs.slice(idx + 1)];
			bus.emit("subscription-changed", [{ type: "remove", id, uid: removed.uid }]);
			return removed;
		},
		replaceAll(next) {
			const ops = diff(subs, next);
			subs = [...next];
			if (ops.length > 0) bus.emit("subscription-changed", ops);
		},
	};
}

// Re-export types callers need from this package
export type { Subscription, SubscriptionOp };

/**
 * Legacy flat config item shape used by the koishi basic sub configuration UI.
 * Preserved here so koishi/core/src/config.ts can reference it without touching push.
 */
export interface FlatSubConfigItem {
	name: string;
	uid: string;
	platform: string;
	/** Comma-separated channel IDs */
	target: string;
	dynamic: boolean;
	dynamicAtAll: boolean;
	live: boolean;
	liveAtAll: boolean;
	liveEnd: boolean;
	liveGuardBuy: boolean;
	superchat: boolean;
	wordcloud: boolean;
	liveSummary: boolean;
}
