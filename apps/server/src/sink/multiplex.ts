import type {
	DeliveryResult,
	Logger,
	NotificationPayload,
	NotificationSink,
	PushAdapter,
	PushTarget,
} from "@bilibili-notify/internal";
import type { ConfigStore } from "../config/store.js";
import type { PlatformAdapter, ProbeResult } from "../platforms/types.js";

/**
 * Extended sink — keeps the canonical NotificationSink surface but adds an
 * `out-of-band` adapter probe entry point used by `/api/adapters/:id/test` and
 * the {@link AdapterProbeScheduler}.
 */
export interface MultiplexSink extends NotificationSink {
	probeAdapter(adapterId: string): Promise<ProbeResult>;
}

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

export function createMultiplexSink(opts: MultiplexSinkOptions): MultiplexSink {
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

		async probeAdapter(adapterId: string): Promise<ProbeResult> {
			const adapter = opts.store.getAdapters().find((a) => a.id === adapterId);
			if (!adapter) {
				return { ok: false, latencyMs: 0, err: "adapter not found" };
			}
			const platformAdapter = adapterByPlatform.get(adapter.platform);
			if (!platformAdapter) {
				return { ok: false, latencyMs: 0, err: `no platform adapter for ${adapter.platform}` };
			}
			return platformAdapter.probe(adapter);
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
		// 只在「强制私聊」路径传 private:true。普通 send 不该传 false ——
		// 旧实现恒 spread `{ private: options.private }`,把 false 也送给 adapter,
		// 与 OneBot adapter 内 `opts.private ?? scope` 的 ?? 配合就会让 scope==="private"
		// 的 target 走错分支(已同步修 onebot.ts,这里双层防御)。
		const sendOpts = options.private ? { private: true } : {};
		const result = await platformAdapter.send(adapter, target, payload, sendOpts);
		opts.onDelivery?.(target, payload, result, options);
		return result;
	}
}
