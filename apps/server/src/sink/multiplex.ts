import type {
	DeliveryResult,
	Logger,
	NotificationPayload,
	NotificationSink,
	PushTarget,
} from "@bilibili-notify/internal";
import type { ConfigStore } from "../config/store.js";
import type { PlatformAdapter } from "../platforms/types.js";

/**
 * Standalone {@link NotificationSink} implementation.
 *
 * Resolves `targetId → PushTarget` against the live ConfigStore, looks up the
 * matching {@link PlatformAdapter} by `target.platform`, and delegates the
 * delivery. The sink itself stays generic — adding a new platform just means
 * registering another adapter.
 *
 * Adapters for `koishi-*` are intentionally absent on the standalone side;
 * the sink reports the target as unavailable so the upstream BilibiliPush
 * skips delivery and logs a warn.
 */
export interface MultiplexSinkOptions {
	store: ConfigStore;
	adapters: PlatformAdapter[];
	logger: Logger;
	/** Optional hook fired after every send (success or failure). Used by the history store. */
	onDelivery?: (
		target: PushTarget,
		payload: NotificationPayload,
		result: DeliveryResult,
		opts: { private: boolean },
	) => void;
}

export function createMultiplexSink(opts: MultiplexSinkOptions): NotificationSink {
	const log = opts.logger;
	const adapterByPlatform = new Map<string, PlatformAdapter>();
	for (const ad of opts.adapters) {
		for (const p of ad.platforms) {
			if (adapterByPlatform.has(p)) {
				log.warn(`[sink] platform=${p} adapter override; previous registration replaced`);
			}
			adapterByPlatform.set(p, ad);
		}
	}

	function pickAdapter(target: PushTarget): PlatformAdapter | undefined {
		// Direct match first (covers literal platforms).
		const direct = adapterByPlatform.get(target.platform);
		if (direct) return direct;
		// Wildcard koishi-* family — never handled standalone-side.
		return undefined;
	}

	return {
		resolve(targetId: string): PushTarget | undefined {
			return opts.store.getTargets().find((t) => t.id === targetId);
		},

		isAvailable(targetId: string): boolean {
			const target = opts.store.getTargets().find((t) => t.id === targetId);
			if (!target) return false;
			const adapter = pickAdapter(target);
			if (!adapter) return false;
			return adapter.isAvailable(target);
		},

		send(targetId: string, payload: NotificationPayload): Promise<DeliveryResult> {
			return dispatch(targetId, payload, { private: false });
		},

		sendPrivate(targetId: string, payload: NotificationPayload): Promise<DeliveryResult> {
			return dispatch(targetId, payload, { private: true });
		},
	};

	async function dispatch(
		targetId: string,
		payload: NotificationPayload,
		options: { private: boolean },
	): Promise<DeliveryResult> {
		const target = opts.store.getTargets().find((t) => t.id === targetId);
		if (!target) {
			const result: DeliveryResult = { ok: false, latencyMs: 0, err: "target not found" };
			return result;
		}
		const adapter = pickAdapter(target);
		if (!adapter) {
			const result: DeliveryResult = {
				ok: false,
				latencyMs: 0,
				err: `no adapter for platform=${target.platform}`,
			};
			log.warn(`[sink] ${result.err} (target=${target.id})`);
			opts.onDelivery?.(target, payload, result, options);
			return result;
		}
		const result = await adapter.send(target, payload, { private: options.private });
		opts.onDelivery?.(target, payload, result, options);
		return result;
	}
}
