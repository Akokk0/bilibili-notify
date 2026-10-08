import type {
	Connection,
	ConnectionCapabilities,
	DeliveryResult,
	Logger,
	NotificationPayload,
	PlatformAdapter,
	ProbeResult,
	PushTarget,
	TargetDispatcher,
} from "@bilibili-notify/internal";
import { connectionDispatchKey, fail, isTargetPaused } from "@bilibili-notify/internal";
import { CONNECTION_NOT_FOUND, type ConfigStore } from "../config/store.js";
import { adapterForConnection } from "./dispatch.js";
import type { PlatformAdapterRegistry } from "./registry.js";

/**
 * The server's {@link TargetDispatcher} implementation.
 *
 * Resolves `targetId → PushTarget → Connection` against the live ConfigStore,
 * looks up the matching {@link PlatformAdapter} by `connection.platform`, and
 * delegates the delivery. The dispatcher itself stays generic — adding a new platform
 * just means registering another platform adapter.
 */
export interface TargetDispatcherOptions {
	store: ConfigStore;
	adapters: PlatformAdapterRegistry;
	logger: Logger;
	/** Optional hook fired after every send (success or failure). Used by the history store. */
	onDelivery?: (
		target: PushTarget,
		payload: NotificationPayload,
		result: DeliveryResult,
		opts: { private: boolean },
	) => void;
}

export function createTargetDispatcher(opts: TargetDispatcherOptions): TargetDispatcher {
	const log = opts.logger;
	// 出口**每次现问注册表** —— 拓展是后加载的,而且拨一下开关就会来去(ADR-0012 决策 29)。
	// 从前这里自己建了一张键 → adapter 的 Map,那是「哪个 adapter 管这条连接」的第二份
	// 实现;现在与别处共用 `adapterForConnection` 那一份。
	const adapterFor = (connection: Connection): PlatformAdapter | undefined =>
		adapterForConnection(opts.adapters.list(), connection);

	function findTarget(targetId: string): PushTarget | undefined {
		return opts.store.getTargets().find((t) => t.id === targetId);
	}

	function findConnection(connectionId: string): Connection | undefined {
		return opts.store.getConnections().find((a) => a.id === connectionId);
	}

	/** 配置里的那条连接 + 它所属平台的实现;缺一个就没法问它任何事。 */
	function routeOf(connectionId: string) {
		const connection = findConnection(connectionId);
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
			const connection = findConnection(target.connectionId);
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
			const connection = findConnection(connectionId);
			if (!connection) return fail("not_found", CONNECTION_NOT_FOUND);
			const platformAdapter = adapterFor(connection);
			if (!platformAdapter) return noAdapter(connection);
			try {
				return await platformAdapter.probe(connection);
			} catch (e) {
				return thrown(e, `connection=${connection.id} probe`);
			}
		},
	};

	/** 这条连接眼下没有适配器管。拓展是后加载、还会来去的,所以是「暂时不可用」而不是「不存在」。 */
	function noAdapter(connection: Connection) {
		return fail("unavailable", `no platform adapter for ${connectionDispatchKey(connection)}`);
	}

	/** 适配器不许抛(ADR-0026 决策 1):真抛了算 bug,在这道边界接住,按「暂时不可用」记并留 error 日志。 */
	function thrown(e: unknown, where: string) {
		const message = e instanceof Error ? e.message : String(e);
		log.error(`[sink] platform adapter threw (${where}): ${message}`);
		return fail("unavailable", message);
	}

	async function dispatch(
		targetId: string,
		payload: NotificationPayload,
		options: { private: boolean },
	): Promise<DeliveryResult> {
		const target = findTarget(targetId);
		if (!target) return fail("not_found", "target not found");
		const connection = findConnection(target.connectionId);
		if (!connection) {
			const result = fail("not_found", `connection not found: connectionId=${target.connectionId}`);
			log.warn(`[sink] ${result.message} (target=${target.id})`);
			opts.onDelivery?.(target, payload, result, options);
			return result;
		}
		const platformAdapter = adapterFor(connection);
		if (!platformAdapter) {
			const result = noAdapter(connection);
			log.warn(`[sink] ${result.message} (target=${target.id})`);
			opts.onDelivery?.(target, payload, result, options);
			return result;
		}
		// 只在「强制私聊」路径传 private:true。普通 send 不该传 false ——
		// 旧实现恒 spread `{ private: options.private }`,把 false 也送给 adapter,
		// 与 OneBot adapter 内 `opts.private ?? scope` 的 ?? 配合就会让 scope==="private"
		// 的 target 走错分支(已同步修 onebot.ts,这里双层防御)。
		const sendOpts = options.private ? { private: true } : {};
		let result: DeliveryResult;
		try {
			result = await platformAdapter.send(connection, target, payload, sendOpts);
		} catch (e) {
			result = thrown(e, `target=${target.id} send`);
		}
		opts.onDelivery?.(target, payload, result, options);
		return result;
	}
}
