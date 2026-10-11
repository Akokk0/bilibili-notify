import type { PostEvent, PostReport } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { createSourceContext } from "../source-context.js";
import { makeIntegration, makeLogger, makeSub, makeWorld, SOURCE_KEY } from "./fixtures.js";

const report = (postId = "p1"): PostReport => ({
	postId,
	url: `https://example.test/${postId}`,
	post: { creator: { name: "UP" }, publishedAt: "2026-01-01T00:00:00.000Z", text: "hi" },
});

const setup = (subs = [makeSub("a", "1")]) => {
	const world = makeWorld(subs);
	const logger = makeLogger();
	const enqueue = vi.fn<(event: PostEvent) => void>();
	const handle = createSourceContext({
		integration: makeIntegration(),
		sourceKey: SOURCE_KEY,
		descriptor: { postNoun: "动态" },
		subscriptions: world.store,
		defaults: () => world.globals.defaults,
		bus: world.bus,
		logger,
		enqueue,
	});
	return { ...world, logger, enqueue, handle };
};

describe("createSourceContext", () => {
	it("交出去的上下文只有公共五格加来源的三个方法:没有 http 与 cookies", () => {
		const { handle } = setup();
		expect(Object.keys(handle.ctx).sort()).toEqual([
			"logger",
			"onDispose",
			"onSubscriptionsChanged",
			"reportPost",
			"secrets",
			"signal",
			"state",
			"subscriptions",
		]);
		expect("http" in handle.ctx).toBe(false);
		expect("cookies" in handle.ctx).toBe(false);
	});

	it("ctx.logger 是宿主入参给的那个,不是集成上下文自带的", () => {
		const hostLogger = makeLogger();
		const integrationLogger = makeLogger();
		const handle = createSourceContext({
			integration: makeIntegration(integrationLogger),
			sourceKey: SOURCE_KEY,
			descriptor: { postNoun: "动态" },
			subscriptions: makeWorld().store,
			defaults: () => makeWorld().globals.defaults,
			bus: makeWorld().bus,
			logger: hostLogger,
			enqueue: vi.fn(),
		});
		expect(handle.ctx.logger).toBe(hostLogger);
		expect(handle.ctx.logger).not.toBe(integrationLogger);
	});

	it("subscriptions() 每次现读:改了仓再读不一样", () => {
		const { handle, store } = setup();
		expect(handle.ctx.subscriptions().map((v) => v.externalId)).toEqual(["1"]);
		store.upsert(makeSub("b", "2"));
		expect(handle.ctx.subscriptions().map((v) => v.externalId)).toEqual(["1", "2"]);
	});

	it("两路触发各叫一次回调:订阅变了、全局设置变了;别的设置变了不叫", () => {
		const { handle, bus, store } = setup();
		const fn = vi.fn();
		handle.ctx.onSubscriptionsChanged(fn);
		store.upsert(makeSub("b", "2"));
		expect(fn).toHaveBeenCalledTimes(1);
		bus.emit("config-changed", { scope: "globals" });
		expect(fn).toHaveBeenCalledTimes(2);
		bus.emit("config-changed", { scope: "connections" });
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("一个回调抛了不影响后面的回调,也不往总线外抛,记一行 error", () => {
		const { handle, bus, logger } = setup();
		const after = vi.fn();
		handle.ctx.onSubscriptionsChanged(() => {
			throw new Error("boom");
		});
		handle.ctx.onSubscriptionsChanged(after);
		expect(() => bus.emit("config-changed", { scope: "globals" })).not.toThrow();
		expect(after).toHaveBeenCalledTimes(1);
		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(logger.error.mock.calls[0]?.[0]).toContain("boom");
	});

	it("onSubscriptionsChanged 交回的把手能摘掉自己", () => {
		const { handle, bus } = setup();
		const fn = vi.fn();
		const watch = handle.ctx.onSubscriptionsChanged(fn);
		watch.dispose();
		bus.emit("config-changed", { scope: "globals" });
		expect(fn).not.toHaveBeenCalled();
	});

	it("reportPost 按身份展开:每条订阅各一份,带来源的 postNoun", () => {
		const { handle, enqueue } = setup([makeSub("a", "1"), makeSub("b", "1"), makeSub("c", "2")]);
		handle.ctx.reportPost("1", report("p1"));
		expect(enqueue.mock.calls.map(([e]) => e.subscriptionId)).toEqual(["a", "b"]);
		expect(enqueue.mock.calls[0]?.[0]).toEqual({
			subscriptionId: "a",
			identity: { sourceKey: SOURCE_KEY, externalId: "1" },
			postId: "p1",
			url: "https://example.test/p1",
			post: report("p1").post,
			postNoun: "动态",
		});
	});

	it("reportPost 没有这个人的订阅:不入队,记 debug", () => {
		const { handle, enqueue, logger } = setup();
		handle.ctx.reportPost("999", report());
		expect(enqueue).not.toHaveBeenCalled();
		expect(logger.debug).toHaveBeenCalled();
	});

	it("dispose 之后:回调不再叫、监听摘掉、reportPost 不入队并记 error、再登记回调也不会被叫", () => {
		const { handle, bus, enqueue, logger } = setup();
		const fn = vi.fn();
		handle.ctx.onSubscriptionsChanged(fn);
		handle.dispose();
		bus.emit("config-changed", { scope: "globals" });
		handle.ctx.onSubscriptionsChanged(fn);
		bus.emit("config-changed", { scope: "globals" });
		expect(fn).not.toHaveBeenCalled();
		handle.ctx.reportPost("1", report());
		expect(enqueue).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalledTimes(1);
		// 幂等
		expect(() => handle.dispose()).not.toThrow();
	});
});
