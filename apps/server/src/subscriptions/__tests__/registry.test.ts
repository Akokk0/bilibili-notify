import type { Source } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { createSourceRegistry } from "../registry.js";
import { makeIntegration, makeLogger, makeSource, SOURCE_KEY } from "./fixtures.js";

// 登记表只认 `SourceContext` 的形状;这里的上下文只用到 logger,其余不碰。
const ctxOf = () => {
	const logger = makeLogger();
	// biome-ignore lint/suspicious/noExplicitAny: 登记表测试只需要 logger
	return { logger, ctx: { ...makeIntegration(logger) } as any };
};

describe("createSourceRegistry", () => {
	it("登记即 start,get 查得到视图,没登的是 undefined", async () => {
		const registry = createSourceRegistry();
		const source = makeSource();
		const { ctx } = ctxOf();
		await registry.register(SOURCE_KEY, source, ctx);
		expect(source.started).toEqual([ctx]);
		expect(registry.get(SOURCE_KEY)?.descriptor).toBe(source.descriptor);
		expect(registry.get("other")).toBeUndefined();
	});

	it("视图里没有 start / stop", async () => {
		const registry = createSourceRegistry();
		await registry.register(SOURCE_KEY, makeSource(), ctxOf().ctx);
		const view = registry.get(SOURCE_KEY);
		expect(view).toBeDefined();
		expect(view && "start" in view).toBe(false);
		expect(view && "stop" in view).toBe(false);
	});

	it("键被占了就抛,原主人不动、新来源没被 start", async () => {
		const registry = createSourceRegistry();
		const first = makeSource();
		const second = makeSource();
		await registry.register(SOURCE_KEY, first, ctxOf().ctx);
		await expect(registry.register(SOURCE_KEY, second, ctxOf().ctx)).rejects.toThrow(
			`source for key "${SOURCE_KEY}" is already registered`,
		);
		expect(second.started).toHaveLength(0);
		expect(registry.get(SOURCE_KEY)?.descriptor).toBe(first.descriptor);
	});

	it("start 抛了:键放掉、错原样抛出去、能重登", async () => {
		const registry = createSourceRegistry();
		const broken: Source = {
			descriptor: {},
			start: () => Promise.reject(new Error("start-boom")),
			stop: async () => {},
		};
		await expect(registry.register(SOURCE_KEY, broken, ctxOf().ctx)).rejects.toThrow("start-boom");
		expect(registry.get(SOURCE_KEY)).toBeUndefined();
		await registry.register(SOURCE_KEY, makeSource(), ctxOf().ctx);
		expect(registry.get(SOURCE_KEY)).toBeDefined();
	});

	it("把手 dispose:放键并调 stop;幂等", async () => {
		const registry = createSourceRegistry();
		const source = makeSource();
		const handle = await registry.register(SOURCE_KEY, source, ctxOf().ctx);
		handle.dispose();
		handle.dispose();
		expect(registry.get(SOURCE_KEY)).toBeUndefined();
		expect(source.stops).toBe(1);
	});

	it("撤旧把手不踢新主人", async () => {
		const registry = createSourceRegistry();
		const oldHandle = await registry.register(SOURCE_KEY, makeSource(), ctxOf().ctx);
		oldHandle.dispose();
		const next = makeSource();
		await registry.register(SOURCE_KEY, next, ctxOf().ctx);
		oldHandle.dispose();
		expect(registry.get(SOURCE_KEY)?.descriptor).toBe(next.descriptor);
		expect(next.stops).toBe(0);
	});

	it("stop 失败只记一行 warn,不往外抛(同步抛与异步拒绝都一样)", async () => {
		const registry = createSourceRegistry();
		for (const stop of [
			() => {
				throw new Error("sync-boom");
			},
			() => Promise.reject(new Error("async-boom")),
		]) {
			const { ctx, logger } = ctxOf();
			const source: Source = { descriptor: {}, start: async () => {}, stop };
			const handle = await registry.register(SOURCE_KEY, source, ctx);
			expect(() => handle.dispose()).not.toThrow();
			await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledTimes(1));
			expect(logger.warn.mock.calls[0]?.[0]).toContain(`[source] ${SOURCE_KEY} stop 失败`);
		}
	});
});
