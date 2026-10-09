/**
 * 适配器拿到的上下文 —— 集成上下文加「现读的自己的连接名单」与「变了叫我」。
 *
 * 「哪些连接归它」的算法全仓只有一个(`connectionDispatchKey`),内置与拓展两边共用这一个函数,
 * 免得写两遍。
 */

import type { Connection, Disposable } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { createIntegrationContext } from "../../integrations/context.js";
import { createPlatformAdapterContext } from "../adapter-context.js";

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function direct(id: string, platform: string): Connection {
	return {
		id,
		name: id,
		enabled: true,
		kind: "direct",
		platform,
		config: {},
	} as unknown as Connection;
}

function extensionConn(id: string, extensionId: string): Connection {
	return {
		id,
		name: id,
		enabled: true,
		kind: "extension",
		extensionId,
		config: {},
	} as unknown as Connection;
}

function build(key: string, list: () => readonly Connection[], on = () => ({ dispose() {} })) {
	const handle = createIntegrationContext({ logger: silentLogger, stopReason: "测试" });
	const ctx = createPlatformAdapterContext({
		integration: handle.ctx,
		adapterKey: key,
		connections: list,
		onConnectionsChanged: on,
	});
	return { handle, ctx };
}

describe("createPlatformAdapterContext", () => {
	const all: Connection[] = [
		direct("a", "onebot"),
		direct("b", "qq-official"),
		direct("c", "feishu"),
		direct("d", "dingtalk"),
		direct("e", "wecom"),
		direct("f", "webhook"),
		extensionConn("g", "bridge"),
		extensionConn("h", "matrix"),
	];

	it("connections() 只回分发键等于 adapterKey 的连接 —— onebot", () => {
		const { ctx } = build("onebot", () => all);
		expect(ctx.connections().map((c) => c.id)).toEqual(["a"]);
	});

	it('webhook 那一族四个平台都归 "webhook"', () => {
		const { ctx } = build("webhook", () => all);
		expect(ctx.connections().map((c) => c.id)).toEqual(["c", "d", "e", "f"]);
	});

	it("拓展连接归拓展 id", () => {
		const { ctx } = build("bridge", () => all);
		expect(ctx.connections().map((c) => c.id)).toEqual(["g"]);
	});

	it("现读:名单改了,下一次读到的就是新的", () => {
		let list: readonly Connection[] = [direct("a", "onebot")];
		const { ctx } = build("onebot", () => list);
		expect(ctx.connections().map((c) => c.id)).toEqual(["a"]);
		list = [direct("a", "onebot"), direct("z", "onebot")];
		expect(ctx.connections().map((c) => c.id)).toEqual(["a", "z"]);
		list = [];
		expect(ctx.connections()).toEqual([]);
	});

	it("logger / signal / onDispose 就是 integration 上的那三个", () => {
		const { handle, ctx } = build("onebot", () => all);
		expect(ctx.logger).toBe(handle.ctx.logger);
		expect(ctx.signal).toBe(handle.ctx.signal);
		expect(ctx.onDispose).toBe(handle.ctx.onDispose);
	});

	it("onConnectionsChanged 原样转交 —— 回调与交回的把手都是传进去的那一份", () => {
		const handle: Disposable = { dispose: vi.fn() };
		const on = vi.fn(() => handle);
		const { ctx } = build("onebot", () => all, on);
		const fn = () => {};
		const returned = ctx.onConnectionsChanged(fn);
		expect(on).toHaveBeenCalledWith(fn);
		expect(returned).toBe(handle);
	});
});
