/**
 * 单元测试 — 独立端 `createNodeMessageBus`。
 *
 * 守护契约:
 *   - emit → 每个 on 监听器恰一次(沿用 koishi/runtime message-bus.test.ts 的
 *     核心不变量,独立端同形)
 *   - dispose 后不再收到
 *   - A4 防御兜底:若注册了 async handler 且 reject,不得逃逸成 unhandled
 *     rejection —— 兜成一条 console.error(该 infra 原语不持 logger)
 */

import type { BiliEvents } from "@bilibili-notify/internal";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createNodeMessageBus } from "../message-bus";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("createNodeMessageBus", () => {
	it("emit 触发每个监听器恰一次;dispose 后不再触发", () => {
		const bus = createNodeMessageBus();
		const h1 = vi.fn();
		const h2 = vi.fn();
		const d1 = bus.on("ready", h1 as unknown as BiliEvents["ready"]);
		bus.on("ready", h2 as unknown as BiliEvents["ready"]);

		bus.emit("ready");
		expect(h1).toHaveBeenCalledTimes(1);
		expect(h2).toHaveBeenCalledTimes(1);

		d1.dispose();
		bus.emit("ready");
		expect(h1).toHaveBeenCalledTimes(1); // 已 dispose,不再涨
		expect(h2).toHaveBeenCalledTimes(2);
	});

	it("A4:async handler reject → 不成 unhandled,兜成 console.error", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const bus = createNodeMessageBus();
		// BiliEvents handler 类型上同步;此处 as 强转模拟某处注册了 async handler。
		bus.on("ready", (async () => {
			throw new Error("boom");
		}) as unknown as BiliEvents["ready"]);

		expect(() => bus.emit("ready")).not.toThrow();
		// 等 microtask 链:wrapped 捕获 thenable 后 .catch → console.error。
		await Promise.resolve();
		await Promise.resolve();

		expect(errSpy).toHaveBeenCalledWith(
			expect.stringContaining('async handler for "ready" rejected'),
			expect.any(Error),
		);
	});

	it("同步 handler 抛出语义不变(仍向 emit 调用方传播,未被 try/catch 吞)", () => {
		const bus = createNodeMessageBus();
		bus.on("ready", (() => {
			throw new Error("sync-throw");
		}) as unknown as BiliEvents["ready"]);
		expect(() => bus.emit("ready")).toThrow(/sync-throw/);
	});
});
