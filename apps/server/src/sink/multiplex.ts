import type {
	Connection,
	ConnectionCapabilities,
	DeliveryResult,
	Logger,
	NotificationPayload,
	NotificationSink,
	PlatformAdapter,
	ProbeResult,
	PushTarget,
} from "@bilibili-notify/internal";
import { connectionDispatchKey, isTargetPaused } from "@bilibili-notify/internal";
import type { ConfigStore } from "../config/store.js";
import { adapterForConnection } from "../platforms/dispatch.js";
import type { AdapterRegistry } from "../platforms/registry.js";

/**
 * Extended sink — keeps the canonical NotificationSink surface but adds an
 * `out-of-band` connection probe entry point, used by
 * `/api/connections/:id/test` and by the engines' periodic health probe.
 */
export interface MultiplexSink extends NotificationSink {
	probeConnection(connectionId: string): Promise<ProbeResult>;
	/**
	 * 这条连接所在平台的能力快照(能不能签小程序卡);连接缺、平台实现缺、平台没有能力
	 * 概念都是 undefined —— 调用方按「什么都不支持」处理。
	 */
	connectionCapabilities(connectionId: string): ConnectionCapabilities | undefined;
	/** 主动探一次能力;同上的三种缺失回 undefined。 */
	probeConnectionCapabilities(connectionId: string): Promise<ConnectionCapabilities | undefined>;
}

/**
 * Standalone {@link NotificationSink} implementation.
 *
 * Resolves `targetId → PushTarget → Connection` against the live ConfigStore,
 * looks up the matching {@link PlatformAdapter} by `connection.platform`, and
 * delegates the delivery. The sink itself stays generic — adding a new platform
 * just means registering another platform adapter.
 */
export interface MultiplexSinkOptions {
	store: ConfigStore;
	adapters: AdapterRegistry;
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
	// 出口**每次现问注册表** —— 拓展是后加载的,而且拨一下开关就会来去(ADR-0012 决策 29)。
	// 从前这里自己建了一张键 → adapter 的 Map,那是「哪个 adapter 管这条连接」的第二份
	// 实现;现在与别处共用 `adapterForConnection` 那一份。
	const adapterFor = (connection: Connection): PlatformAdapter | undefined =>
		adapterForConnection(opts.adapters.list(), connection);

	function findTarget(targetId: string): PushTarget | undefined {
		return opts.store.getTargets().find((t) => t.id === targetId);
	}

	function findConnectionFor(target: PushTarget): Connection | undefined {
		return opts.store.getConnections().find((a) => a.id === target.connectionId);
	}

	/** 配置里的那条连接 + 它所属平台的实现;缺一个就没法问它任何事。 */
	function routeOf(connectionId: string) {
		const connection = opts.store.getConnections().find((a) => a.id === connectionId);
		if (!connection) return undefined;
		const platformAdapter = adapterFor(connection);
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
			const platformAdapter = adapterFor(connection);
			if (!platformAdapter) return false;
			return platformAdapter.isAvailable(connection, target);
		},

		send(targetId: string, payload: NotificationPayload): Promise<DeliveryResult> {
			return dispatch(targetId, payload, { private: false });
		},

		sendPrivate(targetId: string, payload: NotificationPayload): Promise<DeliveryResult> {
			return dispatch(targetId, payload, { private: true });
		},

		connectionCapabilities(connectionId: string): ConnectionCapabilities | undefined {
			const route = routeOf(connectionId);
			return route?.platformAdapter.capabilities?.(route.connection);
		},

		async probeConnectionCapabilities(
			connectionId: string,
		): Promise<ConnectionCapabilities | undefined> {
			const route = routeOf(connectionId);
			return route?.platformAdapter.probeCapabilities?.(route.connection);
		},

		async probeConnection(connectionId: string): Promise<ProbeResult> {
			const connection = opts.store.getConnections().find((a) => a.id === connectionId);
			if (!connection) {
				return { ok: false, latencyMs: 0, err: "connection not found" };
			}
			const platformAdapter = adapterFor(connection);
			if (!platformAdapter) {
				return {
					ok: false,
					latencyMs: 0,
					err: `no platform adapter for ${connectionDispatchKey(connection)}`,
				};
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
				err: `connection not found: connectionId=${target.connectionId}`,
			};
			log.warn(`[sink] ${result.err} (target=${target.id})`);
			opts.onDelivery?.(target, payload, result, options);
			return result;
		}
		const platformAdapter = adapterFor(connection);
		if (!platformAdapter) {
			const result: DeliveryResult = {
				ok: false,
				latencyMs: 0,
				err: `no platform adapter for ${connectionDispatchKey(connection)}`,
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
