/**
 * 🔴 **组装根 `compose.ts` 的接线要有自己的守卫。**
 *
 * 零件(开发场景、登记表、B 站来源)各自的测试全绿,证明不了 `compose.ts` 真用对了认领键、真只挑 B 站订阅、
 * 真没在门没开时提前调工厂、真把同一个壳递给了来源和场景 —— 这些剪断了,别的测试一条都不会红。
 * 这里用真的 `createBiliDevtools`(测试进程里解析到的是真入口,换桩只挂在打包配置上)外面包一层 spy,
 * 来源用真的 B 站来源 + 真的 `DynamicEngine`(假 `Api`,全程不外连),逐条钉。
 */

import {
	BILIBILI_SOURCE_KEY,
	fail,
	type IntegrationContext,
	type Logger,
	ok as okResult,
	type PostReport,
	type SourceAuth,
	type SourceContext,
	type SourceSubscriptionView,
} from "@bilibili-notify/internal";
import type { Subscription } from "@bilibili-notify/subscription";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Api } from "../bilibili/api/index.js";
import { fakeAuth } from "../bilibili/devtools/__tests__/support/fake-auth.js";
import { createBiliDevtools } from "../bilibili/devtools/index.js";
import { observeLiveConnections } from "../bilibili/live/protocol/client.js";
import { settingsSegment } from "../bilibili/settings.js";
import { BUILTIN_INTEGRATION_SETTINGS, composeBuiltinIntegrations } from "../compose.js";
import { overridableApi } from "../devtools/api-overrides.js";
import { createDevtoolsProviderRegistry } from "../devtools/providers.js";
import { createPlatformAdapterRegistry } from "../push/registry.js";
import { createNodeMessageBus } from "../runtime/message-bus.js";
import { memoryIntegrationStore } from "./support/memory-key-value-store.js";

vi.mock("../bilibili/devtools/index.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../bilibili/devtools/index.js")>();
	return { ...actual, createBiliDevtools: vi.fn(actual.createBiliDevtools) };
});

function makeSub(
	sourceKey: string,
	externalId: string,
	over: { enabled?: boolean; specialUsers?: { uid: string }[] } = {},
): Subscription {
	return {
		id: `${sourceKey}-${externalId}`,
		identity: { sourceKey, externalId },
		enabled: over.enabled ?? true,
		specialUsers: over.specialUsers ?? [],
	} as unknown as Subscription;
}

const EMPTY_FEED = {
	code: 0,
	message: "ok",
	data: { has_more: false, items: [], offset: "", update_baseline: "", update_num: 0 },
};

const quietLogger = (): Logger => ({ info() {}, warn() {}, error() {}, debug() {} });

/** 假来源上下文:`reportPost` 是 spy,名单列一个开着作品的人。 */
function makeFakeSourceCtx(roster: SourceSubscriptionView[]) {
	const reportPost = vi.fn<(externalId: string, report: PostReport) => void>();
	const ctx = {
		logger: quietLogger(),
		// 设置读者:这个文件不管设置的内容,读出来恒是各格的默认值。
		settings: (schema: { parse(input: unknown): unknown }) => ({
			get: () => okResult({ settings: schema.parse({}) }),
			onChange: () => ({ dispose() {} }),
		}),
		subscriptions: () => roster,
		onSubscriptionsChanged: () => ({ dispose() {} }),
		reportPost,
		reportProblem: vi.fn(),
		resolveProblem: vi.fn(),
	} as unknown as SourceContext;
	return { ctx, reportPost };
}

/** 假引擎:`registerSource` 里直接 `await entry.source.start(假 ctx)`,记下每次登记。 */
function makeFakeEngines(ctx: SourceContext) {
	const registered: Array<{
		sourceKey: string;
		source: { stop(): Promise<void> };
		integration: IntegrationContext;
	}> = [];
	const engines = {
		registerSource: vi.fn(async (entry: (typeof registered)[number] & { source: never }) => {
			registered.push(entry);
			await (entry.source as { start(ctx: SourceContext): Promise<void> }).start(ctx);
		}),
	};
	return { engines: engines as never, registered, registerSource: engines.registerSource };
}

