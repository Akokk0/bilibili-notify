import {
	type Connection,
	connectionDispatchKey,
	type Disposable,
	type IntegrationContext,
	type PlatformAdapterContext,
} from "@bilibili-notify/internal";

export interface CreatePlatformAdapterContextOptions {
	/** 这个适配器所属集成的上下文(内置的由装配处现建,拓展的用拓展自己那份)。 */
	integration: IntegrationContext;
	adapterKey: string;
	/** 全部连接,现读。 */
	connections: () => readonly Connection[];
	/** 连接配置变了的订阅;交回的把手由调用方负责在集成停下时撤掉。 */
	onConnectionsChanged: (fn: () => void) => Disposable;
}

/**
 * 给一个适配器造它 `start` 时拿的上下文:集成上下文原样,加「归我的连接」(现读)与「变了叫我」。
 *
 * 「哪些连接归谁管」全仓只有 `connectionDispatchKey` 一个算法;内置与拓展两边共用这一个函数,
 * 免得写两遍。
 */
export function createPlatformAdapterContext(
	opts: CreatePlatformAdapterContextOptions,
): PlatformAdapterContext {
	const { integration, adapterKey } = opts;
	return {
		logger: integration.logger,
		signal: integration.signal,
		onDispose: integration.onDispose,
		connections: () =>
			opts.connections().filter((connection) => connectionDispatchKey(connection) === adapterKey),
		onConnectionsChanged: opts.onConnectionsChanged,
	};
}
