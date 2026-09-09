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

import type { Connection } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { adapterForConnection } from "../dispatch.js";
import { createAdapterRegistry } from "../registry.js";
import type { PlatformAdapter } from "../types.js";

function fakeAdapter(...platforms: string[]): PlatformAdapter {
	return { platforms, isAvailable: () => true } as unknown as PlatformAdapter;
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
		const registry = createAdapterRegistry([builtin]);
		expect(registry.list()).toEqual([builtin]);

		const bridge = fakeAdapter("bridge");
		registry.register(bridge);
		expect(registry.list()).toEqual([builtin, bridge]);
	});

	it("**分发那一刻现问** —— 早就拿到注册表的消费者,下一次问就看得见新注册的", () => {
		const registry = createAdapterRegistry();
		// 消费方只握着注册表,不握着某一次的结果。
		const route = (connection: Connection) => adapterForConnection(registry.list(), connection);
		expect(route(extensionConnection("bridge"))).toBeUndefined();

		const bridge = fakeAdapter("bridge");
		registry.register(bridge);
		expect(route(extensionConnection("bridge"))).toBe(bridge);
	});

	it("撤下之后就找不到了 —— 卸载一个拓展 = 从表里删一行", () => {
		const registry = createAdapterRegistry();
		const handle = registry.register(fakeAdapter("bridge"));
		expect(adapterForConnection(registry.list(), extensionConnection("bridge"))).toBeDefined();

		handle.dispose();
		expect(adapterForConnection(registry.list(), extensionConnection("bridge"))).toBeUndefined();
		expect(registry.list()).toEqual([]);
	});

	it("键被占了 → 抛。**不许悄悄顶掉** —— 那等于把别人的连接整个截走", () => {
		const registry = createAdapterRegistry([fakeAdapter("onebot")]);
		expect(() => registry.register(fakeAdapter("onebot"))).toThrow(/onebot/);
	});

	it("撤下之后同一个键可以重来 —— 停用再启用走的就是这条", () => {
		const registry = createAdapterRegistry();
		registry.register(fakeAdapter("bridge")).dispose();
		const second = fakeAdapter("bridge");
		registry.register(second);
		expect(adapterForConnection(registry.list(), extensionConnection("bridge"))).toBe(second);
	});

	it("一个 adapter 认领好几个键(webhook 那族)—— 一起进,一起走", () => {
		const registry = createAdapterRegistry();
		const handle = registry.register(fakeAdapter("feishu", "dingtalk"));
		expect(() => registry.register(fakeAdapter("dingtalk"))).toThrow(/dingtalk/);
		handle.dispose();
		// 撤下之后两个键都空出来了。
		expect(() => registry.register(fakeAdapter("feishu", "dingtalk"))).not.toThrow();
	});

	it("dispose 是幂等的", () => {
		const registry = createAdapterRegistry();
		const handle = registry.register(fakeAdapter("bridge"));
		handle.dispose();
		expect(() => handle.dispose()).not.toThrow();
		expect(registry.list()).toEqual([]);
	});
});
