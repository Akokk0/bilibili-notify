import {
	type AuthState,
	ok,
	type PostEvent,
	type Source,
	type SourceAuth,
} from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { registerBuiltinSource } from "../builtin-sources.js";
import { createSourceRegistry } from "../registry.js";
import {
	makeIntegration,
	makeLogger,
	makeProblems,
	makeSource,
	makeSub,
	makeWorld,
	SOURCE_KEY,
} from "./fixtures.js";

const setup = (source: Source = makeSource()) => {
	const world = makeWorld([makeSub("a", "1")]);
	const registry = createSourceRegistry();
	const enqueue = vi.fn<(event: PostEvent) => void>();
	const problems = makeProblems();
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
		problems,
	};
	return { ...world, registry, enqueue, problems, options };
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

	it("撤登记:这个来源报的问题整批清掉(clearReporter),在 stop 之后", async () => {
		const order: string[] = [];
		const source = makeSource();
		const stop = source.stop.bind(source);
		source.stop = vi.fn(async () => {
			order.push("stop");
			await stop();
		});
		const { options, problems } = setup(source);
		problems.clearReporter.mockImplementation(() => void order.push("clear"));
		const handle = await registerBuiltinSource(options);
		expect(problems.clearReporter).not.toHaveBeenCalled();
		handle.dispose();
		expect(problems.clearReporter).toHaveBeenCalledTimes(1);
		expect(problems.clearReporter).toHaveBeenCalledWith(SOURCE_KEY);
		expect(order).toEqual(["stop", "clear"]);
		// 宿主在清,不是逐条 resolve(逐条 resolve 会补「已恢复」)
		expect(problems.resolve).not.toHaveBeenCalled();
	});

	it("登记失败(start 抛):start 途中报过的也清掉", async () => {
		const broken: Source = {
			descriptor: {},
			async start(ctx) {
				ctx.reportProblem({ code: "half_started", message: "还没起完" });
				throw new Error("start-boom");
			},
			stop: async () => {},
		};
		const { options, problems } = setup(broken);
		await expect(registerBuiltinSource(options)).rejects.toThrow("start-boom");
		expect(problems.report).toHaveBeenCalledTimes(1);
		expect(problems.clearReporter).toHaveBeenCalledWith(SOURCE_KEY);
	});
});

/** 带登录口的假来源:`onChange` 的订阅者记在 `listeners` 里,状态由测试拨。 */
function makeAuthedSource() {
	const listeners = new Set<() => void>();
	const disposed = vi.fn();
	let state: AuthState = { status: "logged-out" };
	const auth: SourceAuth = {
		beginLogin: async () => ok(),
		logout: async () => ok(),
		state: () => state,
		onChange: (fn) => {
			listeners.add(fn);
			return {
				dispose() {
					disposed();
					listeners.delete(fn);
				},
			};
		},
	};
	const source = Object.assign(makeSource(), { auth });
	return {
		source,
		listeners,
		disposed,
		setState: (next: AuthState) => {
			state = next;
		},
		fire: () => {
			for (const fn of [...listeners]) fn();
		},
	};
}

describe("registerBuiltinSource · 登录口(Source.auth)", () => {
	it("登记表的视图带着来源的 auth", async () => {
		const authed = makeAuthedSource();
		const { options, registry } = setup(authed.source);
		await registerBuiltinSource(options);
		expect(registry.get(SOURCE_KEY)?.auth).toBe(authed.source.auth);
	});

	// 验红:删掉宿主里 `auth.onChange(...)` 那一订阅,这条红。
	it("来源的 auth 叫了 onChange → onAuthChanged 收到那一刻的 state();登记时不补发", async () => {
		const authed = makeAuthedSource();
		const onAuthChanged = vi.fn<(state: AuthState) => void>();
		const { options } = setup(authed.source);
		await registerBuiltinSource({ ...options, onAuthChanged });
		expect(onAuthChanged).not.toHaveBeenCalled();

		authed.setState({ status: "confirming", message: "已扫码，请在手机上确认" });
		authed.fire();

		expect(onAuthChanged).toHaveBeenCalledTimes(1);
		expect(onAuthChanged).toHaveBeenCalledWith({
			status: "confirming",
			message: "已扫码，请在手机上确认",
		});
	});

	it("撤登记后摘掉订阅,不再发", async () => {
		const authed = makeAuthedSource();
		const onAuthChanged = vi.fn<(state: AuthState) => void>();
		const { options } = setup(authed.source);
		const handle = await registerBuiltinSource({ ...options, onAuthChanged });

		handle.dispose();
		expect(authed.disposed).toHaveBeenCalledTimes(1);
		authed.fire();
		expect(onAuthChanged).not.toHaveBeenCalled();
	});

	it("来源没有登录口:不订阅、不抛", async () => {
		const onAuthChanged = vi.fn<(state: AuthState) => void>();
		const { options } = setup(makeSource());
		await expect(registerBuiltinSource({ ...options, onAuthChanged })).resolves.toBeDefined();
		expect(onAuthChanged).not.toHaveBeenCalled();
	});

	it("登记失败(start 抛):不订阅", async () => {
		const authed = makeAuthedSource();
		const broken: Source = {
			...authed.source,
			start: async () => {
				throw new Error("start-boom");
			},
		};
		const { options } = setup(broken);
		await expect(registerBuiltinSource({ ...options, onAuthChanged: vi.fn() })).rejects.toThrow(
			"start-boom",
		);
		expect(authed.listeners.size).toBe(0);
	});
});
