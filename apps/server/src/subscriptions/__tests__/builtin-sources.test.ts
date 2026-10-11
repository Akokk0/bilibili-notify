import type { PostEvent, Source } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { registerBuiltinSource } from "../builtin-sources.js";
import { createSourceRegistry } from "../registry.js";
import {
	makeIntegration,
	makeLogger,
	makeSource,
	makeSub,
	makeWorld,
	SOURCE_KEY,
} from "./fixtures.js";

const setup = (source: Source = makeSource()) => {
	const world = makeWorld([makeSub("a", "1")]);
	const registry = createSourceRegistry();
	const enqueue = vi.fn<(event: PostEvent) => void>();
	const options = {
		registry,
		source,
		integration: makeIntegration(),
		sourceKey: SOURCE_KEY,
		subscriptions: world.store,
		defaults: () => world.globals.defaults,
		bus: world.bus,
		logger: makeLogger(),
		enqueue,
	};
	return { ...world, registry, enqueue, options };
};

describe("registerBuiltinSource", () => {
	it("建上下文并登记:start 拿到的 ctx 是真的,交作品走入口,postNoun 取自描述符", async () => {
		const source = makeSource();
		const { options, registry, enqueue } = setup(source);
		await registerBuiltinSource(options);
		expect(registry.get(SOURCE_KEY)).toBeDefined();
		const ctx = source.started[0];
		expect(ctx?.subscriptions().map((v) => v.externalId)).toEqual(["1"]);
		ctx?.reportPost("1", {
			postId: "p1",
			url: "https://example.test/p1",
			post: { creator: { name: "UP" }, publishedAt: "2026-01-01T00:00:00.000Z", text: "hi" },
		});
		expect(enqueue.mock.calls[0]?.[0].postNoun).toBe("动态");
	});

	it("撤销把手:先 stop 来源,再收上下文(收上下文之后再上报会被丢)", async () => {
		const order: string[] = [];
		const source = makeSource();
		const stop = source.stop.bind(source);
		source.stop = vi.fn(async () => {
			order.push("stop");
			// stop 的同步段里上下文还没收:此刻上报仍能入队
			source.started[0]?.reportPost("1", {
				postId: "late",
				url: "u",
				post: { creator: { name: "UP" }, publishedAt: "2026-01-01T00:00:00.000Z", text: "x" },
			});
			await stop();
		});
		const { options, enqueue } = setup(source);
		enqueue.mockImplementation(() => order.push("enqueue"));
		const handle = await registerBuiltinSource(options);
		handle.dispose();
		expect(order).toEqual(["stop", "enqueue"]);
		source.started[0]?.reportPost("1", {
			postId: "later",
			url: "u",
			post: { creator: { name: "UP" }, publishedAt: "2026-01-01T00:00:00.000Z", text: "x" },
		});
		expect(order).toEqual(["stop", "enqueue"]);
	});

	it("键被占:抛,并把这次建的上下文收掉(总线上不留监听)", async () => {
		const first = setup();
		await registerBuiltinSource(first.options);
		const second = makeSource();
		await expect(registerBuiltinSource({ ...first.options, source: second })).rejects.toThrow(
			"already registered",
		);
		expect(second.started).toHaveLength(0);
	});

	it("start 抛了:抛出去,键放掉,上下文收掉", async () => {
		const seen: Array<() => void> = [];
		const broken: Source = {
			descriptor: {},
			async start(ctx) {
				ctx.onSubscriptionsChanged(() => seen.push(() => {}));
				throw new Error("start-boom");
			},
			stop: async () => {},
		};
		const { options, registry, bus } = setup(broken);
		await expect(registerBuiltinSource(options)).rejects.toThrow("start-boom");
		expect(registry.get(SOURCE_KEY)).toBeUndefined();
		bus.emit("config-changed", { scope: "globals" });
		expect(seen).toHaveLength(0);
	});
});
