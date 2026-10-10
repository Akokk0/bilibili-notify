/**
 * 造一份假的适配器上下文(`PlatformAdapterContext`)—— 适配器的 `start(ctx)` 拿它起来。
 *
 * - `ctx.connections()` 现读 `setConnections` 最后给的那份(不按分发键筛:测试自己递的就是「自己的」)。
 * - `ctx.onConnectionsChanged(fn)` 把回调记下;`fireChanged()` 叫一遍当前还登记着的回调,
 *   就是生产里「连接配置变了」那一声。交回的把手摘掉那一个回调。
 * - `ctx.signal` 是 `abort()` 时中止的那个;`disposeHooks()` 按后登记先跑的次序跑一遍 `ctx.onDispose` 登记的钩子。
 */

import type {
	Connection,
	Disposable,
	Logger,
	PlatformAdapter,
	PlatformAdapterContext,
} from "@bilibili-notify/internal";
import {
	createPlatformAdapterRegistry,
	type PlatformAdapterRegistry,
} from "../../push/registry.js";
import { memoryStores } from "./memory-key-value-store.js";

export interface FakeAdapterContext {
	readonly ctx: PlatformAdapterContext;
	setConnections(next: readonly Connection[]): void;
	/** 叫一遍还登记着的「连接变了」回调。 */
	fireChanged(): void;
	/** 现在登记着几个「连接变了」回调。 */
	listenerCount(): number;
	/** 中止 `ctx.signal`。 */
	abort(): void;
	/** 后登记的先跑,跑 `ctx.onDispose` 登记的钩子。 */
	runDisposeHooks(): Promise<void>;
}

function silentLogger(): Logger {
	const noop = () => {};
	return { info: noop, warn: noop, error: noop, debug: noop };
}

export function fakeAdapterContext(
	initial: readonly Connection[] = [],
	logger: Logger = silentLogger(),
): FakeAdapterContext {
	let connections = initial;
	const listeners = new Set<() => void>();
	const hooks: Array<() => void | Promise<void>> = [];
	const controller = new AbortController();
	const { state, secrets } = memoryStores();
	const ctx: PlatformAdapterContext = {
		logger,
		signal: controller.signal,
		onDispose(fn) {
			hooks.push(fn);
		},
		state,
		secrets,
		connections: () => connections,
		onConnectionsChanged(fn): Disposable {
			listeners.add(fn);
			return { dispose: () => listeners.delete(fn) };
		},
	};
	return {
		ctx,
		setConnections(next) {
			connections = next;
		},
		fireChanged() {
			for (const fn of [...listeners]) fn();
		},
		listenerCount: () => listeners.size,
		abort: () => controller.abort(),
		async runDisposeHooks() {
			for (const fn of [...hooks].reverse()) await fn();
		},
	};
}

const driven = new WeakMap<object, FakeAdapterContext>();

/**
 * 测试里「让这个适配器对账到这份名单」的写法:第一次是 `start(ctx)`(ctx.connections() 回这份名单),
 * 之后是「改名单、再触发 `ctx.onConnectionsChanged` 登记的回调」—— 与生产里登记表 / 连接变更的路径一致。
 */
export function reconcileAdapter(
	adapter: { start(ctx: PlatformAdapterContext): void },
	connections: readonly Connection[],
): void {
	const existing = driven.get(adapter);
	if (existing) {
		existing.setConnections(connections);
		existing.fireChanged();
		return;
	}
	const fake = fakeAdapterContext(connections);
	driven.set(adapter, fake);
	adapter.start(fake.ctx);
}

/** 登记好这几个适配器(逐个 `register`,上下文用假的)的登记表。键重复会抛,与生产一致。 */
export function registryOf(adapters: readonly PlatformAdapter[]): PlatformAdapterRegistry {
	const registry = createPlatformAdapterRegistry();
	for (const adapter of adapters) registry.register(adapter, fakeAdapterContext().ctx);
	return registry;
}
