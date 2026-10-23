import {
	type AiTool,
	type AiToolProvider,
	type AuthState,
	type LinkResolver,
	ok,
	type PostEvent,
	type Source,
	type SourceAuth,
} from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { noCandidates, noProfile } from "../../__tests__/support/no-candidates.js";
import {
	type AiToolProviderRegistry,
	createAiToolProviderRegistry,
} from "../../ai/tool-provider-registry.js";
import { createLinkResolverRegistry } from "../../link-preview/registry.js";
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

const fakeLinkResolver = (): LinkResolver => ({
	label: "假解析器",
	matches: () => false,
	resolve: async () => {
		throw new Error("不该被调到");
	},
});

const fakeAiTool = (): AiTool => ({
	definition: {
		type: "function",
		function: {
			name: "echo",
			description: "回一句",
			parameters: { type: "object", properties: {} },
		},
	},
	label: "回一句",
	execute: async () => ok({ text: "echo" }),
});

const fakeAiToolProvider = (): AiToolProvider => ({ readOnly: [fakeAiTool()] });

const setup = (source: Source = makeSource()) => {
	const world = makeWorld([makeSub("a", "1")]);
	const registry = createSourceRegistry();
	const linkResolvers = createLinkResolverRegistry();
	const aiToolProviders: AiToolProviderRegistry = createAiToolProviderRegistry();
	const logger = makeLogger();
	const enqueue = vi.fn<(event: PostEvent) => void>();
	const problems = makeProblems();
	const options = {
		registry,
		linkResolvers,
		aiToolProviders,
		source,
		integration: makeIntegration(),
		sourceKey: SOURCE_KEY,
		subscriptions: world.store,
		defaults: () => world.globals.defaults,
		bus: world.bus,
		logger,
		enqueue,
		liveSignals: vi.fn(),
		liveInteractions: vi.fn(),
		problems,
	};
	return { ...world, registry, linkResolvers, aiToolProviders, logger, enqueue, problems, options };
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

	it("来源在 start 里登的链接解析器:表里按来源的键查得到;来源停下(撤登记)后表里没有", async () => {
		const source = makeSource();
		const { options, linkResolvers } = setup(source);
		const fake = fakeLinkResolver();
		source.start = vi.fn(async (ctx) => {
			ctx.registerLinkResolver(fake);
		});
		const handle = await registerBuiltinSource(options);
		expect(Array.from(linkResolvers.entries())).toEqual([[SOURCE_KEY, fake]]);
		handle.dispose();
		expect(Array.from(linkResolvers.entries())).toEqual([]);
	});

	it("来源停下之后再登链接解析器:不抛,表里仍然没有", async () => {
		const source = makeSource();
		const { options, linkResolvers } = setup(source);
		const handle = await registerBuiltinSource(options);
		handle.dispose();
		const late = source.started[0]?.registerLinkResolver(fakeLinkResolver());
		expect(late).toBeDefined();
		expect(() => late?.dispose()).not.toThrow();
		expect(Array.from(linkResolvers.entries())).toEqual([]);
	});

	it("同一个来源登第二个链接解析器会抛(一个键一个主人);自己撤了可以重登", async () => {
		const source = makeSource();
		const { options, linkResolvers } = setup(source);
		await registerBuiltinSource(options);
		const ctx = source.started[0];
		const first = fakeLinkResolver();
		const second = fakeLinkResolver();
		const handle = ctx?.registerLinkResolver(first);
		expect(() => ctx?.registerLinkResolver(second)).toThrow("already registered");
		handle?.dispose();
		ctx?.registerLinkResolver(second);
		expect(Array.from(linkResolvers.entries())).toEqual([[SOURCE_KEY, second]]);
	});

	it("来源在 start 里登的 AI 工具提供方:表里按来源的键认领,工具带命名空间;来源停下后自动撤", async () => {
		const source = makeSource();
		const { options, aiToolProviders } = setup(source);
		const provider = fakeAiToolProvider();
		source.start = vi.fn(async (ctx) => {
			ctx.registerAiToolProvider(provider);
		});
		const handle = await registerBuiltinSource(options);
		expect(aiToolProviders.tools().map((tool) => tool.definition.function.name)).toEqual([
			`${SOURCE_KEY.replaceAll(".", "_")}__echo`,
		]);
		handle.dispose();
		expect(aiToolProviders.tools()).toEqual([]);
	});

	it("来源停下之后再登 AI 工具提供方:不抛,表里仍然没有,并记 error", async () => {
		const source = makeSource();
		const { options, aiToolProviders, logger } = setup(source);
		const handle = await registerBuiltinSource(options);
		handle.dispose();
		const late = source.started[0]?.registerAiToolProvider(fakeAiToolProvider());
		expect(late).toBeDefined();
		expect(() => late?.dispose()).not.toThrow();
		expect(aiToolProviders.tools()).toEqual([]);
		expect(logger.error).toHaveBeenCalled();
	});

	it("同一个来源登第二个 AI 工具提供方会抛;自己撤了可以重登", async () => {
		const source = makeSource();
		const { options, aiToolProviders } = setup(source);
		const handle = await registerBuiltinSource(options);
		const ctx = source.started[0];
		const first = ctx?.registerAiToolProvider({ readOnly: [fakeAiTool()] });
		expect(() => ctx?.registerAiToolProvider({ readOnly: [fakeAiTool()] })).toThrow(
			`AI tool provider for key "${SOURCE_KEY}" is already registered`,
		);
		first?.dispose();
		ctx?.registerAiToolProvider({ readOnly: [fakeAiTool()] });
		expect(aiToolProviders.tools()).toHaveLength(1);
		handle.dispose();
		expect(aiToolProviders.tools()).toEqual([]);
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
			descriptor: { label: "测试" },
			searchCreators: noCandidates,
			fetchProfile: noProfile,
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
			descriptor: { label: "测试" },
			searchCreators: noCandidates,
			fetchProfile: noProfile,
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
		expect(authed.listeners.size).toBe(0);
		authed.fire();
		expect(onAuthChanged).not.toHaveBeenCalled();
	});

	// 验红:`builtin-sources.ts` 里不建 `watchLoginProblems`,这条红。
	it("有登录口的来源登记后:宿主看登录状态,expired 就在来源键名下报 auth_lost(宿主那句、带私聊、不盖写者)", async () => {
		const authed = makeAuthedSource();
		authed.setState({ status: "expired", message: "失效" });
		const { options, problems } = setup(authed.source);
		await registerBuiltinSource(options);
		expect(problems.report).toHaveBeenCalledTimes(1);
		const call = problems.report.mock.calls[0]?.[0];
		// 交进表的是取字函数(换语言时表重跑),现取一次看字。
		expect(call).toMatchObject({
			reporter: SOURCE_KEY,
			code: "auth_lost",
			notify: true,
			message: expect.any(Function),
			recoveryMessage: expect.any(Function),
		});
		expect(typeof call?.message === "function" && call.message()).toBe(
			"主人，测试的登录失效了，那边订阅的内容先收不到了。到面板的账号页重新扫码登录就好，私聊发「login bilibili」也行。",
		);
		expect(typeof call?.recoveryMessage === "function" && call.recoveryMessage()).toBe(
			"主人，好消息：测试的登录已经恢复啦。",
		);
	});

	it("登记之后登录状态变了:跟着报与清", async () => {
		const authed = makeAuthedSource();
		authed.setState({ status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" });
		const { options, problems } = setup(authed.source);
		await registerBuiltinSource(options);
		expect(problems.report).not.toHaveBeenCalled();

		authed.setState({ status: "expired", message: "失效" });
		authed.fire();
		expect(problems.report).toHaveBeenCalledTimes(1);

		authed.setState({ status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" });
		authed.fire();
		expect(problems.resolve).toHaveBeenCalledWith({ reporter: SOURCE_KEY, code: "auth_lost" });
	});

	it("撤登记:先摘宿主的登录观察再整批清,清掉的不补「已恢复」,之后状态再变也不报", async () => {
		const authed = makeAuthedSource();
		authed.setState({ status: "expired", message: "失效" });
		const { options, problems } = setup(authed.source);
		const handle = await registerBuiltinSource(options);
		problems.report.mockClear();

		handle.dispose();

		expect(problems.clearReporter).toHaveBeenCalledWith(SOURCE_KEY);
		expect(problems.resolve).not.toHaveBeenCalled();
		authed.setState({ status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" });
		authed.fire();
		authed.setState({ status: "expired", message: "又失效" });
		authed.fire();
		expect(problems.report).not.toHaveBeenCalled();
		expect(authed.listeners.size).toBe(0);
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
