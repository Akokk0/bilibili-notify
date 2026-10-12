import type {
	AddressCandidate,
	Connection,
	ConnectionCapabilities,
	DeliveryResult,
	DestinationRef,
	Failure,
	Logger,
	NotificationPayload,
	ProbeResult,
	PushTarget,
	PushTargetScope,
	Result,
	SessionRef,
	TargetDispatcher,
} from "@bilibili-notify/internal";
import { fail, isTargetPaused, shouldSendAtAll } from "@bilibili-notify/internal";
import { CONNECTION_NOT_FOUND, type ConfigStore } from "../config/store.js";
import { findAdapter, resolveConnection } from "./dispatch.js";
import { type PlatformAdapterRegistry, sendableAdapters } from "./registry.js";

/** 派发器从登记表拿到的出口(带 `send`,不含启停)。 */
type SendableAdapter = ReturnType<typeof sendableAdapters>[number];

/**
 * The server's {@link TargetDispatcher} implementation.
 *
 * Resolves `targetId → PushTarget → Connection` against the live ConfigStore,
 * looks up the matching `PlatformAdapter` by `connection.adapterKey`, resolves the connection's
 * `settings` against that adapter's `settingsSchema`, and delegates the delivery. The dispatcher itself stays generic — adding a new platform
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

	/**
	 * 配置里的那条连接 + 它所属平台的实现,**全部入口都走这一处**:出口每次现问注册表(拓展是后加载的,
	 * 拨一下开关就会来去,ADR-0012 决策 29),回出去的连接 `settings` 已按适配器的规则解好
	 * (适配器不再自己解,漏一处就是把盘上原文当解过的值用)。连接不在回 `not_found`,适配器不在回
	 * `unavailable`,设置过不了规则回 `not_configured`(被隔离的连接不会走到适配器手上)。
	 */
	function routeOf(
		connectionId: string,
		notFound = `connection not found: connectionId=${connectionId}`,
		gate?: (connection: Connection) => Failure | undefined,
	): Result<{ adapter: SendableAdapter; connection: Connection }> {
		const connection = findConnection(connectionId);
		if (!connection) return fail("not_found", notFound);
		const found = findAdapter(sendableAdapters(opts.adapters), connection);
		if (!found.ok) return found;
		// 次序:适配器不在 → 开关(`gate`) → 设置不合法。停用的连接设置合不合法无关紧要,先回停用那句。
		const refused = gate?.(connection);
		if (refused) return refused;
		return resolveConnection(found.adapter, connection);
	}

	/** 这条连接的适配器眼下怎么回答它的能力;连接 / 适配器不在、被隔离、适配器没实现 `capabilities` 都是 `undefined`。 */
	function capabilitiesOf(connectionId: string): ConnectionCapabilities | undefined {
		const route = routeOf(connectionId);
		return route.ok ? route.adapter.capabilities?.(route.connection) : undefined;
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
			const route = routeOf(target.connectionId, undefined, (c) => refusal(target, c));
			if (!route.ok) return false;
			return route.adapter.isAvailable(route.connection, destinationOf(target));
		},

		supportsAtAll(targetId: string): boolean {
			const target = findTarget(targetId);
			if (!target) return false;
			if (!findConnection(target.connectionId)) return false;
			// 问这条连接的适配器;没有适配器 / 适配器没实现能力 / 答「还不知道」都照发(发错只是多一条消息)。
			return shouldSendAtAll(capabilitiesOf(target.connectionId)?.atAll);
		},

		send(targetId: string, payload: NotificationPayload): Promise<DeliveryResult> {
			return dispatch(targetId, payload);
		},

		async sendToAddress(
			connectionId: string,
			session: SessionRef,
			payload: NotificationPayload,
		): Promise<DeliveryResult> {
			const destination: DestinationRef = { kind: "session", ...session };
			const route = routeOf(connectionId, undefined, (c) =>
				c.enabled ? undefined : fail("not_configured", `connection disabled: connectionId=${c.id}`),
			);
			if (!route.ok) {
				log.warn(`[sink] ${route.message} (sendToAddress, connectionId=${connectionId})`);
				return route;
			}
			const connection = route.connection;
			if (!route.adapter.isAvailable(route.connection, destination)) {
				const result = fail("unavailable", `connection unavailable: connectionId=${connection.id}`);
				log.warn(`[sink] ${result.message} (sendToAddress)`);
				return result;
			}
			// 不触发 onDelivery:它会去写 `target.reachability`,这里没有目标表里的那条。不重试、不落历史。
			return deliver(route.connection, route.adapter, destination, undefined, payload);
		},

		connectionCapabilities(connectionId: string): ConnectionCapabilities | undefined {
			return capabilitiesOf(connectionId);
		},

		async probeConnectionCapabilities(
			connectionId: string,
		): Promise<ConnectionCapabilities | undefined> {
			const route = routeOf(connectionId);
			return route.ok ? route.adapter.probeCapabilities?.(route.connection) : undefined;
		},

		async probeConnection(connectionId: string): Promise<ProbeResult> {
			const route = routeOf(connectionId, CONNECTION_NOT_FOUND);
			if (!route.ok) return route;
			try {
				return await route.adapter.probe(route.connection);
			} catch (e) {
				return thrown(e, `connection=${route.connection.id} probe`);
			}
		},

		async listAddressCandidates(
			connectionId: string,
			scope: PushTargetScope,
			signal: AbortSignal,
		): Promise<Result<{ candidates: readonly AddressCandidate[] }>> {
			// 不套停用闸:挑地址是在建目标,连接停着也要能挑(没传 `gate`)。
			const route = routeOf(connectionId, CONNECTION_NOT_FOUND);
			if (!route.ok) return route;
			const { adapter, connection } = route;
			if (!adapter.listAddressCandidates) return fail("unsupported", "这种连接没有可列的地址");
			try {
				return await adapter.listAddressCandidates(connection, scope, signal);
			} catch (e) {
				return thrown(e, `connection=${connection.id} listAddressCandidates`);
			}
		},
	};

	/**
	 * 适配器不许抛(ADR-0026 决策 1):真抛了算 bug,在这道边界接住并留 error 日志。探测、列地址这类没有副作用的
	 * 按「暂时不可用」记;`send` 抛了传 `"indeterminate"` —— 抛之前帧可能已经出去了,回「暂时不可用」会让
	 * 上面的人照「稍后可重试」再发一遍。
	 */
	function thrown(
		e: unknown,
		where: string,
		code: "unavailable" | "indeterminate" = "unavailable",
	) {
		const message = e instanceof Error ? e.message : String(e);
		log.error(`[sink] platform adapter threw (${where}): ${message}`);
		return fail(code, message);
	}

	async function dispatch(targetId: string, payload: NotificationPayload): Promise<DeliveryResult> {
		const target = findTarget(targetId);
		if (!target) return fail("not_found", "target not found");
		const route = routeOf(target.connectionId, undefined, (c) => refusal(target, c));
		if (!route.ok) {
			log.warn(`[sink] ${route.message} (target=${target.id})`);
			opts.onDelivery?.(target, payload, route);
			return route;
		}
		const result = await deliver(
			route.connection,
			route.adapter,
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
		adapter: SendableAdapter,
		destination: DestinationRef,
		target: PushTarget | undefined,
		payload: NotificationPayload,
	): Promise<DeliveryResult> {
		const intercepted = opts.interceptSend?.({ connection, destination, target, payload });
		if (intercepted) return intercepted;
		try {
			return await adapter.send(connection, destination, payload);
		} catch (e) {
			return thrown(e, `${target ? `target=${target.id}` : "sendToAddress"} send`, "indeterminate");
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
