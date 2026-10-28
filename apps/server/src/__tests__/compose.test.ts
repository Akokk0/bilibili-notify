/**
 * 🔴 **组装根 `compose.ts` 的接线要有自己的守卫。**
 *
 * 零件(开发场景、登记表、B 站来源)各自的测试全绿,证明不了 `compose.ts` 真用对了认领键、真只挑 B 站订阅、
 * 真没在门没开时提前调工厂、真把同一个壳递给了来源和场景 —— 这些剪断了,别的测试一条都不会红。
 * 这里用真的 `createBiliDevtools`(测试进程里解析到的是真入口,换桩只挂在打包配置上)外面包一层 spy,
 * 来源用真的 B 站来源 + 真的 `DynamicPoller`(假 `Api`,全程不外连),逐条钉。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	type ServiceContext,
	type SourceAuth,
	type SourceContext,
	type SourceSubscriptionView,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeServiceContext } from "../bilibili/api/__tests__/support/make-api.js";
import { Api } from "../bilibili/api/index.js";
import { inertAccountImages } from "../bilibili/auth/__tests__/support/auth-deps.js";
import {
	authWorld,
	C0,
	stallRenewalAtConfirm,
} from "../bilibili/auth/__tests__/support/auth-world.js";
import { LoginFlow } from "../bilibili/auth/login-flow.js";
import { createBiliDevtools } from "../bilibili/devtools/index.js";
import { observeLiveConnections } from "../bilibili/live/protocol/client.js";
import { settingsSegment } from "../bilibili/settings.js";
import {
	BUILTIN_INTEGRATION_SETTINGS,
	type BuiltinIntegrationsDeps,
	composeBuiltinIntegrations,
} from "../compose.js";
import { createDevtoolsProviderRegistry } from "../devtools/providers.js";
import type { LocaleReader } from "../i18n/locale-reader.js";
import { createPlatformAdapterRegistry } from "../push/registry.js";
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
		signal: new AbortController().signal,
		reportPost,
		fetchImage,
		reportProblem: vi.fn(),
		resolveProblem: vi.fn(),
		registerLinkResolver: vi.fn(() => ({ dispose() {} })),
		registerAiToolProvider: vi.fn(() => ({ dispose() {} })),
	} as unknown as SourceContext;
	return { ctx, reportPost, fetchImage };
}

/** 假推送链路:`registerSource` 里直接 `await entry.source.start(假 ctx)`,记下每次登记。 */
function makeFakePipeline(ctx: SourceContext) {
	const registered: Array<{
		sourceKey: string;
		source: { stop(): Promise<void> };
		integration: IntegrationContext;
		logger: Logger;
	}> = [];
	const pipeline = {
		registerSource: vi.fn(async (entry: (typeof registered)[number] & { source: never }) => {
			registered.push(entry);
			await (entry.source as { start(ctx: SourceContext): Promise<void> }).start(ctx);
		}),
	};
	return { pipeline: pipeline as never, registered, registerSource: pipeline.registerSource };
}

