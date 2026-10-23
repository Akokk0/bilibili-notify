/**
 * 🔴 **组装根 `compose.ts` 的接线要有自己的守卫。**
 *
 * 零件(开发场景、登记表、B 站来源)各自的测试全绿,证明不了 `compose.ts` 真用对了认领键、真只挑 B 站订阅、
 * 真没在门没开时提前调工厂、真把同一个壳递给了来源和场景 —— 这些剪断了,别的测试一条都不会红。
 * 这里用真的 `createBiliDevtools`(测试进程里解析到的是真入口,换桩只挂在打包配置上)外面包一层 spy,
 * 来源用真的 B 站来源 + 真的 `DynamicPoller`(假 `Api`,全程不外连),逐条钉。
 */

import {
	BILIBILI_SOURCE_KEY,
	type Connection,
	fail,
	type IntegrationContext,
	type Logger,
	ok as okResult,
	type PlatformAdapterContext,
	type PostReport,
	RESERVED_INTEGRATION_KEYS,
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
import {
	BUILTIN_INTEGRATION_SETTINGS,
	type BuiltinIntegrationsDeps,
	composeBuiltinIntegrations,
} from "../compose.js";
import { overridableApi } from "../devtools/api-overrides.js";
import { createDevtoolsProviderRegistry } from "../devtools/providers.js";
import type { LocaleReader } from "../i18n/locale-reader.js";
import { createPlatformAdapterRegistry } from "../push/registry.js";
import { createNodeMessageBus } from "../runtime/message-bus.js";
import { fixedLocale } from "./support/fixed-locale.js";
import { ignoredProblems } from "./support/ignored-problems.js";
import { inertSettingsOf } from "./support/inert-settings.js";
import { inertTransitImages } from "./support/integration-io.js";
import { memoryIntegrationStore } from "./support/memory-key-value-store.js";

// OneBot 适配器换成「照真的造、但 start 只把拿到的 ctx 存下来」:真 start 会按连接名单开 WS,而这里要看的只是
// compose 有没有把入站的下一层递进适配器上下文(`registerAdapters` → `registerBuiltinAdapters` → ctx.inbound)。
const startedCtx = vi.hoisted(() => ({ onebot: undefined as unknown }));
vi.mock("../platforms/onebot.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../platforms/onebot.js")>();
	return {
		...actual,
		createOnebotAdapter: vi.fn((opts: Parameters<typeof actual.createOnebotAdapter>[0]) => ({
			...actual.createOnebotAdapter(opts),
			start(ctx: unknown) {
				startedCtx.onebot = ctx;
			},
		})),
	};
});

vi.mock("../bilibili/devtools/index.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../bilibili/devtools/index.js")>();
	return { ...actual, createBiliDevtools: vi.fn(actual.createBiliDevtools) };
});

function makeSub(
	sourceKey: string,
	externalId: string,
	over: { enabled?: boolean; specialViewers?: { id: string }[] } = {},
): Subscription {
	return {
		id: `${sourceKey}-${externalId}`,
		identity: { sourceKey, externalId },
		enabled: over.enabled ?? true,
		specialViewers: over.specialViewers ?? [],
	} as unknown as Subscription;
}

const EMPTY_FEED = okResult({
	data: { has_more: false, items: [], offset: "", update_baseline: "", update_num: 0 },
});

const quietLogger = (): Logger => ({ info() {}, warn() {}, error() {}, debug() {} });

/** 假来源上下文:`reportPost` 与 `fetchImage` 都是 spy,名单列一个开着作品的人。 */
function makeFakeSourceCtx(
	roster: SourceSubscriptionView[],
	fetchImage = vi.fn(async () => fail("unavailable", "测试不联网")),
) {
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
		fetchImage,
		reportProblem: vi.fn(),
		resolveProblem: vi.fn(),
		registerLinkResolver: vi.fn(() => ({ dispose() {} })),
		registerAiToolProvider: vi.fn(() => ({ dispose() {} })),
	} as unknown as SourceContext;
	return { ctx, reportPost, fetchImage };
}

