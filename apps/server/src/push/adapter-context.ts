import type {
	Connection,
	Disposable,
	IntegrationContext,
	PlatformAdapterContext,
} from "@bilibili-notify/internal";
import type { ZodType } from "zod";
import { resolveSettings, settingsIssueMessage } from "./connection-settings.js";

export interface CreatePlatformAdapterContextOptions {
	/** 这个适配器所属集成的上下文(内置的由装配处现建,拓展的用拓展自己那份)。 */
	integration: IntegrationContext;
	adapterKey: string;
	/** 这个适配器的 settings 规则 —— `connections()` 递出去之前先按它解一遍。 */
	settingsSchema: ZodType;
	/** 全部连接,现读。 */
	connections: () => readonly Connection[];
	/** 连接配置变了的订阅;交回的把手由调用方负责在集成停下时撤掉。 */
	onConnectionsChanged: (fn: () => void) => Disposable;
}

/**
 * 给一个适配器造它 `start` 时拿的上下文:集成上下文原样,加「归我的连接」(现读)与「变了叫我」。
 *
 * 「哪些连接归谁管」全仓只有 `adapterKey` 一个算法;内置与拓展两边共用这一个函数,免得写两遍。
 *
 * `connections()` 递出去的每一条,`settings` 都是按适配器的规则解过的输出;过不了规则的连接被隔离 ——
 * 不递给适配器,原因记一行 `warn`(同一条连接同一条原因只记一次;原因变了、或好了之后再坏,再记)。
 */
export function createPlatformAdapterContext(
	opts: CreatePlatformAdapterContextOptions,
): PlatformAdapterContext {
	const { integration, adapterKey, settingsSchema } = opts;
	/** 连接 id → 最近一次记过的隔离原因。 */
	const warned = new Map<string, string>();
	return {
		logger: integration.logger,
		signal: integration.signal,
		onDispose: integration.onDispose,
		state: integration.state,
		secrets: integration.secrets,
		connections: () => {
			const mine: Connection[] = [];
			const stillBroken = new Set<string>();
			for (const connection of opts.connections()) {
				if (connection.adapterKey !== adapterKey) continue;
				const resolved = resolveSettings(settingsSchema, connection.settings);
				if (resolved.ok) {
					mine.push({ ...connection, settings: resolved.settings });
					continue;
				}
				stillBroken.add(connection.id);
				const reason = settingsIssueMessage(resolved.issues ?? []);
				if (warned.get(connection.id) !== reason) {
					warned.set(connection.id, reason);
					integration.logger.warn(
						`[connection] 连接「${connection.name}」(${connection.id})${reason},先不交给适配器 ${adapterKey}`,
					);
				}
			}
			// 好了的、没了的:忘掉,下次再坏会再记一次。
			for (const id of [...warned.keys()]) if (!stillBroken.has(id)) warned.delete(id);
			return mine;
		},
		onConnectionsChanged: opts.onConnectionsChanged,
	};
}
