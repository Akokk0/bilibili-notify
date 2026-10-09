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
import { describe, expect, it } from "vite-plus/test";
import { adapterForConnection } from "../dispatch.js";
import {
	createPlatformAdapterRegistry,
	deriveAdapterRegistry,
	sendableAdapters,
} from "../registry.js";

function fakeAdapter(...platforms: string[]): PlatformAdapter {
	return {
		platforms,
		isAvailable: () => true,
		send: async () => ({ ok: true, latencyMs: 1 }),
	} as unknown as PlatformAdapter;
}

function extensionConnection(extensionId: string): Connection {
	return {
		id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		name: "x",
		enabled: true,
		kind: "extension",
		extensionId,
		config: {},
	} as Connection;
}

describe("adapter 注册表", () => {
	it("开机那几个照旧,注册进来的也在", () => {
		const builtin = fakeAdapter("onebot");
		const registry = createPlatformAdapterRegistry([builtin]);
		expect(registry.list().map((a) => a.platforms)).toEqual([["onebot"]]);

		const bridge = fakeAdapter("bridge");
		registry.register(bridge);
		expect(registry.list().map((a) => a.platforms)).toEqual([["onebot"], ["bridge"]]);
		expect(sendableAdapters(registry)).toEqual([builtin, bridge]);
	});

	it("**分发那一刻现问** —— 早就拿到注册表的消费者,下一次问就看得见新注册的", () => {
		const registry = createPlatformAdapterRegistry();
		// 消费方只握着注册表,不握着某一次的结果。
		const route = (connection: Connection) => adapterForConnection(registry.list(), connection);
		expect(route(extensionConnection("bridge"))).toBeUndefined();

		registry.register(fakeAdapter("bridge"));
		expect(route(extensionConnection("bridge"))?.platforms).toEqual(["bridge"]);
	});

	it("撤下之后就找不到了 —— 卸载一个拓展 = 从表里删一行", () => {
		const registry = createPlatformAdapterRegistry();
		const handle = registry.register(fakeAdapter("bridge"));
		expect(adapterForConnection(registry.list(), extensionConnection("bridge"))).toBeDefined();

		handle.dispose();
		expect(adapterForConnection(registry.list(), extensionConnection("bridge"))).toBeUndefined();
		expect(registry.list()).toEqual([]);
	});

	it("键被占了 → 抛。**不许悄悄顶掉** —— 那等于把别人的连接整个截走", () => {
		const registry = createPlatformAdapterRegistry([fakeAdapter("onebot")]);
		expect(() => registry.register(fakeAdapter("onebot"))).toThrow(/onebot/);
	});

	it("撤下之后同一个键可以重来 —— 停用再启用走的就是这条", () => {
		const registry = createPlatformAdapterRegistry();
		registry.register(fakeAdapter("bridge")).dispose();
		const second = fakeAdapter("bridge");
		registry.register(second);
		expect(sendableAdapters(registry)).toEqual([second]);
		expect(adapterForConnection(registry.list(), extensionConnection("bridge"))).toBeDefined();
	});

	it("一个 adapter 认领好几个键(webhook 那族)—— 一起进,一起走", () => {
		const registry = createPlatformAdapterRegistry();
		const handle = registry.register(fakeAdapter("feishu", "dingtalk"));
		expect(() => registry.register(fakeAdapter("dingtalk"))).toThrow(/dingtalk/);
		handle.dispose();
		// 撤下之后两个键都空出来了。
		expect(() => registry.register(fakeAdapter("feishu", "dingtalk"))).not.toThrow();
	});

	it("dispose 是幂等的", () => {
		const registry = createPlatformAdapterRegistry();
		const handle = registry.register(fakeAdapter("bridge"));
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
		const registry = createPlatformAdapterRegistry([fakeAdapter("onebot")]);
		const [view] = registry.list();
		expect(view).toBeDefined();
		expect("send" in (view as object)).toBe(false);
		expect(view?.platforms).toEqual(["onebot"]);
	});

	it("同一个适配器两次 list() 回同一个视图对象", () => {
		const registry = createPlatformAdapterRegistry([fakeAdapter("onebot")]);
		expect(registry.list()[0]).toBe(registry.list()[0]);
	});

	it("sendableAdapters 回的是带 send 的原适配器", () => {
		const onebot = fakeAdapter("onebot");
		const registry = createPlatformAdapterRegistry([onebot]);
		expect(sendableAdapters(registry)).toEqual([onebot]);
		expect(typeof sendableAdapters(registry)[0]?.send).toBe("function");
	});

	it("不是我们造的登记表 → 抛,不静默回空", () => {
		expect(() =>
			sendableAdapters({ register: () => ({ dispose() {} }), list: () => [] }),
		).toThrow();
	});

	describe("派生表(devtools 往出口上套能力注入走这里)", () => {
		const tagged = (view: Omit<PlatformAdapter, "send">) => ({ ...view, tag: "wrapped" });

		it("后注册的适配器,派生表上看得见,派发器取的完整适配器里也有(带原 send、带包装)", () => {
			const base = createPlatformAdapterRegistry();
			const derived = deriveAdapterRegistry(base, tagged);
			expect(derived.list()).toEqual([]);

			const late = fakeAdapter("bridge");
			derived.register(late); // 注册转交给原表
			expect(base.list()).toHaveLength(1);

			expect(derived.list()).toHaveLength(1);
			expect((derived.list()[0] as unknown as { tag: string }).tag).toBe("wrapped");
			const [full] = sendableAdapters(derived);
			expect(full?.send).toBe(late.send);
			expect((full as unknown as { tag: string }).tag).toBe("wrapped");
		});

		it("同一个出口两次问到的是同一个对象(视图与完整适配器各自稳定)", () => {
			const base = createPlatformAdapterRegistry([fakeAdapter("onebot")]);
			const derived = deriveAdapterRegistry(base, tagged);
			expect(derived.list()[0]).toBe(derived.list()[0]);
			expect(sendableAdapters(derived)[0]).toBe(sendableAdapters(derived)[0]);
		});

		it("撤下之后派生表上也没了", () => {
			const base = createPlatformAdapterRegistry();
			const derived = deriveAdapterRegistry(base, tagged);
			const handle = derived.register(fakeAdapter("bridge"));
			handle.dispose();
			expect(derived.list()).toEqual([]);
			expect(sendableAdapters(derived)).toEqual([]);
		});
	});
});
