/**
 * adapter 矩阵 —— **活的注册表**(ADR-0012 决策 29)。
 *
 * 从前它是开机拼好的一个数组:拓展是后加载的,而且要能被拨开关加载 / 卸载,一个定死的
 * 数组两件事都干不了。
 *
 * 两条纪律钉在这里:**消费方在分发那一刻现问**(存一份下来就等于回到那个数组),以及
 * **键被占了就抛** —— 一个拓展要是能声明 `"onebot"`,它就把内置的那条连接整个截走了,
 * 而两边都不会报错。
 */

import type { Connection, PlatformAdapter } from "@bilibili-notify/internal";
import { neutralPlatformSnapshot } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { fakeAdapterContext } from "../../__tests__/support/adapter-ctx.js";
import { adapterForConnection } from "../dispatch.js";
import {
	createPlatformAdapterRegistry,
	deriveAdapterRegistry,
	sendableAdapters,
} from "../registry.js";

function fakeAdapter(adapterKey: string): PlatformAdapter {
	return {
		adapterKey,
		isAvailable: () => true,
		send: async () => ({ ok: true, latencyMs: 1 }),
		start: vi.fn(),
		stop: vi.fn(),
	} as unknown as PlatformAdapter;
}

/** 登记表上登记一个适配器(上下文用假的)。 */
function reg(registry: ReturnType<typeof createPlatformAdapterRegistry>, adapter: PlatformAdapter) {
	return registry.register(adapter, fakeAdapterContext().ctx);
}

/** 先登记好这几个的登记表。 */
function registryWith(...adapters: PlatformAdapter[]) {
	const registry = createPlatformAdapterRegistry();
	for (const adapter of adapters) reg(registry, adapter);
	return registry;
}

function extensionConnection(extensionId: string): Connection {
	return {
		id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		name: "x",
		enabled: true,
		adapterKey: extensionId,
		platform: "telegram",
		settings: {},
		platformSnapshot: neutralPlatformSnapshot("telegram"),
	};
}

describe("adapter 注册表", () => {
	it("开机那几个照旧,注册进来的也在", () => {
		const builtin = fakeAdapter("onebot");
		const registry = registryWith(builtin);
		expect(registry.list().map((a) => a.adapterKey)).toEqual(["onebot"]);

		const bridge = fakeAdapter("bridge");
		reg(registry, bridge);
		expect(registry.list().map((a) => a.adapterKey)).toEqual(["onebot", "bridge"]);
		expect(sendableAdapters(registry)).toEqual([builtin, bridge]);
	});

	it("**分发那一刻现问** —— 早就拿到注册表的消费者,下一次问就看得见新注册的", () => {
		const registry = createPlatformAdapterRegistry();
		// 消费方只握着注册表,不握着某一次的结果。
		const route = (connection: Connection) => adapterForConnection(registry.list(), connection);
		expect(route(extensionConnection("bridge"))).toBeUndefined();

		reg(registry, fakeAdapter("bridge"));
		expect(route(extensionConnection("bridge"))?.adapterKey).toBe("bridge");
	});

	it("撤下之后就找不到了 —— 卸载一个拓展 = 从表里删一行", () => {
		const registry = createPlatformAdapterRegistry();
		const handle = reg(registry, fakeAdapter("bridge"));
		expect(adapterForConnection(registry.list(), extensionConnection("bridge"))).toBeDefined();

		handle.dispose();
		expect(adapterForConnection(registry.list(), extensionConnection("bridge"))).toBeUndefined();
		expect(registry.list()).toEqual([]);
	});

	it("键被占了 → 抛。**不许悄悄顶掉** —— 那等于把别人的连接整个截走", () => {
		const registry = registryWith(fakeAdapter("onebot"));
		expect(() => reg(registry, fakeAdapter("onebot"))).toThrow(/onebot/);
	});

	it("撤下之后同一个键可以重来 —— 停用再启用走的就是这条", () => {
		const registry = createPlatformAdapterRegistry();
		reg(registry, fakeAdapter("bridge")).dispose();
		const second = fakeAdapter("bridge");
		reg(registry, second);
		expect(sendableAdapters(registry)).toEqual([second]);
		expect(adapterForConnection(registry.list(), extensionConnection("bridge"))).toBeDefined();
	});

	it("webhook 键被占了 → 抛 —— 四个 webhook 平台共用这一个键", () => {
		const registry = registryWith(fakeAdapter("webhook"));
		expect(() => reg(registry, fakeAdapter("webhook"))).toThrow(/webhook/);
	});

	it("dispose 是幂等的", () => {
		const registry = createPlatformAdapterRegistry();
		const handle = reg(registry, fakeAdapter("bridge"));
		handle.dispose();
		expect(() => handle.dispose()).not.toThrow();
		expect(registry.list()).toEqual([]);
	});
});

