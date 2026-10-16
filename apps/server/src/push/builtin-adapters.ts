import type { Connection, Disposable, Logger, PlatformAdapter } from "@bilibili-notify/internal";
import {
	disposeThenClose,
	type IntegrationStore,
	type IntegrationStoreHandle,
} from "../integration-store/store.js";
import {
	type CreateIntegrationContextOptions,
	createIntegrationContext,
	type IntegrationContextHandle,
} from "../integrations/context.js";
import { createPlatformAdapterContext } from "./adapter-context.js";
import type { PlatformAdapterRegistry } from "./registry.js";

export interface RegisterBuiltinAdaptersOptions {
	registry: PlatformAdapterRegistry;
	/** 建好的内置适配器(工厂在装配处调,这里不认识 `platforms/` 下的任何东西)。 */
	adapters: readonly PlatformAdapter[];
	/** 按适配器键要它的日志器(标签与等级都跟那个键):建每个适配器的集成上下文时用 `adapter.adapterKey` 来要。 */
	loggerOf: (adapterKey: string) => Logger;
	/** 各适配器的 state / secrets 存储:登记前按 `adapterKey` 各开一份,停下后各关各的。 */
	stores: Pick<IntegrationStore, "open">;
	/** 问题表的写口:各适配器的集成上下文把 `reportProblem` 记到这里,报的人是各自的适配器键。 */
	problems: CreateIntegrationContextOptions["problems"];
	/** 全部连接,现读。 */
	connections: () => readonly Connection[];
	/** 连接配置变了的订阅。 */
	onConnectionsChanged: (fn: () => void) => Disposable;
}

export interface BuiltinAdapters {
	/** 逐个撤登记(触发 `stop`),再收各自的集成上下文、关存储把手;幂等。 */
	dispose(): Promise<void>;
}

/**
 * 内置适配器登记即启动:每个适配器各有一份集成上下文,包上「自己的连接」后交给登记表 `start`。
 * 启动时刻就是今天「引擎开机对账」的那一刻 —— 调用方在 `createEngines` 之前调它。
 *
 * 异步:`get` 是同步的,所以每个适配器的存储要先读盘,读完才登记。
 */
export async function registerBuiltinAdapters(
	opts: RegisterBuiltinAdaptersOptions,
): Promise<BuiltinAdapters> {
	const entries: Array<{ registration: Disposable; dispose: () => Promise<void> }> = [];
	for (const adapter of opts.adapters) {
		let handle: IntegrationStoreHandle | undefined;
		let integration: IntegrationContextHandle | undefined;
		try {
			const stores = await opts.stores.open(adapter.adapterKey);
			handle = stores;
			const context = createIntegrationContext({
				logger: opts.loggerOf(adapter.adapterKey),
				stopReason: "BN 关停",
				state: stores.state,
				secrets: stores.secrets,
				problems: opts.problems,
				reporter: adapter.adapterKey,
				rejectedProblemLevel: "error",
			});
			integration = context;
			const ctx = createPlatformAdapterContext({
				integration: context.ctx,
				adapterKey: adapter.adapterKey,
				settingsSchema: adapter.settingsSchema,
				connections: opts.connections,
				// 订阅交回的把手记进这份集成上下文:适配器停下时订阅自动摘掉。
				onConnectionsChanged: (fn) => context.track(opts.onConnectionsChanged(fn)),
				problems: opts.problems,
				rejectedProblemLevel: "error",
			});
			entries.push({
				registration: opts.registry.register(adapter, ctx),
				dispose: () => disposeThenClose(context, stores),
			});
		} catch (err) {
			// 登记失败不留半个:已登记的先收回,再把错抛出去。
			if (integration && handle) void disposeThenClose(integration, handle);
			else handle?.close();
			for (const entry of entries.splice(0).reverse()) {
				entry.registration.dispose();
				void entry.dispose();
			}
			throw err;
		}
	}

	let disposed = false;
	return {
		async dispose() {
			if (disposed) return;
			disposed = true;
			// 与今天关停时的次序一致:按登记的先后逐个收。
			for (const entry of entries.splice(0)) {
				entry.registration.dispose();
				await entry.dispose();
			}
		},
	};
}