function compose(
	opts: {
		/** 语言读口:不给就是一直不变的;要切语言的用例给 `switchableLocale()`。 */
		locale?: LocaleReader;
		/** 入站的下一层:不给就是两个空函数。 */
		inbound?: BuiltinIntegrationsDeps["inbound"];
		/** 全部连接:不给就是空名单。 */
		connections?: () => readonly Connection[];
		/** 集成存储宿主:不给就是内存版(只记开着的键);看盘上内容的用例给真的。 */
		integrationStore?: BuiltinIntegrationsDeps["integrationStore"];
		/** B 站那一格的宿主上下文:不给就是每对(标签,键)一个带 spy 日志器的假上下文;看关停次序的用例给假时钟那个。 */
		biliServiceCtx?: ServiceContext;
	} = {},
) {
	const adapterRegistry = createPlatformAdapterRegistry();
	// 工厂创建时只往 serviceCtx 挂关停兜底(OneBot、QQ 官方各一个);连接名单是空的,适配器 start 不开监听。
	// B 站的上下文收尾钩子也在构造时就登记在这里(`stop` 段)。
	const onDispose = vi.fn<(fn: () => void | Promise<void>, phase?: string) => void>();
	// 与真的一样:同一对(标签,键)交回同一个上下文,日志器各不相同,好分辨「这个日志器是按哪一对要来的」。
	const subsystems = new Map<string, ServiceContext>();
	// 核心自己的日志器(`serviceCtx.logger`):也是 spy,好断言集成的行没有落到它上面。
	const coreLogger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	const forSubsystem = vi.fn((name: string, levelKey: string) => {
		if (opts.biliServiceCtx && name === BILIBILI_SOURCE_KEY && levelKey === BILIBILI_SOURCE_KEY) {
			return opts.biliServiceCtx;
		}
		const key = JSON.stringify([name, levelKey]);
		let ctx = subsystems.get(key);
		if (!ctx) {
			// 日志器是 spy:好看出一行日志落在了哪一对(标签,键)的日志器上;定时器是假时钟(不碰真定时器)。
			ctx = makeServiceContext({
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
			}).serviceCtx;
			subsystems.set(key, ctx);
		}
		return ctx;
	});
	const memoryStore = memoryIntegrationStore();
	const deps = {
		locale: opts.locale ?? fixedLocale(),
		setTimeout: () => ({ dispose() {} }),
		accountImages: inertAccountImages,
		serviceCtx: { onDispose, forSubsystem, logger: coreLogger } as never,
		transitImages: inertTransitImages,
		inbound: opts.inbound ?? { private: () => {}, group: () => {} },
		adapterRegistry,
		integrationStore: opts.integrationStore ?? memoryStore,
		problems: ignoredProblems,
		settingsOf: inertSettingsOf,
		connections: opts.connections ?? (() => []),
		onConnectionsChanged: () => ({ dispose() {} }),
	};
	/** 跑关停的 `stop` 段:后登记的先跑(与 `NodeServiceContext` 同),一个跑完再跑下一个。 */
	const runStopHooks = async (): Promise<void> => {
		const stops = onDispose.mock.calls.filter(([, phase]) => phase === "stop").map(([fn]) => fn);
		for (const fn of stops.reverse()) await fn();
	};
	return {
		builtins: composeBuiltinIntegrations(deps),
		deps,
		adapterRegistry,
		/** 内存版存储宿主(记开着的键);用例给了真的 `integrationStore` 时它是空的,别在那种用例里读。 */
		integrationStore: memoryStore,
		onDispose,
		runStopHooks,
		forSubsystem,
		subsystems,
		coreLogger,
	};
}

// 登录那一套是真的(`registerSources` 里造、起、停):账号探测与网络都不碰,探测的口换成空操作。
let spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
	vi.mocked(createBiliDevtools).mockClear();
	spies = [vi.spyOn(LoginFlow.prototype, "reportAccountInfo").mockResolvedValue()];
});

afterEach(() => {
	// 工厂会装全局的直播连接观察钩子;测完摘掉,别漏给同进程里的别的测试。
	observeLiveConnections(null);
	vi.useRealTimers();
	for (const spy of spies) spy.mockRestore();
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

	// 验红:把 `compose.ts` 递给 `createBiliDevtools` 的东西换回核心的订阅表 / 总线,或 `source` 交的不是登记进去的
	// 那个来源,这条红。
	it("开发场景只拿 B 站来源一个把手:来源造好之前取不到;登记之后就是那个来源,名单是它 ctx 那一份", async () => {
		const { builtins } = compose();
		builtins.provideDevtools(createDevtoolsProviderRegistry());
		const handed = vi.mocked(createBiliDevtools).mock.calls[0]?.[0];
		if (!handed) throw new Error("createBiliDevtools 没被调");
		expect(Object.keys(handed)).toEqual(["source"]);
		expect(handed.source()).toBeUndefined();

		const roster = [
			{ externalId: "100", features: new Set(["post"] as const), monitorsLive: false },
		];
		const { pipeline, registered } = makeFakePipeline(makeFakeSourceCtx(roster).ctx);
		await builtins.registerSources(pipeline);

		expect(handed.source()).toBe(registered[0]?.source);
		expect(handed.source()?.subscriptions()).toBe(roster);
		await registered[0]?.source.stop();
	});

	it("provideDevtools 没被调时,B 站的工厂一次都没被调(门没开的性质)", () => {
		compose();
		expect(createBiliDevtools).not.toHaveBeenCalled();
	});
});