const integration = {
	logger: quietLogger(),
	signal: new AbortController().signal,
	onDispose() {},
	state: {},
	secrets: {},
} as unknown as IntegrationContext;

const SOURCE_AUTH = {
	beginLogin: async () => okResult(),
	logout: async () => okResult(),
	state: () => ({ status: "logged-out" as const }),
	onChange: () => ({ dispose() {} }),
} satisfies SourceAuth;

function compose(
	opts: {
		subs?: Subscription[];
		api?: Api;
		fetchImage?: ReturnType<typeof vi.fn>;
		sourceAuth?: SourceAuth;
	} = {},
) {
	const subs = opts.subs ?? [];
	const adapterRegistry = createPlatformAdapterRegistry();
	// 工厂创建时只往 serviceCtx 挂关停兜底(OneBot、QQ 官方各一个);连接名单是空的,适配器 start 不开监听。
	const onDispose = vi.fn();
	const integrationStore = memoryIntegrationStore();
	const api = overridableApi(opts.api ?? ({} as Api));
	const fetchImage = opts.fetchImage ?? vi.fn(async () => fail("unavailable", "测试不联网"));
	const setHealthCheckMs = vi.fn<(ms: number) => void>();
	const deps = {
		api,
		auth: overridableApi(fakeAuth()),
		integration,
		sourceAuth: opts.sourceAuth ?? SOURCE_AUTH,
		bus: createNodeMessageBus(),
		setHealthCheckMs,
		subscriptions: { list: () => subs },
		subscriptionRuntime: {
			get: (id: string) =>
				id === "bilibili-100"
					? ({
							roomId: "5050",
							cachedProfile: { name: "甲", avatarUrl: "https://a/1.png" },
						} as never)
					: undefined,
		},
		imageFetcher: { fetchImage } as never,
		setTimeout: () => ({ dispose() {} }),
		logger: quietLogger(),
		live: () => undefined,
		fans: () => undefined,
		healthCheck: () => undefined,
		serviceCtx: { onDispose } as never,
		onInboundPrivate: () => {},
		onInboundGroup: () => {},
		adapterRegistry,
		integrationStore,
		connections: () => [],
		onConnectionsChanged: () => ({ dispose() {} }),
	};
	return {
		builtins: composeBuiltinIntegrations(deps),
		deps,
		setHealthCheckMs,
		fetchImage,
		adapterRegistry,
		integrationStore,
		onDispose,
	};
}

beforeEach(() => {
	vi.mocked(createBiliDevtools).mockClear();
});

afterEach(() => {
	// 工厂会装全局的直播连接观察钩子;测完摘掉,别漏给同进程里的别的测试。
	observeLiveConnections(null);
	vi.useRealTimers();
});

describe("BUILTIN_INTEGRATION_SETTINGS · 设置登记", () => {
	it("设置段清单里有 B 站那一段,而且只有它", () => {
		expect(BUILTIN_INTEGRATION_SETTINGS.map((segment) => segment.key)).toEqual([
			BILIBILI_SOURCE_KEY,
		]);
		expect(BUILTIN_INTEGRATION_SETTINGS).toContain(settingsSegment);
	});
});

describe("composeBuiltinIntegrations · 开发场景", () => {
	it("认领用的是 B 站的来源键:汇总出来的场景 id 全带 bilibili. 前缀", () => {
		const providers = createDevtoolsProviderRegistry();
		compose().builtins.provideDevtools(providers);
		const ids = providers.scenarios().map((s) => s.id);
		expect(ids.length).toBeGreaterThan(0);
		expect(ids.every((id) => id.startsWith(`${BILIBILI_SOURCE_KEY}.`))).toBe(true);
	});

	it("挑订阅只留 B 站订阅,七个字段照旧", () => {
		const providers = createDevtoolsProviderRegistry();
		compose({
			subs: [
				makeSub("bilibili", "100", { specialUsers: [{ uid: "777" }] }),
				makeSub("e0000000-0000-4000-8000-000000000001", "x1"),
				makeSub("bilibili", "200", { enabled: false }),
			],
		}).builtins.provideDevtools(providers);
		const picked = vi.mocked(createBiliDevtools).mock.calls[0]?.[0].subs();
		expect(picked).toEqual([
			{
				id: "bilibili-100",
				uid: "100",
				name: "甲",
				enabled: true,
				roomId: "5050",
				specialUsers: ["777"],
				avatar: "https://a/1.png",
			},
			{
				id: "bilibili-200",
				uid: "200",
				name: "200",
				enabled: false,
				roomId: undefined,
				specialUsers: [],
				avatar: undefined,
			},
		]);
	});

	it("provideDevtools 没被调时,B 站的工厂一次都没被调(门没开的性质)", () => {
		compose();
		expect(createBiliDevtools).not.toHaveBeenCalled();
	});
});

