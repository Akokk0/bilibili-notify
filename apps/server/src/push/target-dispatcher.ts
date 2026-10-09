import type {
	Connection,
	ConnectionCapabilities,
	DeliveryResult,
	Logger,
	NotificationPayload,
	PlatformAdapter,
	ProbeResult,
	PushTarget,
	SessionRef,
	TargetDispatcher,
} from "@bilibili-notify/internal";
import { connectionDispatchKey, fail, isTargetPaused } from "@bilibili-notify/internal";
import { CONNECTION_NOT_FOUND, type ConfigStore } from "../config/store.js";
import { adapterForConnection } from "./dispatch.js";
import { type PlatformAdapterRegistry, sendableAdapters } from "./registry.js";

/**
 * The server's {@link TargetDispatcher} implementation.
 *
 * Resolves `targetId → PushTarget → Connection` against the live ConfigStore,
 * looks up the matching {@link PlatformAdapter} by `connection.platform`, and
 * delegates the delivery. The dispatcher itself stays generic — adding a new platform
 * just means registering another platform adapter.
 */
/**
 * 截流闸的口子(devtools 的推送截流接在这里):在「所有检查都过了、马上要调适配器 `send`」那一处问它。
 * 回了结果就用那个结果、不调适配器;回 `undefined` 就照常发。三条发送路(`send` / `sendPrivate` /
 * `sendToAddress`)共用这一处。
 *
 * `isProvisional`:这次是 `sendToAddress` 发的,`target` 是只活在这一次调用里的临时目标。
 */
export type SendInterceptHandler = (send: {
	connection: Connection;
	target: PushTarget;
	private: boolean;
	isProvisional: boolean;
	payload: NotificationPayload;
}) => DeliveryResult | undefined;

export interface TargetDispatcherOptions {
	store: ConfigStore;
	adapters: PlatformAdapterRegistry;
	logger: Logger;
	/** 开发版的推送截流;生产不传。见 {@link SendInterceptHandler}。 */
	interceptSend?: SendInterceptHandler;
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
		adapterForConnection(sendableAdapters(opts.adapters), connection);

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

		async sendToAddress(
			connectionId: string,
			session: SessionRef,
			payload: NotificationPayload,
		): Promise<DeliveryResult> {
			const connection = findConnection(connectionId);
			if (!connection) {
				const result = fail("not_found", `connection not found: connectionId=${connectionId}`);
				log.warn(`[sink] ${result.message} (sendToAddress)`);
				return result;
			}
			const target = provisionalTarget(connection, session);
			if (isTargetPaused(target, opts.store.getConnections())) {
				const result = fail("not_configured", `connection disabled: connectionId=${connection.id}`);
				log.warn(`[sink] ${result.message} (sendToAddress)`);
				return result;
			}
			const platformAdapter = adapterFor(connection);
			if (!platformAdapter) {
				const result = noAdapter(connection);
				log.warn(`[sink] ${result.message} (sendToAddress, connectionId=${connection.id})`);
				return result;
			}
			if (!platformAdapter.isAvailable(connection, target)) {
				const result = fail("unavailable", `connection unavailable: connectionId=${connection.id}`);
				log.warn(`[sink] ${result.message} (sendToAddress)`);
				return result;
			}
			// 不触发 onDelivery:它会去写 `target.testStatus`,临时目标不在表里。不重试、不落历史。
			return deliver(connection, platformAdapter, target, payload, { private: false }, true);
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
		const result = await deliver(connection, platformAdapter, target, payload, options, false);
		opts.onDelivery?.(target, payload, result, options);
		return result;
	}

	/** 三条发送路共用的最后一步:先问截流闸,没人截才调适配器;适配器抛错在这里接住。 */
	async function deliver(
		connection: Connection,
		platformAdapter: PlatformAdapter,
		target: PushTarget,
		payload: NotificationPayload,
		options: { private: boolean },
		isProvisional: boolean,
	): Promise<DeliveryResult> {
		const intercepted = opts.interceptSend?.({
			connection,
			target,
			private: options.private,
			isProvisional,
			payload,
		});
		if (intercepted) return intercepted;
		// 只在「强制私聊」路径传 private:true。普通 send 不该传 false ——
		// 旧实现恒 spread `{ private: options.private }`,把 false 也送给 adapter,
		// 与 OneBot adapter 内 `opts.private ?? scope` 的 ?? 配合就会让 scope==="private"
		// 的 target 走错分支(已同步修 onebot.ts,这里双层防御)。
		const sendOpts = options.private ? { private: true } : {};
		try {
			return await platformAdapter.send(connection, target, payload, sendOpts);
		} catch (e) {
			return thrown(e, `target=${target.id} send`);
		}
	}
}

/**
 * 给 `sendToAddress` 拼的会话目标,只活在这一次调用里,不在目标表里。
 *
 * 适配器的 `send` 现在还吃完整的 `PushTarget`,所以得拼一个;适配器接口在 3a-20 改窄之后
 * 这个临时目标就删掉。
 */
function provisionalTarget(connection: Connection, session: SessionRef): PushTarget {
	return {
		id: `session:${session.scope}:${session.address}`,
		name: `session:${session.scope}:${session.address}`,
		connectionId: connection.id,
		kind: "session",
		scope: session.scope,
		address: session.address,
		platform: connection.platform,
		enabled: true,
	};
}
