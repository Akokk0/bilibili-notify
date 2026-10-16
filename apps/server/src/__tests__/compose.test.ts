/**
 * 🔴 **组装根 `compose.ts` 的接线要有自己的守卫。**
 *
 * 零件(开发场景、登记表、B 站来源)各自的测试全绿,证明不了 `compose.ts` 真用对了认领键、真只挑 B 站订阅、
 * 真没在门没开时提前调工厂、真把同一个壳递给了来源和场景 —— 这些剪断了,别的测试一条都不会红。
 * 这里用真的 `createBiliDevtools`(测试进程里解析到的是真入口,换桩只挂在打包配置上)外面包一层 spy,
 * 来源用真的 B 站来源 + 真的 `DynamicPoller`(假 `Api`,全程不外连),逐条钉。
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CookieJar, HttpClient } from "@bilibili-notify/http";
import {
	BILIBILI_GUARD_PROGRAM,
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
import { GUARD_ICON_REQUEST_HEADERS, type GuardIcons } from "../bilibili/live/guard-icons.js";
import { observeLiveConnections } from "../bilibili/live/protocol/client.js";
import { settingsSegment } from "../bilibili/settings.js";
import { BUILTIN_INTEGRATION_SETTINGS, composeBuiltinIntegrations } from "../compose.js";
import { overridableApi } from "../devtools/api-overrides.js";
import { createDevtoolsProviderRegistry } from "../devtools/providers.js";
import { createImageStore, IMAGE_GRACE_MS, type ImageStore } from "../images/image-store.js";
import { createPlatformAdapterRegistry } from "../push/registry.js";
import { createNodeMessageBus } from "../runtime/message-bus.js";
import { putImage } from "./support/chat-images.js";
import { ignoredProblems } from "./support/ignored-problems.js";
import { memoryIntegrationStore } from "./support/memory-key-value-store.js";
import { png } from "./support/report-images.js";

// 请求客户端换成「照真的造、记下构造参数与实例」的包一层:自建徽章请求客户端那一支要看它拿了什么请求头(不联网)。
vi.mock("@bilibili-notify/http", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@bilibili-notify/http")>();
	return {
		...actual,
		// 用子类而不是箭头函数:箭头函数不能 `new`(biome 会把写成 function 的包装自动改成箭头)。
		HttpClient: vi.fn(class extends actual.HttpClient {}),
	};
});

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
		registerLinkResolver: vi.fn(() => ({ dispose() {} })),
	} as unknown as SourceContext;
	return { ctx, reportPost };
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
		fetchImage?: ReturnType<typeof vi.fn>;
		sourceAuth?: SourceAuth;
		/** 图库:不给就是个只记登记的假的;要看「来源声明的图」真进了图库的用例给真的。 */
		imageStore?: Pick<ImageStore, "register">;
		/** 抓徽章图的请求客户端:不给就是个连不上的假的(不联网);显式传 `undefined` = 真的不给(走自建那一支)。 */
		guardIconHttp?: Pick<HttpClient, "fetch">;
	} = {},
) {
	const subs = opts.subs ?? [];
	const attachGuardIcons = vi.fn<(icons: GuardIcons) => void>();
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
		imageStore: opts.imageStore ?? { register: vi.fn(() => ({}) as never) },
		guardIconHttp: Object.hasOwn(opts, "guardIconHttp")
			? opts.guardIconHttp
			: { fetch: async () => fail("unavailable", "测试不联网") },
		attachGuardIcons,
		live: () => undefined,
		fans: () => undefined,
		healthCheck: () => undefined,
		serviceCtx: { onDispose, forSubsystem, logger: coreLogger } as never,
		onInboundPrivate: () => {},
		onInboundGroup: () => {},
		adapterRegistry,
		integrationStore,
		problems: ignoredProblems,
		connections: () => [],
		onConnectionsChanged: () => ({ dispose() {} }),
	};
	return {
		builtins: composeBuiltinIntegrations(deps),
		deps,
		setHealthCheckMs,
		attachGuardIcons,
		fetchImage,
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
			await expect(runScenario(scenario)).rejects.toThrow("动态引擎还没起来");
			Object.defineProperty(deps, "imageFetcher", { configurable: true, value: original });
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

describe("composeBuiltinIntegrations · 大航海徽章图", () => {
	const TIERS = Array.isArray(BILIBILI_GUARD_PROGRAM.tiers) ? BILIBILI_GUARD_PROGRAM.tiers : [];
	let imagesDir: string;
	let store: ImageStore | undefined;
	beforeEach(async () => {
		imagesDir = await mkdtemp(join(tmpdir(), "bn-compose-guard-icons-"));
	});
	afterEach(async () => {
		await store?.close();
		store = undefined;
		await rm(imagesDir, { recursive: true, force: true });
	});

	/** 假的请求客户端:每个徽章地址回一张互不相同的 png;`down` 时回连不上。 */
	function fakeHttp(down = false): Pick<HttpClient, "fetch"> {
		return {
			fetch: async (url) => {
				if (down) return fail("unavailable", "连不上");
				const index = TIERS.findIndex((t) => t.icon?.url === String(url));
				return okResult({
					url: String(url),
					status: 200,
					headers: new Headers(),
					body: png(8, 8, 10 + index),
					isSuccess: true,
					text: () => "",
					json: () => fail("invalid", "不是 json"),
				});
			},
		};
	}

	// 验红:删掉 `compose.ts` 里 `deps.attachGuardIcons(guardIcons)` 那一句,这条红(运行时拿不到徽章图:引擎、卡片路由读它会抛)。
	it("造好就当场交给运行时:attachGuardIcons 收到一份,它就是抓图的那一个", async () => {
		store = createImageStore({ dir: imagesDir });
		const { attachGuardIcons } = compose({ imageStore: store, guardIconHttp: fakeHttp() });
		expect(attachGuardIcons).toHaveBeenCalledTimes(1);
		const icons = attachGuardIcons.mock.calls[0]?.[0];
		await icons?.ensure();
		expect(icons?.refs()).toHaveLength(3);
		expect(icons?.iconOf("captain")).toBeDefined();
	});

	// 验红:把 `compose.ts` 里这一家的 `listRefs` 改成 `async () => []`,三张徽章过了宽限期被清扫收走,这条红。
	it("图库里多了「来源声明的图」这一家:名单是手里抓到的那几张,清扫留着它们、照收野图", async () => {
		store = createImageStore({ dir: imagesDir });
		const stray = store.register({ name: "测试野图", listRefs: async () => [] });
		const { attachGuardIcons } = compose({ imageStore: store, guardIconHttp: fakeHttp() });
		const icons = attachGuardIcons.mock.calls[0]?.[0];
		await icons?.ensure();
		const refs = icons?.refs() ?? [];
		expect(refs).toHaveLength(3);
		const strayRef = await putImage(stray, png(4, 4, 99));

		const usage = await store.usage();
		for (const ref of refs) {
			expect(usage.find((u) => u.ref === ref)?.holders).toEqual(["来源声明的图"]);
		}
		const swept = await store.sweep({ now: new Date(Date.now() + IMAGE_GRACE_MS + 3_600_000) });
		expect(swept.removed).toEqual([strayRef]);
		expect(await readdir(imagesDir)).toHaveLength(3);
	});

	it("抓不到:ensure() 不抛、iconOf 给 undefined、名单为空", async () => {
		store = createImageStore({ dir: imagesDir });
		const { attachGuardIcons } = compose({ imageStore: store, guardIconHttp: fakeHttp(true) });
		const icons = attachGuardIcons.mock.calls[0]?.[0];
		await expect(icons?.ensure()).resolves.toBeUndefined();
		expect(icons?.iconOf("captain")).toBeUndefined();
		expect(icons?.refs()).toEqual([]);
	});

	// 验红:把 `compose.ts` 里自建客户端的 `headers: GUARD_ICON_REQUEST_HEADERS` 换成 `{}`,或删掉 `deps.serviceCtx.onDispose(() => http.dispose(), "drain")`,这条红。
	it("没给 guardIconHttp:自建的请求客户端用徽章专用请求头、不带 cookie,并往 drain 段挂收连接的钩子", async () => {
		vi.mocked(HttpClient).mockClear();
		const { onDispose } = compose({ guardIconHttp: undefined });

		expect(vi.mocked(HttpClient)).toHaveBeenCalledTimes(1);
		const options = vi.mocked(HttpClient).mock.calls[0]?.[0];
		expect(options?.headers).toEqual(GUARD_ICON_REQUEST_HEADERS);
		expect(Object.keys(options?.headers ?? {}).map((name) => name.toLowerCase())).not.toContain(
			"cookie",
		);
		// 新开的空罐子,不借 B 站接口那个
		expect(options?.jar).toBeInstanceOf(CookieJar);

		const drains = onDispose.mock.calls.filter(([, phase]) => phase === "drain");
		expect(drains).toHaveLength(1);
		const client = vi.mocked(HttpClient).mock.results[0]?.value as HttpClient;
		const dispose = vi.spyOn(client, "dispose");
		await drains[0]?.[0]();
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	// 验红:把 `compose.ts` 里 `if (!guardIconHttp)` 改成恒真(给了也自建),这条红。
	it("给了 guardIconHttp:不自建请求客户端、不往 drain 段挂钩子", () => {
		vi.mocked(HttpClient).mockClear();
		const { onDispose } = compose({ guardIconHttp: fakeHttp() });
		expect(vi.mocked(HttpClient)).not.toHaveBeenCalled();
		expect(onDispose.mock.calls.filter(([, phase]) => phase === "drain")).toEqual([]);
	});

	// 验红:`compose.ts` 里 `biliLogger` 的键换成 `core`(标签不换),或整个换成核心的日志器,这条红。
	it("徽章图的日志器是 B 站那一格(标签 bilibili、键来源键):抓不到的那行 warn 只落在它上面", async () => {
		store = createImageStore({ dir: imagesDir });
		const { attachGuardIcons, forSubsystem, subsystems, coreLogger } = compose({
			imageStore: store,
			guardIconHttp: fakeHttp(true),
		});
		await attachGuardIcons.mock.calls[0]?.[0]?.ensure();

		const bili = forSubsystem(BILIBILI_SOURCE_KEY, BILIBILI_SOURCE_KEY).logger;
		expect(bili.warn).toHaveBeenCalled();
		for (const [pair, ctx] of subsystems) {
			if (ctx.logger !== bili) expect(ctx.logger.warn, pair).not.toHaveBeenCalled();
		}
		expect(coreLogger.warn).not.toHaveBeenCalled();
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
	it("B 站分层上报器的日志器是 B 站那一格(标签与键都是来源键):它的 warn 落在那个日志器上", () => {
		const { builtins, forSubsystem } = compose();
		const biliIndex = forSubsystem.mock.calls.findIndex(
			([name, key]) => name === BILIBILI_SOURCE_KEY && key === BILIBILI_SOURCE_KEY,
		);
		expect(biliIndex).toBeGreaterThanOrEqual(0);
		const bili = forSubsystem.mock.results[biliIndex]?.value.logger as Logger;
		// 核心那头(attach 的上下文)抛了:上报器吞下并记一行 warn,这一行该落在 B 站的日志器上。
		builtins.bilibili.problems.attach({
			reportProblem: () => {
				throw new Error("核心炸了");
			},
			resolveProblem: () => {},
		});
		expect(bili.warn).toHaveBeenCalled();
		for (const result of forSubsystem.mock.results) {
			if (result.value.logger !== bili) expect(result.value.logger.warn).not.toHaveBeenCalled();
		}
	});

	// 验红:造 OneBot / QQ 官方机器人时不把 `deps.serviceCtx` 递给工厂,这条红(关停兜底没挂上)。
	it("适配器在 compose 时就造好:OneBot 与 QQ 官方机器人各往 serviceCtx 挂了一个关停兜底", () => {
		const { onDispose } = compose();
		expect(onDispose).toHaveBeenCalledTimes(2);
		expect(onDispose).toHaveBeenCalledWith(expect.any(Function), "stop");
	});
});