describe("composeBuiltinIntegrations · 登记 B 站来源", () => {
	// 验红:把 `compose.ts` 里收上下文的钩子挪到 `registerSources` 里登记(晚于推送链路),这条红(构造时只剩两个适配器的兜底),
	// 关停次序那一组也红。
	it("构造时就在关停的 stop 段登记了收 B 站上下文的钩子(与两个适配器的兜底一起共三个),registerSources 不再多登记", async () => {
		const { builtins, onDispose } = compose();
		expect(onDispose).toHaveBeenCalledTimes(3);
		expect(onDispose.mock.calls.map(([, phase]) => phase)).toEqual(["stop", "stop", "stop"]);

		const { pipeline, registered } = makeFakePipeline(makeFakeSourceCtx([]).ctx);
		await builtins.registerSources(pipeline);
		expect(onDispose).toHaveBeenCalledTimes(3);
		await registered[0]?.source.stop();
	});

	// 验红:把开上下文挪进 `compose()` 构造里(或 registerSources 之前),第一句红;不开,第二句红。
	it("registerSources 之前不开 B 站存储,之后开了;收尾钩子一跑存储把手就关", async () => {
		const { builtins, integrationStore, runStopHooks } = compose();
		expect(integrationStore.openKeys()).toEqual([]);
		const { pipeline, registered } = makeFakePipeline(makeFakeSourceCtx([]).ctx);

		await builtins.registerSources(pipeline);

		expect(integrationStore.openKeys()).toEqual([BILIBILI_SOURCE_KEY]);
		await registered[0]?.source.stop();
		await runStopHooks();
		expect(integrationStore.openKeys()).toEqual([]);
	});

	// 验红:把 `compose.ts` 里递给 `createBiliSource` 的 `serviceCtx` 换成 `deps.serviceCtx`(核心那一格),或把
	// `forSubsystem("dynamic", …)` 的键换成 `"core"`,这条红。
	it("日志跟 B 站那一格:登录那一套的行落在(bilibili, bilibili)的日志器上,核心的日志器一行没有;来源登记项带的是 dynamic 那一格", async () => {
		const { builtins, forSubsystem, subsystems, coreLogger } = compose();
		const { pipeline, registered } = makeFakePipeline(makeFakeSourceCtx([]).ctx);
		await builtins.registerSources(pipeline);

		expect(forSubsystem).toHaveBeenCalledWith(BILIBILI_SOURCE_KEY, BILIBILI_SOURCE_KEY);
		const bili = subsystems.get(JSON.stringify([BILIBILI_SOURCE_KEY, BILIBILI_SOURCE_KEY]));
		expect(bili?.logger.info).toHaveBeenCalledWith("[auth] 账号未登录，等待扫码登录");
		expect(coreLogger.info).not.toHaveBeenCalled();
		expect(coreLogger.debug).not.toHaveBeenCalled();
		const index = forSubsystem.mock.calls.findIndex(
			([name, key]) => name === "dynamic" && key === BILIBILI_SOURCE_KEY,
		);
		expect(index).toBeGreaterThanOrEqual(0);
		expect(registered[0]?.logger).toBe(forSubsystem.mock.results[index]?.value.logger);
		await registered[0]?.source.stop();
	});

	it("registerSources 按 B 站的键登记了一次,integration 是 B 站自己的上下文(带 cookie 罐的口);调第二次抛", async () => {
		const { builtins } = compose();
		const { pipeline, registered, registerSource } = makeFakePipeline(makeFakeSourceCtx([]).ctx);
		await builtins.registerSources(pipeline);
		expect(registerSource).toHaveBeenCalledTimes(1);
		expect(registered[0]?.sourceKey).toBe(BILIBILI_SOURCE_KEY);
		expect(registered[0]?.integration).toHaveProperty("cookies.jar");
		await expect(builtins.registerSources(pipeline)).rejects.toThrow("already registered");
		await registered[0]?.source.stop();
	});

	// 验红:把 `createBiliSource` 里 `start` 第一步的 `await login.start()` 去掉,这条红(读到 confirming:开机探活还没落定)。
	it("来源 start 落定时登录已经恢复:没有 cookie 就是已经「未登录」,不是还在「确认中」", async () => {
		const { builtins } = compose();
		const { pipeline, registered } = makeFakePipeline(makeFakeSourceCtx([]).ctx);

		await builtins.registerSources(pipeline);

		const source = registered[0]?.source as unknown as { auth: SourceAuth; stop(): Promise<void> };
		expect(source.auth.state()).toEqual({ status: "logged-out" });
		await source.stop();
	});

	// 验红:把 `compose.ts` 递给 `createBiliSource` 的 `devShells` 去掉(开发壳钩子不往来源里递),这条红
	// (场景盖的壳没有被来源挂到 `Source.auth` 上,登记表与 `/api/sources/:sourceKey/auth` 读到的还是真的)。
	it("开发版:来源挂的登录口是场景盖得到的那一层壳;不走 provideDevtools(生产)就是登录系统的原样", async () => {
		const dev = compose();
		const providers = createDevtoolsProviderRegistry();
		dev.builtins.provideDevtools(providers);
		const fakeDev = makeFakePipeline(makeFakeSourceCtx([]).ctx);
		await dev.builtins.registerSources(fakeDev.pipeline);
		const devSource = fakeDev.registered[0]?.source as unknown as {
			auth: SourceAuth;
			stop(): Promise<void>;
		};
		const scenario = providers.scenarios().find((s) => s.id === "bilibili.auth.login-state");
		if (!scenario) throw new Error("没有登录状态的场景");
		await scenario.run({ status: "expired", uname: "", message: "devtools 假的" } as never);
		expect(devSource.auth.state()).toEqual({ status: "expired", message: "devtools 假的" });
		await devSource.stop();

		const prod = compose();
		const fakeProd = makeFakePipeline(makeFakeSourceCtx([]).ctx);
		await prod.builtins.registerSources(fakeProd.pipeline);
		const prodSource = fakeProd.registered[0]?.source as unknown as {
			auth: SourceAuth;
			stop(): Promise<void>;
		};
		expect(prodSource.auth.state()).toEqual({ status: "logged-out" });
		await prodSource.stop();
	});

	// 验红:把 `compose.ts` 里 `bilibili.api` 换成总是 undefined(或交真的 `Api` 而不是来源用的那一个),这条红。
	it("bilibili.api():来源还没造是 undefined;造好之后交来源用的那一个,开发版是套过壳的、盖了的方法它也盖得到", async () => {
		const fetchAllDynamic = vi
			.spyOn(Api.prototype, "fetchAllDynamic")
			.mockResolvedValue(EMPTY_FEED);
		spies.push(fetchAllDynamic);
		const { builtins } = compose();
		const providers = createDevtoolsProviderRegistry();
		builtins.provideDevtools(providers);
		expect(builtins.bilibili.api()).toBeUndefined();

		const fake = makeFakePipeline(makeFakeSourceCtx([]).ctx);
		await builtins.registerSources(fake.pipeline);

		const api = builtins.bilibili.api();
		expect(api).toBeDefined();
		expect(builtins.bilibili.api()).toBe(api);
		// 场景往壳上盖 fetchAllDynamic(回 -352):经交出来的那个读得到,说明交出来的就是壳、也就是来源与场景共用的那一个;
		// 盖板用完一次就摘,之后读到的是真的(这里换成了空 feed 的替身)。
		const scenario = providers.scenarios().find((s) => s.id === "bilibili.dynamic.fail");
		if (!scenario) throw new Error("没有动态拉取报错的场景");
		await scenario.run({ code: -352, rounds: 1 } as never);
		expect(await api?.fetchAllDynamic()).toMatchObject({ ok: false, code: "rate_limited" });
		expect(await api?.fetchAllDynamic()).toBe(EMPTY_FEED);
		await fake.registered[0]?.source.stop();
	});

	// 验红:把 `compose.ts` 递给 `createBiliSource` 的东西里漏掉 `devShells` 之外的 `locale` 之类不红;这条红的是
	// 「登录检查的口断了」:`start` 里读到的间隔不再经登录系统挂上(`login.setHealthCheckMs` 不被调)。
	it("来源 start 之后,登录系统收到登录检查的间隔(设置里的分钟数换成毫秒);stop 之后收到 0", async () => {
		const setHealthCheckMs = vi.spyOn(LoginFlow.prototype, "setHealthCheckMs");
		spies.push(setHealthCheckMs);
		const { builtins } = compose();
		const { pipeline, registered } = makeFakePipeline(makeFakeSourceCtx([]).ctx);

		await builtins.registerSources(pipeline);

		expect(setHealthCheckMs).toHaveBeenCalledTimes(1);
		expect(setHealthCheckMs).toHaveBeenLastCalledWith(30 * 60_000);
		await registered[0]?.source.stop();
		expect(setHealthCheckMs).toHaveBeenLastCalledWith(0);
	});

	describe("场景那头与来源那头是同一个壳(造动态的场景一路走到来源的 reportPost)", () => {
		const roster: SourceSubscriptionView[] = [
			{ externalId: "100", features: new Set(["post"]), monitorsLive: false },
		];
		const setup = () => {
			// 锚点 = 来源起来那一刻;场景造的假动态发布时间是「现在」,得晚于锚点至少一秒。
			vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-11T00:00:00Z") });
			const fetchAllDynamic = vi.fn(async () => EMPTY_FEED);
			spies.push(vi.spyOn(Api.prototype, "fetchAllDynamic").mockImplementation(fetchAllDynamic));
			// 场景给卡上的作者名现拉一次用户卡;拉不到就写 UID。
			spies.push(
				vi
					.spyOn(Api.prototype, "fetchUserCard")
					.mockResolvedValue(fail("unavailable", "测试不联网") as never),
			);
			const fetchImage = vi.fn(async () => fail("unavailable", "测试不联网"));
			const { builtins, deps, integrationStore } = compose();
			const { ctx, reportPost } = makeFakeSourceCtx(roster, fetchImage);
			const fake = makeFakePipeline(ctx);
			const providers = createDevtoolsProviderRegistry();
			builtins.provideDevtools(providers);
			const scenario = providers.scenarios().find((s) => s.id === "bilibili.dynamic.post");
			if (!scenario) throw new Error("没有造动态的场景");
			return { builtins, deps, fake, scenario, reportPost, fetchImage, integrationStore };
		};
		const runScenario = async (
			scenario: ReturnType<typeof setup>["scenario"],
			params: Record<string, string> = { creator: "100" },
		) => {
			vi.setSystemTime(new Date("2026-10-11T00:00:10Z"));
			return scenario.run(params as never);
		};

		// 壳要等来源造出登录系统才有(来源把真的递给开发壳钩子、换回壳):登记之前场景现取不到,回一句「还没起来」,不抛。
		it("登记之前跑同一个场景 → 回「B 站来源还没起来」(壳还没有),不抛", async () => {
			const { scenario } = setup();
			await expect(runScenario(scenario)).resolves.toMatchObject({
				summary: "B 站来源还没起来，先等它起来再试",
			});
		});

		it("登记之后跑 → 假 ctx 的 reportPost 收到那条假动态", async () => {
			const { builtins, fake, scenario, reportPost } = setup();
			await builtins.registerSources(fake.pipeline);
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
			await builtins.registerSources(fake.pipeline);
			try {
				await runScenario(scenario, { creator: "100", type: "draw" });
				expect(fetchImage).toHaveBeenCalled();
			} finally {
				await fake.registered[0]?.source.stop();
			}
		});

		// 「现在就跑」要的动态轮询不再经 `builtins.bilibili.dynamic` 取(那一格随 `Source.health()` 一起没了),
		// 改经场景那一头观察:报「动态轮询还没起来」= 动态轮询不在。
		it("登记抛了:错原样抛出去,上下文先收(存储把手关了),不留半个来源(场景仍报「动态轮询还没起来」),能重来", async () => {
			const { builtins, fake, scenario, reportPost, integrationStore } = setup();
			const boom = new Error("登记炸了");
			const pipeline = { registerSource: vi.fn().mockRejectedValueOnce(boom) } as never;
			await expect(builtins.registerSources(pipeline)).rejects.toBe(boom);
			expect(integrationStore.openKeys()).toEqual([]);
			await expect(runScenario(scenario)).resolves.toMatchObject({
				ok: false,
				code: "invalid",
				message: expect.stringContaining("动态轮询还没起来"),
			});
			// 锚点 = 来源起来那一刻:拨回起点再登记,场景那条假动态才晚于锚点。
			vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
			await builtins.registerSources(fake.pipeline);
			expect(integrationStore.openKeys()).toEqual([BILIBILI_SOURCE_KEY]);
			try {
				await runScenario(scenario);
				expect(reportPost).toHaveBeenCalledTimes(1);
			} finally {
				await fake.registered[0]?.source.stop();
			}
		});

		// 验红:去掉 `registerSources` 里 catch 中的 `registering = false`,或把造来源那几句挪回 try 之外,这条红。
		it("造来源那一步就同步抛了(还没到登记):上下文照样收、标志也复位,再调一次 registerSources 能成", async () => {
			const { builtins, deps, scenario, integrationStore } = setup();
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
			expect(integrationStore.openKeys()).toEqual([]);
			// 造来源在造登录系统之前就抛了:壳一个都没造,场景现取不到。
			await expect(runScenario(scenario)).resolves.toMatchObject({
				summary: "B 站来源还没起来，先等它起来再试",
			});
			Object.defineProperty(deps, "setTimeout", { configurable: true, value: original });
			const ok = makeFakePipeline(makeFakeSourceCtx([]).ctx);
			await builtins.registerSources(ok.pipeline);
			await ok.registered[0]?.source.stop();
		});

		it("来源停下后,场景又报「动态轮询还没起来」", async () => {
			const { builtins, fake, scenario } = setup();
			await builtins.registerSources(fake.pipeline);
			await runScenario(scenario);
			await fake.registered[0]?.source.stop();
			await expect(runScenario(scenario)).resolves.toMatchObject({
				ok: false,
				code: "invalid",
				message: expect.stringContaining("动态轮询还没起来"),
			});
		});
	});

	// 原 `auth-system-lifecycle.test.ts` 里「关停的次序」那几条搬到这里,期望值不动:上下文现在由 `compose.ts` 开与收,
	// 整条次序(先停登录、再最后一次存盘、再关存储把手)只有在这一层才钉得住。真集成存储宿主(临时目录)+ 真 Api / LoginFlow,
	// 只把会联网的几处换成替身;盘上是什么看 `secrets/bilibili/secrets.enc` 解开后的内容。
	describe("关停的次序", () => {
		let dataDir: string;
		beforeEach(async () => {
			dataDir = await mkdtemp(join(tmpdir(), "bn-compose-shutdown-"));
		});
		afterEach(async () => {
			await rm(dataDir, { recursive: true, force: true });
		});

		/**
		 * 与真入口同一个先后:`compose()` 之后、`registerSources` 之前,推送链路的关停钩子先登记(`createPipelineRuntime` 登记的那个:
		 * 它停来源);compose 的收上下文钩子在构造时就登记了,所以关停时推送链路的先跑。
		 */
		function setupShutdown(logger?: Logger) {
			const w = authWorld(dataDir, logger);
			const c = compose({ integrationStore: w.store, biliServiceCtx: w.host.serviceCtx });
			const fake = makeFakePipeline(makeFakeSourceCtx([]).ctx);
			c.onDispose(async () => {
				await (fake.registered[0]?.source as { stop(): Promise<void> } | undefined)?.stop();
			}, "stop");
			return { w, c, fake };
		}

		// 验红:把 `compose.ts` 里收上下文的钩子挪到 `registerSources` 里登记(晚于推送链路),这条红(上下文先收、登录后停)。
		it("续期停在确认之前时关停:盘上还是旧的一对(闸还在,不存中间状态)", async () => {
			const { w, c, fake } = setupShutdown();
			await w.seed({ cookies: C0, token: "T0" });
			const stalled = stallRenewalAtConfirm();

			// 开机顺带触发一次续期(盘上有令牌)。
			await c.builtins.registerSources(fake.pipeline);
			const api = c.builtins.bilibili.api();
			if (!api) throw new Error("来源没造出来");
			stalled.setJar(w.jarOf(api));
			await stalled.reached;

			await c.runStopHooks();
			stalled.releaseConfirm({ code: 0 });
			await Promise.all(w.host.tracked);
			await w.store.close();

			const disk = await w.disk();
			expect(disk.get("refreshToken")).toBe("T0");
			expect(String(disk.get("http.cookies"))).toContain("sess0");
			expect(String(disk.get("http.cookies"))).not.toContain("sess1");
		});

		// 验红:同上(收上下文的钩子晚于推送链路登记),这条红(没先停 Api,迟到的链去提交、撞上已关的写道:记 error)。
		it("停 Api 的收尾排在最后一次存盘之前:关停后迟到的确认回应是「被取代」,不是去撞已关的写道", async () => {
			const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
			const { w, c, fake } = setupShutdown(logger);
			await w.seed({ cookies: C0, token: "T0" });
			const stalled = stallRenewalAtConfirm();
			await c.builtins.registerSources(fake.pipeline);
			const api = c.builtins.bilibili.api();
			if (!api) throw new Error("来源没造出来");
			stalled.setJar(w.jarOf(api));
			await stalled.reached;

			// 确认回应在关停进行的当口到:Api 必须已经先停了(否则这条链醒来就去提交)。
			const stopping = c.runStopHooks();
			stalled.releaseConfirm({ code: 0 });
			await stopping;
			await Promise.all(w.host.tracked);
			await w.store.close();

			// 先停了 Api:迟到的链看见自己被取代,安静丢弃。没先停的话,它会去提交,撞上已经关掉的写道:记 error。
			expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("被取代"));
			expect(logger.error).not.toHaveBeenCalled();
			expect(logger.info).not.toHaveBeenCalledWith("[auth] 登录续期已落盘");
		});

		it("没有在途续期、罐子里有没存的变化时关停:最后一次存盘落了,存储把手关了", async () => {
			const { w, c, fake } = setupShutdown();
			await w.seed({ cookies: C0 });
			await c.builtins.registerSources(fake.pipeline);
			const api = c.builtins.bilibili.api();
			if (!api) throw new Error("来源没造出来");
			// 假时钟不推进:攒着的那一下根本没到点。
			w.jarOf(api).setFromSetCookie(
				"stray=late; Domain=.bilibili.com; Path=/",
				"https://www.bilibili.com",
			);
			expect(w.store.isOpen("bilibili")).toBe(true);

			await c.runStopHooks();
			expect(w.store.isOpen("bilibili")).toBe(false);
			await w.store.close();

			expect(String((await w.disk()).get("http.cookies"))).toContain("stray");
		});

		it("收上下文的钩子幂等:关停跑两遍不抛,存储把手只关一次", async () => {
			const { w, c, fake } = setupShutdown();
			await c.builtins.registerSources(fake.pipeline);

			await c.runStopHooks();
			await c.runStopHooks();

			expect(w.store.isOpen("bilibili")).toBe(false);
			await w.store.close();
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
		const squatter = await adapterRegistry.register(
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

	// 验红:造 OneBot / QQ 官方机器人时不把 `deps.serviceCtx` 递给工厂,这条红(关停兜底没挂上)。
	// (B 站收上下文的钩子是第三个,见「登记 B 站来源」第一条。)
	it("适配器在 compose 时就造好:OneBot 与 QQ 官方机器人各往 serviceCtx 挂了一个关停兜底", () => {
		const { onDispose } = compose();
		expect(onDispose).toHaveBeenCalledTimes(3);
		expect(onDispose).toHaveBeenCalledWith(expect.any(Function), "stop");
	});
});
