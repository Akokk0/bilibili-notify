import type {
	Connection,
	ConnectionCapabilities,
	DeliveryResult,
	Logger,
	NotificationPayload,
	NotificationSink,
	PushTarget,
} from "@bilibili-notify/internal";
import { isTargetPaused } from "@bilibili-notify/internal";
import type { ConfigStore } from "../config/store.js";
import type { PlatformAdapter, ProbeResult } from "../platforms/types.js";

/**
 * Extended sink — keeps the canonical NotificationSink surface but adds an
 * `out-of-band` adapter probe entry point used by `/api/adapters/:id/test` and
 * the {@link AdapterProbeScheduler}.
 */
export interface MultiplexSink extends NotificationSink {
	probeConnection(adapterId: string): Promise<ProbeResult>;
	/**
	 * 适配器的平台能力快照(能不能签小程序卡);适配器缺、平台实现缺、平台没有能力概念都是
	 * undefined —— 调用方按「什么都不支持」处理。
	 */
	connectionCapabilities(adapterId: string): ConnectionCapabilities | undefined;
	/** 主动探一次能力;同上的三种缺失回 undefined。 */
	probeConnectionCapabilities(adapterId: string): Promise<ConnectionCapabilities | undefined>;
}

/**
 * Standalone {@link NotificationSink} implementation.
 *
 * Resolves `targetId → PushTarget → Connection` against the live ConfigStore,
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

	function findConnectionFor(target: PushTarget): Connection | undefined {
		return opts.store.getConnections().find((a) => a.id === target.adapterId);
	}

	/** 配置里的那条适配器 + 它所属平台的实现;缺一个就没法问它任何事。 */
	function routeOf(adapterId: string) {
		const connection = opts.store.getConnections().find((a) => a.id === adapterId);
		if (!connection) return undefined;
		const platformAdapter = adapterByPlatform.get(connection.platform);
		return platformAdapter ? { connection, platformAdapter } : undefined;
	}

	return {
		resolve(targetId: string): PushTarget | undefined {
			return findTarget(targetId);
		},

		isEnabled(targetId: string): boolean {
			const target = findTarget(targetId);
			if (!target) return false;
			return !isTargetPaused(target, opts.store.getConnections());
		},

		isAvailable(targetId: string): boolean {
			const target = findTarget(targetId);
			if (!target) return false;
			const connection = findConnectionFor(target);
			if (!connection) return false;
			const platformAdapter = adapterByPlatform.get(connection.platform);
			if (!platformAdapter) return false;
			return platformAdapter.isAvailable(connection, target);
		},

		send(targetId: string, payload: NotificationPayload): Promise<DeliveryResult> {
			return dispatch(targetId, payload, { private: false });
		},

		sendPrivate(targetId: string, payload: NotificationPayload): Promise<DeliveryResult> {
			return dispatch(targetId, payload, { private: true });
		},

		connectionCapabilities(adapterId: string): ConnectionCapabilities | undefined {
			const route = routeOf(adapterId);
			return route?.platformAdapter.capabilities?.(route.connection);
		},

		async probeConnectionCapabilities(
			adapterId: string,
		): Promise<ConnectionCapabilities | undefined> {
			const route = routeOf(adapterId);
			return route?.platformAdapter.probeCapabilities?.(route.connection);
		},

		async probeConnection(adapterId: string): Promise<ProbeResult> {
			const connection = opts.store.getConnections().find((a) => a.id === adapterId);
			if (!connection) {
				return { ok: false, latencyMs: 0, err: "adapter not found" };
			}
			const platformAdapter = adapterByPlatform.get(connection.platform);
			if (!platformAdapter) {
				return { ok: false, latencyMs: 0, err: `no platform adapter for ${connection.platform}` };
			}
			return platformAdapter.probe(connection);
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
		const connection = findConnectionFor(target);
		if (!connection) {
			const result: DeliveryResult = {
				ok: false,
				latencyMs: 0,
				err: `adapter not found: adapterId=${target.adapterId}`,
			};
			log.warn(`[sink] ${result.err} (target=${target.id})`);
			opts.onDelivery?.(target, payload, result, options);
			return result;
		}
		const platformAdapter = adapterByPlatform.get(connection.platform);
		if (!platformAdapter) {
			const result: DeliveryResult = {
				ok: false,
				latencyMs: 0,
				err: `no platform adapter for ${connection.platform}`,
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
		const result = await platformAdapter.send(connection, target, payload, sendOpts);
		opts.onDelivery?.(target, payload, result, options);
		return result;
	}
}