describe("composeBuiltinIntegrations · 登记 B 站来源", () => {
	it("registerSources 按 B 站的键登记了一次,integration 就是入参那个;调第二次抛", async () => {
		const { builtins } = compose();
		const { engines, registered, registerSource } = makeFakeEngines(makeFakeSourceCtx([]).ctx);
		await builtins.registerSources(engines);
		expect(registerSource).toHaveBeenCalledTimes(1);
		expect(registered[0]?.sourceKey).toBe(BILIBILI_SOURCE_KEY);
		expect(registered[0]?.integration).toBe(integration);
		await expect(builtins.registerSources(engines)).rejects.toThrow("already registered");
		await registered[0]?.source.stop();
	});

	// 验红:删掉 `compose.ts` 里递给 `createBiliSource` 的 `auth: deps.sourceAuth`,这条红(来源上没有登录口,
	// 登记表与 `/api/sources/:sourceKey/auth` 都读不到它,而零件测试各自全绿)。
	it("登记的来源带着递进来的登录口(真的那一份,不是壳)", async () => {
		const { builtins } = compose();
		const { engines, registered } = makeFakeEngines(makeFakeSourceCtx([]).ctx);
		await builtins.registerSources(engines);
		const source = registered[0]?.source as unknown as { auth?: unknown; stop(): Promise<void> };
		expect(source.auth).toBe(SOURCE_AUTH);
		await source.stop();
	});

	// 验红:把 `compose.ts` 递给 `createBiliSource` 的 `loginCheck` 换成空操作(或漏掉不接依赖里的 `setHealthCheckMs`),这条红。
	// 入口里 `setHealthCheckMs: (ms) => authSystem?.setHealthCheckMs(ms)` 那一跳没有零外连的办法钉(真登录系统的心跳要真探活),
	// 靠必填依赖的类型与真机。
	it("来源 start 之后,依赖里的 setHealthCheckMs 收到登录检查的间隔(设置里的分钟数换成毫秒);stop 之后收到 0", async () => {
		const { builtins, setHealthCheckMs } = compose();
		const { engines, registered } = makeFakeEngines(makeFakeSourceCtx([]).ctx);

		await builtins.registerSources(engines);

		expect(setHealthCheckMs).toHaveBeenCalledTimes(1);
		expect(setHealthCheckMs).toHaveBeenLastCalledWith(30 * 60_000);
		await registered[0]?.source.stop();
		expect(setHealthCheckMs).toHaveBeenLastCalledWith(0);
	});

	it("登记抛了:错原样抛出去,不留半个来源(bilibili.dynamic 仍是 undefined),能重来", async () => {
		const { builtins } = compose();
		const boom = new Error("登记炸了");
		const engines = {
			registerSource: vi.fn().mockRejectedValueOnce(boom),
		} as never;
		await expect(builtins.registerSources(engines)).rejects.toBe(boom);
		expect(builtins.bilibili.dynamic()).toBeUndefined();
		const ok = makeFakeEngines(makeFakeSourceCtx([]).ctx);
		await builtins.registerSources(ok.engines);
		expect(builtins.bilibili.dynamic()).toBeDefined();
		await ok.registered[0]?.source.stop();
	});

	// 验红:去掉 `registerSources` 里 catch 中的 `registering = false`,或把造来源那几句挪回 try 之外,这条红。
	it("造来源那一步就同步抛了(还没到登记):标志也复位,再调一次 registerSources 能成", async () => {
		const { builtins, deps } = compose();
		const boom = new Error("造来源炸了");
		// 造来源要读 `deps.imageFetcher`:让它读的时候抛
		const original = deps.imageFetcher;
		Object.defineProperty(deps, "imageFetcher", {
			configurable: true,
			get(): never {
				throw boom;
			},
		});
		const broken = { registerSource: vi.fn() } as never;
		await expect(builtins.registerSources(broken)).rejects.toBe(boom);
		expect(builtins.bilibili.dynamic()).toBeUndefined();
		Object.defineProperty(deps, "imageFetcher", { configurable: true, value: original });
		const ok = makeFakeEngines(makeFakeSourceCtx([]).ctx);
		await builtins.registerSources(ok.engines);
		expect(builtins.bilibili.dynamic()).toBeDefined();
		await ok.registered[0]?.source.stop();
	});

	it("bilibili.dynamic() 登记之前是 undefined,registerSources 之后拿得到引擎,来源停下后又是 undefined", async () => {
		const { builtins } = compose();
		expect(builtins.bilibili.dynamic()).toBeUndefined();
		const { engines, registered } = makeFakeEngines(makeFakeSourceCtx([]).ctx);
		await builtins.registerSources(engines);
		expect(builtins.bilibili.dynamic()).toBeDefined();
		await registered[0]?.source.stop();
		expect(builtins.bilibili.dynamic()).toBeUndefined();
	});

	// 验红:让 `compose.ts` 造两个上报器(给来源的与挂在 `bilibili.problems` 上的不是同一个),这条红。
	it("bilibili.problems 与交给来源的是同一个上报器:来源登记前报的,登记后核心那头收到(补报)", async () => {
		// 登录着:没有更高层压住,第三层才存得下来
		const loggedIn: SourceAuth = {
			...SOURCE_AUTH,
			state: () => ({ status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" }),
		};
		const { builtins } = compose({ sourceAuth: loggedIn });
		builtins.bilibili.problems.reportFailure({
			externalId: "100",
			code: "live_monitor_stopped",
			message: "停了",
			notify: true,
			lasting: false,
		});
		const { ctx } = makeFakeSourceCtx([]);
		expect(ctx.reportProblem).not.toHaveBeenCalled();

		await builtins.registerSources(makeFakeEngines(ctx).engines);

		expect(ctx.reportProblem).toHaveBeenCalledTimes(1);
		expect(ctx.reportProblem).toHaveBeenCalledWith({
			externalId: "100",
			code: "live_monitor_stopped",
			message: "停了",
			notify: true,
		});
	});

	describe("场景那头与来源那头是同一个壳(造动态的场景一路走到来源的 reportPost)", () => {
		const roster: SourceSubscriptionView[] = [{ externalId: "100", features: new Set(["post"]) }];
		const setup = () => {
			// 锚点 = 来源起来那一刻;场景造的假动态发布时间是「现在」,得晚于锚点至少一秒。
			vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-11T00:00:00Z") });
			const fetchAllDynamic = vi.fn(async () => EMPTY_FEED);
			const fetchImage = vi.fn(async () => fail("unavailable", "测试不联网"));
			const { builtins, deps } = compose({
				subs: [makeSub("bilibili", "100")],
				api: { fetchAllDynamic } as unknown as Api,
				fetchImage,
			});
			const { ctx, reportPost } = makeFakeSourceCtx(roster);
			const fake = makeFakeEngines(ctx);
			const providers = createDevtoolsProviderRegistry();
			builtins.provideDevtools(providers);
			const scenario = providers.scenarios().find((s) => s.id === "bilibili.dynamic.post");
			if (!scenario) throw new Error("没有造动态的场景");
			return { builtins, deps, fake, scenario, reportPost, fetchImage };
		};
		const runScenario = async (
			scenario: ReturnType<typeof setup>["scenario"],
			params: Record<string, string> = { sub: "bilibili-100" },
		) => {
			vi.setSystemTime(new Date("2026-10-11T00:00:10Z"));
			return scenario.run(params as never);
		};

		it("登记之前跑同一个场景 → 报「动态引擎还没起来」", async () => {
			const { scenario } = setup();
			await expect(runScenario(scenario)).rejects.toThrow("动态引擎还没起来");
		});

		it("登记之后跑 → 假 ctx 的 reportPost 收到那条假动态", async () => {
			const { builtins, fake, scenario, reportPost } = setup();
			await builtins.registerSources(fake.engines);
			try {
				await runScenario(scenario);
				expect(reportPost).toHaveBeenCalledTimes(1);
				expect(reportPost.mock.calls[0]?.[0]).toBe("100");
			} finally {
				await fake.registered[0]?.source.stop();
			}
		});

		it("来源拿到的抓图服务就是入参那个(带图的动态会去抓图)", async () => {
			const { builtins, fake, scenario, fetchImage } = setup();
			await builtins.registerSources(fake.engines);
			try {
				await runScenario(scenario, { sub: "bilibili-100", type: "draw" });
				expect(fetchImage).toHaveBeenCalled();
			} finally {
				await fake.registered[0]?.source.stop();
			}
		});
	});
});

describe("composeBuiltinIntegrations · 登记三个内置适配器", () => {
	const keysOf = (registry: ReturnType<typeof createPlatformAdapterRegistry>) =>
		registry.list().map((adapter) => adapter.adapterKey);

	// 验红:从 `compose.ts` 的适配器列表里去掉任何一个、或调换 OneBot / QQ 官方机器人 / webhook 的先后,这条红。
	it("registerAdapters 按 OneBot、QQ 官方机器人、webhook 的次序登记进登记表,各开了一份存储", async () => {
		const { builtins, adapterRegistry, integrationStore } = compose();
		expect(keysOf(adapterRegistry)).toEqual([]);
		const adapters = await builtins.registerAdapters();
		expect(keysOf(adapterRegistry)).toEqual(["onebot", "qq-official", "webhook"]);
		expect(integrationStore.openKeys()).toEqual(["onebot", "qq-official", "webhook"]);
		await adapters.dispose();
	});

	// 验红:`registerAdapters` 不把 `registerBuiltinAdapters` 交回的把手交出去(`return await` 改成只 `await`),
	// 这条红(调用方拿不到能撤的 `dispose`)。
	it("交回的 dispose 撤干净:登记表空了、存储都关了、再调一次也行", async () => {
		const { builtins, adapterRegistry, integrationStore } = compose();
		const adapters = await builtins.registerAdapters();
		await adapters.dispose();
		expect(keysOf(adapterRegistry)).toEqual([]);
		expect(integrationStore.openKeys()).toEqual([]);
		await expect(adapters.dispose()).resolves.toBeUndefined();
	});

	// 验红:去掉 `registerAdapters` 开头的 `if (registeringAdapters) throw …`,这条红。
	it("调第二次就抛", async () => {
		const { builtins } = compose();
		const adapters = await builtins.registerAdapters();
		await expect(builtins.registerAdapters()).rejects.toThrow("already registered");
		await adapters.dispose();
	});

	// 验红:去掉 `registerAdapters` catch 里的 `registeringAdapters = false`,这条红(重来被「已登记」拦下)。
	it("登记途中抛了:错原样抛出去、已登记的收回、存储关掉,占用解除后能重来", async () => {
		const { builtins, adapterRegistry, integrationStore } = compose();
		// 先让别人占了 webhook 的键:前两个登记上了,第三个登记抛。
		const squatter = adapterRegistry.register(
			{
				adapterKey: "webhook",
				start() {},
				stop() {},
			} as never,
			{ signal: new AbortController().signal } as never,
		);
		await expect(builtins.registerAdapters()).rejects.toThrow();
		expect(keysOf(adapterRegistry)).toEqual(["webhook"]);
		await vi.waitFor(() => expect(integrationStore.openKeys()).toEqual([]));
		squatter.dispose();
		const adapters = await builtins.registerAdapters();
		expect(keysOf(adapterRegistry)).toEqual(["onebot", "qq-official", "webhook"]);
		await adapters.dispose();
	});

	// 验红:造 OneBot / QQ 官方机器人时不把 `deps.serviceCtx` 递给工厂,这条红(关停兜底没挂上)。
	it("适配器在 compose 时就造好:OneBot 与 QQ 官方机器人各往 serviceCtx 挂了一个关停兜底", () => {
		const { onDispose } = compose();
		expect(onDispose).toHaveBeenCalledTimes(2);
		expect(onDispose).toHaveBeenCalledWith(expect.any(Function), "stop");
	});
});