/**
 * 出口咽喉:登记表对外只给不含 `send` 的视图,带 `send` 的完整适配器只有 `sendableAdapters` 一个取法
 * (全仓只许派发器引它,那条由源码扫描守卫钉)。
 */
describe("adapter 注册表 · 出口咽喉", () => {
	it("list() 回的元素没有 send —— 类型上没有,运行时也真的没有", () => {
		const registry = registryWith(fakeAdapter("onebot"));
		const [view] = registry.list();
		expect(view).toBeDefined();
		expect("send" in (view as object)).toBe(false);
		expect(view?.adapterKey).toBe("onebot");
	});

	it("同一个适配器两次 list() 回同一个视图对象", () => {
		const registry = registryWith(fakeAdapter("onebot"));
		expect(registry.list()[0]).toBe(registry.list()[0]);
	});

	it("sendableAdapters 回的是带 send 的原适配器", () => {
		const onebot = fakeAdapter("onebot");
		const registry = registryWith(onebot);
		expect(sendableAdapters(registry)).toEqual([onebot]);
		expect(typeof sendableAdapters(registry)[0]?.send).toBe("function");
	});

	it("不是我们造的登记表 → 抛,不静默回空", () => {
		expect(() =>
			sendableAdapters({ register: () => ({ dispose() {} }), list: () => [] }),
		).toThrow();
	});

	describe("派生表(devtools 往出口上套能力注入走这里)", () => {
		const tagged = (view: Omit<PlatformAdapter, "send" | "start" | "stop">) => ({
			...view,
			tag: "wrapped",
		});

		it("后注册的适配器,派生表上看得见,派发器取的完整适配器里也有(带原 send、带包装)", () => {
			const base = createPlatformAdapterRegistry();
			const derived = deriveAdapterRegistry(base, tagged);
			expect(derived.list()).toEqual([]);

			const late = fakeAdapter("bridge");
			derived.register(late, fakeAdapterContext().ctx); // 注册转交给原表
			expect(base.list()).toHaveLength(1);

			expect(derived.list()).toHaveLength(1);
			expect((derived.list()[0] as unknown as { tag: string }).tag).toBe("wrapped");
			const [full] = sendableAdapters(derived);
			expect(full?.send).toBe(late.send);
			expect((full as unknown as { tag: string }).tag).toBe("wrapped");
		});

		it("同一个出口两次问到的是同一个对象(视图与完整适配器各自稳定)", () => {
			const base = registryWith(fakeAdapter("onebot"));
			const derived = deriveAdapterRegistry(base, tagged);
			expect(derived.list()[0]).toBe(derived.list()[0]);
			expect(sendableAdapters(derived)[0]).toBe(sendableAdapters(derived)[0]);
		});

		it("撤下之后派生表上也没了", () => {
			const base = createPlatformAdapterRegistry();
			const derived = deriveAdapterRegistry(base, tagged);
			const handle = derived.register(fakeAdapter("bridge"), fakeAdapterContext().ctx);
			handle.dispose();
			expect(derived.list()).toEqual([]);
			expect(sendableAdapters(derived)).toEqual([]);
		});
	});
});

