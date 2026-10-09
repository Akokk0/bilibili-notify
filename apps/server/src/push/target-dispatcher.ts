import type {
	Connection,
	ConnectionCapabilities,
	DeliveryResult,
	DestinationRef,
	Failure,
	Logger,
	NotificationPayload,
	ProbeResult,
	PushTarget,
	SessionRef,
	TargetDispatcher,
} from "@bilibili-notify/internal";
import {
	connectionDispatchKey,
	fail,
	isTargetPaused,
	platformOfTarget,
	platformSupportsAtAll,
} from "@bilibili-notify/internal";
import { CONNECTION_NOT_FOUND, type ConfigStore } from "../config/store.js";
import { adapterForConnection } from "./dispatch.js";
import { type PlatformAdapterRegistry, sendableAdapters } from "./registry.js";

/** 派发器从登记表拿到的出口(带 `send`,不含启停)。 */
type SendableAdapter = ReturnType<typeof sendableAdapters>[number];

/**
 * The server's {@link TargetDispatcher} implementation.
 *
 * Resolves `targetId → PushTarget → Connection` against the live ConfigStore,
 * looks up the matching `PlatformAdapter` by `connection.platform`, and
 * delegates the delivery. The dispatcher itself stays generic — adding a new platform
 * just means registering another platform adapter.
 */
/**
 * 截流闸的口子(devtools 的推送截流接在这里):在「所有检查都过了、马上要调适配器 `send`」那一处问它。
 * 回了结果就用那个结果、不调适配器;回 `undefined` 就照常发。两条发送路(`send` /
 * `sendToAddress`)共用这一处。
 *
 * `destination` 是交给适配器的去向;`target` 是经目标表发送时的那条真目标,
 * `sendToAddress`(不经目标表)时是 `undefined`。
 */
export type SendInterceptHandler = (send: {
	connection: Connection;
	destination: DestinationRef;
	target: PushTarget | undefined;
	payload: NotificationPayload;
}) => DeliveryResult | undefined;

export interface TargetDispatcherOptions {
	store: ConfigStore;
	adapters: PlatformAdapterRegistry;
	logger: Logger;
	/** 开发版的推送截流;生产不传。见 {@link SendInterceptHandler}。 */
	interceptSend?: SendInterceptHandler;
	/** Optional hook fired after every send (success or failure). Used by the history store. */
	onDelivery?: (target: PushTarget, payload: NotificationPayload, result: DeliveryResult) => void;
}

export function createTargetDispatcher(opts: TargetDispatcherOptions): TargetDispatcher {
	const log = opts.logger;
	// 出口**每次现问注册表** —— 拓展是后加载的,而且拨一下开关就会来去(ADR-0012 决策 29)。
	// 从前这里自己建了一张键 → adapter 的 Map,那是「哪个 adapter 管这条连接」的第二份
	// 实现;现在与别处共用 `adapterForConnection` 那一份。
	const adapterFor = (connection: Connection): SendableAdapter | undefined =>
		adapterForConnection(sendableAdapters(opts.adapters), connection);

	function findTarget(targetId: string): PushTarget | undefined {
		return opts.store.getTargets().find((t) => t.id === targetId);
	}

	function findConnection(connectionId: string): Connection | undefined {
		return opts.store.getConnections().find((a) => a.id === connectionId);
	}

	/** 开关的检查,**全仓只有这一份**(适配器不再各查一遍)。过了回 `undefined`,没过回失败结果。 */
	function refusal(target: PushTarget, connection: Connection): Failure | undefined {
		if (isTargetPaused(target, opts.store.getConnections())) {
			return target.enabled
				? fail("not_configured", `connection disabled: connectionId=${connection.id}`)
				: fail("not_configured", `target disabled: targetId=${target.id}`);
		}
		return undefined;
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
			if (refusal(target, connection)) return false;
			return platformAdapter.isAvailable(connection, destinationOf(target));
		},

		supportsAtAll(targetId: string): boolean {
			const target = findTarget(targetId);
			if (!target) return false;
			const platform = platformOfTarget(target, opts.store.getConnections());
			return platform !== undefined && platformSupportsAtAll(platform);
		},

		send(targetId: string, payload: NotificationPayload): Promise<DeliveryResult> {
			return dispatch(targetId, payload);
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
			const destination: DestinationRef = { kind: "session", ...session };
			if (!connection.enabled) {
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
			if (!platformAdapter.isAvailable(connection, destination)) {
				const result = fail("unavailable", `connection unavailable: connectionId=${connection.id}`);
				log.warn(`[sink] ${result.message} (sendToAddress)`);
				return result;
			}
			// 不触发 onDelivery:它会去写 `target.testStatus`,这里没有目标表里的那条。不重试、不落历史。
			return deliver(connection, platformAdapter, destination, undefined, payload);
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

	async function dispatch(targetId: string, payload: NotificationPayload): Promise<DeliveryResult> {
		const target = findTarget(targetId);
		if (!target) return fail("not_found", "target not found");
		const connection = findConnection(target.connectionId);
		if (!connection) {
			const result = fail("not_found", `connection not found: connectionId=${target.connectionId}`);
			log.warn(`[sink] ${result.message} (target=${target.id})`);
			opts.onDelivery?.(target, payload, result);
			return result;
		}
		const platformAdapter = adapterFor(connection);
		if (!platformAdapter) {
			const result = noAdapter(connection);
			log.warn(`[sink] ${result.message} (target=${target.id})`);
			opts.onDelivery?.(target, payload, result);
			return result;
		}
		const refused = refusal(target, connection);
		if (refused) {
			log.warn(`[sink] ${refused.message} (target=${target.id})`);
			opts.onDelivery?.(target, payload, refused);
			return refused;
		}
		const result = await deliver(
			connection,
			platformAdapter,
			destinationOf(target),
			target,
			payload,
		);
		opts.onDelivery?.(target, payload, result);
		return result;
	}

	/** 两条发送路共用的最后一步:先问截流闸,没人截才调适配器;适配器抛错在这里接住。 */
	async function deliver(
		connection: Connection,
		platformAdapter: SendableAdapter,
		destination: DestinationRef,
		target: PushTarget | undefined,
		payload: NotificationPayload,
	): Promise<DeliveryResult> {
		const intercepted = opts.interceptSend?.({ connection, destination, target, payload });
		if (intercepted) return intercepted;
		try {
			return await platformAdapter.send(connection, destination, payload);
		} catch (e) {
			return thrown(e, `${target ? `target=${target.id}` : "sendToAddress"} send`);
		}
	}
}

/** 推送目标 → 适配器发送口要的那几格。会话目标取 `scope` / `address` / `parentAddress`,端点目标取 `id` / `name`。 */
function destinationOf(target: PushTarget): DestinationRef {
	if (target.kind === "endpoint") {
		return { kind: "endpoint", id: target.id, name: target.name };
	}
	return {
		kind: "session",
		scope: target.scope,
		address: target.address,
		parentAddress: target.parentAddress,
	};
}
