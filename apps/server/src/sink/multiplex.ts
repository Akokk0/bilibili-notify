import type {
	DeliveryResult,
	Logger,
	NotificationPayload,
	NotificationSink,
	PushAdapter,
	PushTarget,
} from "@bilibili-notify/internal";
import type { ConfigStore } from "../config/store.js";
import type { PlatformAdapter } from "../platforms/types.js";

/**
 * Standalone {@link NotificationSink} implementation.
 *
 * Resolves `targetId → PushTarget → PushAdapter` against the live ConfigStore,
 * looks up the matching {@link PlatformAdapter} by `adapter.platform`, and
 * delegates the delivery. The sink itself stays generic — adding a new platform
 * just means registering another platform adapter.
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

	function findTarget(targetId: string): PushTarget | undefined {
		return opts.store.getTargets().find((t) => t.id === targetId);
	}

	function findAdapterFor(target: PushTarget): PushAdapter | undefined {
		return opts.store.getAdapters().find((a) => a.id === target.adapterId);
	}

	return {
		resolve(targetId: string): PushTarget | undefined {
			return findTarget(targetId);
		},

		isAvailable(targetId: string): boolean {
			const target = findTarget(targetId);
			if (!target) return false;
			const adapter = findAdapterFor(target);
			if (!adapter) return false;
			const platformAdapter = adapterByPlatform.get(adapter.platform);
			if (!platformAdapter) return false;
			return platformAdapter.isAvailable(adapter, target);
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
		const target = findTarget(targetId);
		if (!target) {
			return { ok: false, latencyMs: 0, err: "target not found" };
		}
		const adapter = findAdapterFor(target);
		if (!adapter) {
			const result: DeliveryResult = {
				ok: false,
				latencyMs: 0,
				err: `adapter not found: adapterId=${target.adapterId}`,
			};
			log.warn(`[sink] ${result.err} (target=${target.id})`);
			opts.onDelivery?.(target, payload, result, options);
			return result;
		}
		const platformAdapter = adapterByPlatform.get(adapter.platform);
		if (!platformAdapter) {
			const result: DeliveryResult = {
				ok: false,
				latencyMs: 0,
				err: `no platform adapter for ${adapter.platform}`,
			};
			log.warn(`[sink] ${result.err} (target=${target.id})`);
			opts.onDelivery?.(target, payload, result, options);
			return result;
		}
		const result = await platformAdapter.send(adapter, target, payload, {
			private: options.private,
		});
		opts.onDelivery?.(target, payload, result, options);
		return result;
	}
}