/** 登记即启动、注销即停止(ADR-0024 决策 3):启停只归登记表。 */
describe("adapter 注册表 · 登记即 start、注销即 stop", () => {
	it("登记即调 start,拿到的就是传进去的那份 ctx", () => {
		const registry = createPlatformAdapterRegistry();
		const adapter = fakeAdapter("bridge");
		const { ctx } = fakeAdapterContext();
		registry.register(adapter, ctx);
		expect(adapter.start).toHaveBeenCalledTimes(1);
		expect(adapter.start).toHaveBeenCalledWith(ctx);
	});

	it("start 抛了 → 原样抛出,键放掉、表里没有它、同一个键能再登记", () => {
		const registry = createPlatformAdapterRegistry();
		const broken = fakeAdapter("bridge");
		const boom = new Error("boom");
		vi.mocked(broken.start).mockImplementation(() => {
			throw boom;
		});
		expect(() => registry.register(broken, fakeAdapterContext().ctx)).toThrow(boom);
		expect(registry.list()).toEqual([]);
		expect(sendableAdapters(registry)).toEqual([]);

		const again = fakeAdapter("bridge");
		reg(registry, again);
		expect(again.start).toHaveBeenCalledTimes(1);
		expect(registry.list().map((a) => a.adapterKey)).toEqual(["bridge"]);
	});

	it("把手 dispose 调一次 stop,再调不重复", () => {
		const registry = createPlatformAdapterRegistry();
		const adapter = fakeAdapter("bridge");
		const handle = reg(registry, adapter);
		expect(adapter.stop).not.toHaveBeenCalled();
		handle.dispose();
		handle.dispose();
		expect(adapter.stop).toHaveBeenCalledTimes(1);
	});

	it("stop 同步抛了 → 不往外抛,用 ctx.logger.warn 记一行", () => {
		const registry = createPlatformAdapterRegistry();
		const adapter = fakeAdapter("bridge");
		vi.mocked(adapter.stop).mockImplementation(() => {
			throw new Error("sync-fail");
		});
		const warn = vi.fn();
		const { ctx } = fakeAdapterContext([], { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() });
		const handle = registry.register(adapter, ctx);
		expect(() => handle.dispose()).not.toThrow();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("sync-fail");
		// 抛了也已经摘掉、放了键。
		expect(registry.list()).toEqual([]);
	});

	it("stop 回一个失败的 Promise → 不往外抛、不等它,失败落下来时记一行 warn", async () => {
		const registry = createPlatformAdapterRegistry();
		const adapter = fakeAdapter("bridge");
		vi.mocked(adapter.stop).mockImplementation(() => Promise.reject(new Error("async-fail")));
		const warn = vi.fn();
		const { ctx } = fakeAdapterContext([], { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() });
		const handle = registry.register(adapter, ctx);
		expect(() => handle.dispose()).not.toThrow();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("async-fail");
	});

	it("stop 回一个非原生 thenable(reject)→ 同样不往外抛,失败落下来时记一行 warn", async () => {
		const registry = createPlatformAdapterRegistry();
		const adapter = fakeAdapter("bridge");
		vi.mocked(adapter.stop).mockImplementation(
			() =>
				({
					// biome-ignore lint/suspicious/noThenProperty: 故意造一个非原生的 thenable
					then(_resolve: (v: unknown) => void, reject: (e: unknown) => void) {
						reject(new Error("thenable-fail"));
					},
				}) as unknown as Promise<void>,
		);
		const warn = vi.fn();
		const { ctx } = fakeAdapterContext([], { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() });
		const handle = registry.register(adapter, ctx);
		expect(() => handle.dispose()).not.toThrow();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("thenable-fail");
	});

	it("视图上没有 send / start / stop —— 启停只归登记表,运行时也真的没有", () => {
		const registry = registryWith(fakeAdapter("onebot"));
		const [view] = registry.list();
		for (const name of ["send", "start", "stop"]) expect(name in (view as object)).toBe(false);
	});

	it("派生表的 register 把 ctx 原样转交", () => {
		const base = createPlatformAdapterRegistry();
		const derived = deriveAdapterRegistry(base, (view) => view);
		const adapter = fakeAdapter("bridge");
		const { ctx } = fakeAdapterContext();
		derived.register(adapter, ctx);
		expect(adapter.start).toHaveBeenCalledWith(ctx);
	});
});