/** 假引擎:`registerSource` 里直接 `await entry.source.start(假 ctx)`,记下每次登记。 */
function makeFakeEngines(ctx: SourceContext) {
	const registered: Array<{
		sourceKey: string;
		source: { stop(): Promise<void> };
		integration: IntegrationContext;
		logger: Logger;
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
		sourceAuth?: SourceAuth;
		/** 语言读口:不给就是一直不变的;要切语言的用例给 `switchableLocale()`。 */
		locale?: LocaleReader;
		/** 入站的下一层:不给就是两个空函数。 */
		inbound?: BuiltinIntegrationsDeps["inbound"];
		/** 全部连接:不给就是空名单。 */
		connections?: () => readonly Connection[];
	} = {},
) {
	const subs = opts.subs ?? [];
	const adapterRegistry = createPlatformAdapterRegistry();
	// 工厂创建时只往 serviceCtx 挂关停兜底(OneBot、QQ 官方各一个);连接名单是空的,适配器 start 不开监听。
	const onDispose = vi.fn();
	// 与真的一样:同一对(标签,键)交回同一个上下文,日志器各不相同,好分辨「这个日志器是按哪一对要来的」。
	const subsystems = new Map<string, { logger: Logger }>();
	// 核心自己的日志器(`serviceCtx.logger`):也是 spy,好断言集成的行没有落到它上面。
	const coreLogger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	const forSubsystem = vi.fn((name: string, levelKey: string) => {
		const key = JSON.stringify([name, levelKey]);
		let ctx = subsystems.get(key);
		if (!ctx) {
			// 日志器是 spy:好看出一行日志落在了哪一对(标签,键)的日志器上。
			ctx = { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } };
			subsystems.set(key, ctx);
		}
		return ctx;
	});
	const integrationStore = memoryIntegrationStore();
	const api = overridableApi(opts.api ?? ({} as Api));
	const setHealthCheckMs = vi.fn<(ms: number) => void>();
	const deps = {
		api,
		auth: overridableApi(fakeAuth()),
		integration,
		sourceAuth: opts.sourceAuth ?? SOURCE_AUTH,
		locale: opts.locale ?? fixedLocale(),
		bus: createNodeMessageBus(),
		setHealthCheckMs,
		subscriptions: { list: () => subs },
		subscriptionRuntime: {
			get: (id: string) =>
				id === "bilibili-100"
					? ({
							cachedProfile: { name: "甲", avatarUrl: "https://a/1.png" },
						} as never)
					: undefined,
		},
		setTimeout: () => ({ dispose() {} }),
		healthCheck: () => undefined,
		serviceCtx: { onDispose, forSubsystem, logger: coreLogger } as never,
		transitImages: inertTransitImages,
		inbound: opts.inbound ?? { private: () => {}, group: () => {} },
		adapterRegistry,
		integrationStore,
		problems: ignoredProblems,
		settingsOf: inertSettingsOf,
		connections: opts.connections ?? (() => []),
		onConnectionsChanged: () => ({ dispose() {} }),
	};
	return {
		builtins: composeBuiltinIntegrations(deps),
		deps,
		setHealthCheckMs,
		adapterRegistry,
		integrationStore,
		onDispose,
		forSubsystem,
		subsystems,
		coreLogger,
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
	// 每个拿到集成上下文的集成都在配置仓登记一段(ADR-0025 决策 2):内置的就是保留 id 那四个。
	it("设置段清单的键正好是保留的内置集成键(集合相等),B 站那一段在里面", () => {
		const keys = BUILTIN_INTEGRATION_SETTINGS.map((segment) => segment.key);
		expect(new Set(keys).size).toBe(keys.length);
		expect([...keys].sort()).toEqual([...RESERVED_INTEGRATION_KEYS].sort());
		expect(BUILTIN_INTEGRATION_SETTINGS).toContain(settingsSegment);
	});

	it("三个内置适配器的段是空段:没有任何格,空对象过得了", () => {
		for (const key of ["onebot", "qq-official", "webhook"]) {
			const segment = BUILTIN_INTEGRATION_SETTINGS.find((candidate) => candidate.key === key);
			expect(segment?.schema.shape).toEqual({});
			expect(segment?.schema.safeParse({}).success).toBe(true);
		}
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

	it("挑订阅只留 B 站订阅,六个字段照旧", () => {
		const providers = createDevtoolsProviderRegistry();
		compose({
			subs: [
				makeSub("bilibili", "100", { specialViewers: [{ id: "777" }] }),
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
				specialViewers: ["777"],
				avatar: "https://a/1.png",
			},
			{
				id: "bilibili-200",
				uid: "200",
				name: "200",
				enabled: false,
				specialViewers: [],
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
	// 验红:把 `compose.ts` 里登记项的 `logger` 换成 `deps.logger`,或把 `forSubsystem("dynamic", …)` 的键换成 `"core"`,这条红。
	it("来源登记项带的日志器:标签 dynamic、键是 B 站的来源键", async () => {
		const { builtins, forSubsystem } = compose();
		const { engines, registered } = makeFakeEngines(makeFakeSourceCtx([]).ctx);
		await builtins.registerSources(engines);
		const index = forSubsystem.mock.calls.findIndex(
			([name, key]) => name === "dynamic" && key === BILIBILI_SOURCE_KEY,
		);
		expect(index).toBeGreaterThanOrEqual(0);
		expect(registered[0]?.logger).toBe(forSubsystem.mock.results[index]?.value.logger);
		await registered[0]?.source.stop();
	});

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
	// 入口里 `setHealthCheckMs: (ms) => authSystem?.setHealthCheckMs(ms)` 那一跳在这里钉不到,由
	// `builtin-source-settings-boot-e2e.test.ts` 钉着(真入口、真登录系统,探 `LoginFlow.prototype.setHealthCheckMs`)。
	it("来源 start 之后,依赖里的 setHealthCheckMs 收到登录检查的间隔(设置里的分钟数换成毫秒);stop 之后收到 0", async () => {
		const { builtins, setHealthCheckMs } = compose();
		const { engines, registered } = makeFakeEngines(makeFakeSourceCtx([]).ctx);

		await builtins.registerSources(engines);

		expect(setHealthCheckMs).toHaveBeenCalledTimes(1);
		expect(setHealthCheckMs).toHaveBeenLastCalledWith(30 * 60_000);
		await registered[0]?.source.stop();
		expect(setHealthCheckMs).toHaveBeenLastCalledWith(0);
	});

	// 验红:让 `compose.ts` 造两个上报器(给来源的与挂在 `bilibili.problems` 上的不是同一个),这条红。

	// 验红:`compose.ts` 造分层上报器时不递 `locale`(或递成一个永不触发的读口),这条红。

	describe("场景那头与来源那头是同一个壳(造动态的场景一路走到来源的 reportPost)", () => {
		const roster: SourceSubscriptionView[] = [
			{ externalId: "100", features: new Set(["post"]), monitorsLive: false },
		];
		const setup = () => {
			// 锚点 = 来源起来那一刻;场景造的假动态发布时间是「现在」,得晚于锚点至少一秒。
			vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-11T00:00:00Z") });
			const fetchAllDynamic = vi.fn(async () => EMPTY_FEED);
			const fetchImage = vi.fn(async () => fail("unavailable", "测试不联网"));
			const { builtins, deps } = compose({
				subs: [makeSub("bilibili", "100")],
				api: { fetchAllDynamic } as unknown as Api,
			});
			const { ctx, reportPost } = makeFakeSourceCtx(roster, fetchImage);
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

		it("来源用的是上下文给的抓图口(带图的动态会去抓图)", async () => {
			const { builtins, fake, scenario, fetchImage } = setup();
			await builtins.registerSources(fake.engines);
			try {
				await runScenario(scenario, { sub: "bilibili-100", type: "draw" });
				expect(fetchImage).toHaveBeenCalled();
			} finally {
				await fake.registered[0]?.source.stop();
			}
		});

		// 「现在就跑」要的引擎不再经 `builtins.bilibili.dynamic` 取(那一格随 `Source.health()` 一起没了),
		// 改经场景那一头观察:报「动态引擎还没起来」= 引擎不在。
		it("登记抛了:错原样抛出去,不留半个来源(场景仍报「动态引擎还没起来」),能重来", async () => {
			const { builtins, fake, scenario, reportPost } = setup();
			const boom = new Error("登记炸了");
			const engines = { registerSource: vi.fn().mockRejectedValueOnce(boom) } as never;
			await expect(builtins.registerSources(engines)).rejects.toBe(boom);
			await expect(runScenario(scenario)).rejects.toThrow("动态引擎还没起来");
			// 锚点 = 来源起来那一刻:拨回起点再登记,场景那条假动态才晚于锚点。
			vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
			await builtins.registerSources(fake.engines);
			try {
				await runScenario(scenario);
				expect(reportPost).toHaveBeenCalledTimes(1);
			} finally {
				await fake.registered[0]?.source.stop();
			}
		});

		// 验红:去掉 `registerSources` 里 catch 中的 `registering = false`,或把造来源那几句挪回 try 之外,这条红。
		it("造来源那一步就同步抛了(还没到登记):标志也复位,再调一次 registerSources 能成", async () => {
			const { builtins, deps, scenario } = setup();
			const boom = new Error("造来源炸了");
			// 造来源要读 `deps.setTimeout`:让它读的时候抛
			const original = deps.setTimeout;
			Object.defineProperty(deps, "setTimeout", {
				configurable: true,
				get(): never {
					throw boom;
				},
			});
			const broken = { registerSource: vi.fn() } as never;
			await expect(builtins.registerSources(broken)).rejects.toBe(boom);
			await expect(runScenario(scenario)).rejects.toThrow("动态引擎还没起来");
			Object.defineProperty(deps, "setTimeout", { configurable: true, value: original });
			const ok = makeFakeEngines(makeFakeSourceCtx([]).ctx);
			await builtins.registerSources(ok.engines);
			await ok.registered[0]?.source.stop();
		});

		it("来源停下后,场景又报「动态引擎还没起来」", async () => {
			const { builtins, fake, scenario } = setup();
			await builtins.registerSources(fake.engines);
			await runScenario(scenario);
			await fake.registered[0]?.source.stop();
			await expect(runScenario(scenario)).rejects.toThrow("动态引擎还没起来");
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

	// 验红:给 `registerAdapters` 加回「失败就复位 `registeringAdapters = false`」的 catch,这条红(再调没被拒)。
	it("登记途中抛了:错原样抛出去、已登记的收回、存储关掉,再调直接拒", async () => {
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
		// 占用解除了也不给重来:一次性,失败不复位。
		squatter.dispose();
		await expect(builtins.registerAdapters()).rejects.toThrow("already registered");
		expect(keysOf(adapterRegistry)).toEqual([]);
	});

	// 验红:把 `compose.ts` 递给 `registerBuiltinAdapters` 的 `inbound` 换成空函数,这条红
	// (入站的下一层没接上:适配器交来的消息核过归属也到不了指令分发 / 链接解析)。
	it("入站的下一层接上了适配器上下文:适配器经 ctx.inbound 交一条自己连接的群消息,到了 compose 交出去的下一层,平台取连接上的", async () => {
		const group = vi.fn();
		const connection = {
			id: "ob-1",
			name: "napcat",
			enabled: true,
			adapterKey: "onebot",
			platform: "onebot",
			settings: {},
			platformSnapshot: {},
		} as unknown as Connection;
		const { builtins } = compose({
			inbound: { private: vi.fn(), group },
			connections: () => [connection],
		});
		const adapters = await builtins.registerAdapters();
		const ctx = startedCtx.onebot as PlatformAdapterContext;
		const msg = {
			address: "g1",
			senderId: "u1",
			text: "hi",
			sharedLinks: [],
		};
		ctx.inbound.group(msg, { connectionId: "ob-1" });
		expect(group).toHaveBeenCalledWith(msg, { connectionId: "ob-1", platform: "onebot" });
		await adapters.dispose();
	});

	// 验红:把 `compose.ts` 里某个工厂的 `loggerOf("onebot")` 写成 `loggerOf("webhook")`(任何一个换成别的键),这条红
	// (要日志器的键对不上它登进登记表的 `adapterKey`:等级会跟到别的适配器那一格上)。
	it("三个适配器各按自己的适配器键要日志器,键等于它们登进登记表的 adapterKey", async () => {
		const { builtins, adapterRegistry, forSubsystem } = compose();
		const adapters = await builtins.registerAdapters();
		const registered = adapterRegistry.list().map((adapter) => adapter.adapterKey);
		expect(registered).toEqual(["onebot", "qq-official", "webhook"]);
		// 适配器的日志器标签与等级键都是适配器键(造适配器与建它的集成上下文各要一次,同一对);B 站那几个(上报器)不在这里数。
		const asked = [
			...new Set(
				forSubsystem.mock.calls
					.filter(([name]) => name !== BILIBILI_SOURCE_KEY)
					.map(([name, levelKey]) => JSON.stringify([name, levelKey])),
			),
		];
		expect(asked).toEqual(registered.map((key) => JSON.stringify([key, key])));
		await adapters.dispose();
	});

	// 验红:`compose.ts` 里建分层上报器的日志器改成别的格(比如 `forSubsystem("core", "core")`),这条红。

	// 验红:造 OneBot / QQ 官方机器人时不把 `deps.serviceCtx` 递给工厂,这条红(关停兜底没挂上)。
	it("适配器在 compose 时就造好:OneBot 与 QQ 官方机器人各往 serviceCtx 挂了一个关停兜底", () => {
		const { onDispose } = compose();
		expect(onDispose).toHaveBeenCalledTimes(2);
		expect(onDispose).toHaveBeenCalledWith(expect.any(Function), "stop");
	});
});
