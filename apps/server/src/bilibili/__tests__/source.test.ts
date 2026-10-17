/**
 * B 站来源:`start(ctx)` 里造并启动动态引擎,`stop()` 里停它。
 *
 * 引擎用真的 `DynamicPoller`(假 `Api`,全程不外连);cron 换成惰性的假件,好数启停与新节奏。
 * 最后一组是「不用假名单」的端到端:真订阅仓 + 真来源上下文 + 真引擎,停用 / 启用 / 改全局作品开关逐个走一遍。
 */

import {
	BILIBILI_GUARD_PROGRAM,
	fail,
	type IntegrationContext,
	type LinkResolver,
	type Logger,
	ok,
	type PostReport,
	type Result,
	type SourceAuth,
	type SourceContext,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ZodType } from "zod";
import { deferred } from "../../__tests__/support/track-context.js";
import { createSettingsReader } from "../../integrations/settings-reader.js";
import { createLinkResolverRegistry } from "../../link-preview/registry.js";
import {
	makeIntegration,
	makeLogger,
	makeSettingsHost,
	makeSub,
	makeWorld,
	SOURCE_KEY,
} from "../../subscriptions/__tests__/fixtures.js";
import { registerBuiltinSource } from "../../subscriptions/builtin-sources.js";
import { createSourceRegistry } from "../../subscriptions/registry.js";
import type { Api } from "../api/index.js";
import { failureFromBili } from "../error-codes.js";
import { createProblemLayers } from "../problem-layers.js";
import { PROBLEM_TEXTS } from "../problem-texts.js";
import { type BiliSettings, BiliSettingsSchema } from "../settings.js";
import { createBiliSource } from "../source.js";

const cronMock = vi.hoisted(() => {
	const instances: Array<{
		cronTime: string;
		isActive: boolean;
		startCount: number;
		stopCount: number;
	}> = [];
	class FakeCronJob {
		isActive = false;
		startCount = 0;
		stopCount = 0;
		constructor(
			public cronTime: string,
			public onTick: () => void,
		) {
			instances.push(this);
		}
		start(): void {
			this.isActive = true;
			this.startCount++;
		}
		stop(): void {
			this.isActive = false;
			this.stopCount++;
		}
	}
	return { instances, FakeCronJob };
});
// 只换 `CronJob`:动态读者的「能解析」那一道用的是同一个包里的 `CronTime`,要留真的。
vi.mock("cron", async (importOriginal) => ({
	...(await importOriginal<typeof import("cron")>()),
	CronJob: cronMock.FakeCronJob,
}));

beforeEach(() => {
	cronMock.instances.length = 0;
});
afterEach(() => {
	vi.useRealTimers();
});

const EMPTY_FEED = ok({
	data: { has_more: false, items: [] as unknown[], offset: "", update_baseline: "", update_num: 0 },
});

/** 一条文字动态:作者是 `uid`,发布时间是 `pubTs`(秒)。 */
const item = (uid: number, pubTs: number, id = `id-${uid}-${pubTs}`) => ({
	basic: {},
	id_str: id,
	type: "DYNAMIC_TYPE_WORD",
	modules: {
		module_author: {
			face: "",
			following: false,
			jump_url: "",
			label: "",
			mid: uid,
			name: "UP",
			pub_action: "",
			pub_time: "",
			pub_ts: pubTs,
			type: "",
		},
		module_dynamic: {
			desc: { text: "正文", rich_text_nodes: [{ text: "正文", type: "RICH_TEXT_NODE_TYPE_TEXT" }] },
		},
	},
});

/** 来源上下文的 `settings` 那一格的假宿主:设置可换(整份),换了叫一声「可能变了」(与真仓一样只说变了、不交值)。 */
function makeConfig(initial: Partial<BiliSettings> = {}) {
	const host = makeSettingsHost(ok({ settings: BiliSettingsSchema.parse(initial) }));
	let current = BiliSettingsSchema.parse(initial);
	return {
		host,
		set(patch: Partial<BiliSettings>) {
			current = BiliSettingsSchema.parse({ ...current, ...patch });
			host.set(ok({ settings: current }));
		},
		/** 盘上读不懂:整个文件读不懂 / 某一格读不懂(给什么就是什么)。 */
		setRaw(raw: unknown) {
			host.set(ok({ settings: raw }));
		},
		setFailure(failure: Result<{ settings: unknown }>) {
			host.set(failure);
		},
		listeners: () => host.listenerCount(),
	};
}

function makeDeps(over: { cron?: string; fetchAllDynamic?: () => unknown } = {}) {
	const config = makeConfig(over.cron ? { dynamicCron: over.cron } : {});
	const fetchImage = vi.fn();
	const setHealthCheckMs = vi.fn<(ms: number) => void>();
	return {
		config,
		fetchImage,
		setHealthCheckMs,
		deps: {
			problems: {
				attach: vi.fn(),
				detach: vi.fn(),
				reportRisk: vi.fn(),
				resolveRisk: vi.fn(),
				reportFailure: vi.fn(),
				resolveFailure: vi.fn(),
			},
			api: { fetchAllDynamic: over.fetchAllDynamic ?? (async () => EMPTY_FEED) } as unknown as Api,
			bus: makeWorld().bus,
			imageFetcher: { fetchImage },
			loginCheck: { setHealthCheckMs },
			setTimeout: () => ({ dispose() {} }),
			auth: FAKE_AUTH,
		},
	};
}

/** 假登录口:来源只是原样挂着它。 */
const FAKE_AUTH: SourceAuth = {
	beginLogin: async () => ok(),
	logout: async () => ok(),
	state: () => ({ status: "logged-out" }),
	onChange: () => ({ dispose() {} }),
};

/**
 * 假来源上下文:名单与回调可控,`onSubscriptionsChanged` 的把手记下有没有被摘;`settings(schema)` 与真上下文
 * 同一个做法(真把手 + 假宿主),把手随 `dispose()` 一起收。
 */
function makeCtx(
	roster: Array<{ externalId: string; post: boolean }> = [],
	config: ReturnType<typeof makeConfig> = makeConfig(),
) {
	const watchers: Array<() => void> = [];
	const watchDisposed = vi.fn();
	const reportPost = vi.fn<(id: string, report: PostReport) => void>();
	const logger = makeLogger();
	const readers: Array<{ dispose(): void }> = [];
	const linkResolverDisposed = vi.fn();
	const registerLinkResolver = vi.fn((_resolver: LinkResolver) => ({
		dispose: linkResolverDisposed,
	}));
	const ctx = {
		logger: logger as Logger,
		settings: (schema: ZodType) => {
			const made = createSettingsReader({
				schema,
				read: config.host.read,
				onChanged: config.host.onChanged,
				logger,
			});
			readers.push(made);
			return made.reader;
		},
		subscriptions: () =>
			roster.map((r) => ({
				externalId: r.externalId,
				features: new Set(r.post ? (["post"] as const) : []),
			})),
		onSubscriptionsChanged: (fn: () => void) => {
			watchers.push(fn);
			return { dispose: watchDisposed };
		},
		reportPost,
		reportProblem: vi.fn(),
		resolveProblem: vi.fn(),
		registerLinkResolver,
	} as unknown as SourceContext;
	return {
		ctx,
		registerLinkResolver,
		linkResolverDisposed,
		watchers,
		watchDisposed,
		reportPost,
		logger,
		/** 收掉上下文:把手的宿主监听一起摘(登记表撤登记时真上下文做的事)。 */
		disposeContext: () => {
			for (const r of readers) r.dispose();
		},
	};
}

describe("createBiliSource", () => {
	it("对外交登录口:挂的就是传进来的那一份,登记表的视图带着它", async () => {
		const { deps } = makeDeps();
		const source = createBiliSource(deps);
		expect(source.auth).toBe(FAKE_AUTH);
		const registry = createSourceRegistry();
		const { ctx } = makeCtx();
		await registry.register("bilibili", source, ctx);
		expect(registry.get("bilibili")?.auth).toBe(FAKE_AUTH);
	});

	// 验红:删掉 `start` 里的 `ctx.registerLinkResolver(…)`,这条红(群里贴 B 站链接再没人认)。
	it("start 里登记 B 站的链接解析器:认 B 站视频链接、不认别家;stop 时把手被摘", async () => {
		const { deps } = makeDeps();
		const source = createBiliSource(deps);
		const { ctx, registerLinkResolver, linkResolverDisposed } = makeCtx();
		await source.start(ctx);
		expect(registerLinkResolver).toHaveBeenCalledTimes(1);
		const resolver = registerLinkResolver.mock.calls[0]?.[0];
		expect(resolver?.label).toBe("B 站");
		expect(resolver?.matches("https://www.bilibili.com/video/BV1zMtU6uEEb")).toBe(true);
		expect(resolver?.matches("https://example.com/video/BV1zMtU6uEEb")).toBe(false);
		expect(linkResolverDisposed).not.toHaveBeenCalled();
		await source.stop();
		expect(linkResolverDisposed).toHaveBeenCalledTimes(1);
	});

	it("描述符的 postNoun 是「动态」", () => {
		expect(createBiliSource(makeDeps().deps).descriptor.postNoun).toBe("动态");
	});

	it("描述符声明外部 id 是纯数字(UID),整串匹配", () => {
		expect(createBiliSource(makeDeps().deps).descriptor.externalIdRegex).toBe("^\\d+$");
	});

	it("描述符交出大航海这一套会员体系", () => {
		expect(createBiliSource(makeDeps().deps).descriptor.membershipPrograms).toEqual([
			BILIBILI_GUARD_PROGRAM,
		]);
	});

	it("start 后引擎在跑、dynamic() 拿得到;stop 后 dynamic() 是 undefined、把手都摘了、登录检查停掉", async () => {
		const { deps, config, setHealthCheckMs } = makeDeps();
		const source = createBiliSource(deps);
		const { ctx, watchDisposed, disposeContext } = makeCtx(
			[{ externalId: "1", post: true }],
			config,
		);
		expect(source.dynamic()).toBeUndefined();
		await source.start(ctx);
		expect(source.dynamic()?.isActive).toBe(true);
		expect(cronMock.instances[0]?.isActive).toBe(true);
		expect(setHealthCheckMs).toHaveBeenLastCalledWith(30 * 60_000);

		await source.stop();
		expect(source.dynamic()).toBeUndefined();
		expect(cronMock.instances[0]?.isActive).toBe(false);
		expect(watchDisposed).toHaveBeenCalledTimes(1);
		expect(setHealthCheckMs).toHaveBeenLastCalledWith(0);

		// stop 之后设置再变(上下文还没收):来源自己的订阅已摘,不会造出新的引擎、也不会再动登录检查。
		setHealthCheckMs.mockClear();
		config.set({ dynamicCron: "*/9 * * * *", healthCheckMinutes: 45 });
		expect(cronMock.instances).toHaveLength(1);
		expect(setHealthCheckMs).not.toHaveBeenCalled();

		// 登记表撤登记时上下文一起收掉:把手的宿主监听都摘了。
		expect(config.listeners()).toBeGreaterThan(0);
		disposeContext();
		expect(config.listeners()).toBe(0);
	});

	// 验红:删掉 source.ts `start` 里的 `deps.problems.attach(ctx)`,这条红。
	it("start 最后一步把上报器接上这个来源的上下文;stop 第一步摘下(在引擎停之前)", async () => {
		const { deps } = makeDeps();
		const order: string[] = [];
		deps.problems.attach.mockImplementation(() => void order.push("attach"));
		deps.problems.detach.mockImplementation(() => {
			order.push(`detach(引擎${source.dynamic()?.isActive ? "还在跑" : "已停"})`);
		});
		const source = createBiliSource(deps);
		const { ctx } = makeCtx([{ externalId: "1", post: true }]);
		await source.start(ctx);
		expect(deps.problems.attach).toHaveBeenCalledTimes(1);
		expect(deps.problems.attach).toHaveBeenCalledWith(ctx);
		expect(source.dynamic()).toBeDefined();

		await source.stop();
		expect(order).toEqual(["attach", "detach(引擎还在跑)"]);
	});

	// 验红:把 `attach` 挪进 `applyDynamic` 读得懂的那一支里(或只在引擎起来时才接),这条红。
	it("动态那格读不懂、引擎没造:上报器照样接上核心(登录失效、风控、直播间停监照常进问题表);stop 照常摘", async () => {
		const { deps, config } = makeDeps();
		config.setRaw({ dynamicCron: 123, healthCheckMinutes: 30 });
		const source = createBiliSource(deps);
		const { ctx } = makeCtx([{ externalId: "1", post: true }], config);

		await source.start(ctx);

		expect(source.dynamic()).toBeUndefined();
		expect(deps.problems.attach).toHaveBeenCalledTimes(1);
		expect(deps.problems.attach).toHaveBeenCalledWith(ctx);
		await source.stop();
		expect(deps.problems.detach).toHaveBeenCalledTimes(1);
	});

	// 验红:把 source.ts 递给引擎的 `problems: deps.problems` 换成别的对象,这条红。
	it("引擎用的就是来源的那个上报器:拉动态撞 -352 报到它身上", async () => {
		const { deps } = makeDeps({
			fetchAllDynamic: async () => failureFromBili(-352, "risk"),
		});
		const source = createBiliSource(deps);
		const { ctx } = makeCtx([{ externalId: "1", post: true }]);
		await source.start(ctx);
		await source.dynamic()?.detectNow();
		expect(deps.problems.reportRisk).toHaveBeenCalledWith("dynamic", { notify: true });
		await source.stop();
	});

	// 验红:删掉 `start` 里的 `attach`,这条红(真上报器 + 记录用的假 ctx,开机登录已失效)。
	it("真上报器:登录是 expired 时,start 之后核心那头收到一次 reportProblem(带私聊)", async () => {
		const { deps } = makeDeps();
		const problems = createProblemLayers({
			auth: {
				state: () => ({ status: "expired", message: "失效" }),
				onChange: () => ({ dispose() {} }),
			},
			logger: makeLogger(),
		});
		const source = createBiliSource({ ...deps, problems });
		const { ctx } = makeCtx();
		await source.start(ctx);
		expect(ctx.reportProblem).toHaveBeenCalledTimes(1);
		expect(ctx.reportProblem).toHaveBeenCalledWith({
			code: "auth_lost",
			message: PROBLEM_TEXTS.loginExpired.text,
			notify: true,
			recoveryMessage: PROBLEM_TEXTS.loginExpired.recovery,
		});
		await source.stop();
	});

	it("stop 的同步段里就停干净(登记表不等它)", () => {
		const { deps } = makeDeps();
		const source = createBiliSource(deps);
		const { ctx } = makeCtx([{ externalId: "1", post: true }]);
		return source.start(ctx).then(() => {
			void source.stop();
			// 没有 await:此刻已经停了。
			expect(source.dynamic()).toBeUndefined();
			expect(cronMock.instances[0]?.isActive).toBe(false);
		});
	});

	it("重复 start 抛", async () => {
		const { deps } = makeDeps();
		const source = createBiliSource(deps);
		const { ctx } = makeCtx();
		await source.start(ctx);
		await expect(source.start(ctx)).rejects.toThrow("already started");
		await source.stop();
	});

	it("名单变了的回调接到引擎:新增一个开着作品的人就起 cron", async () => {
		const { deps } = makeDeps();
		const source = createBiliSource(deps);
		const roster: Array<{ externalId: string; post: boolean }> = [];
		const { ctx, watchers } = makeCtx(roster);
		await source.start(ctx);
		expect(cronMock.instances).toHaveLength(0); // 空名单不起 job
		roster.push({ externalId: "1", post: true });
		for (const w of watchers) w();
		expect(cronMock.instances).toHaveLength(1);
		expect(cronMock.instances[0]?.isActive).toBe(true);
		await source.stop();
	});

	it("初始 cron 取自 B 站设置;cron 变了引擎换节奏,别的设置变了不动", async () => {
		const { deps, config } = makeDeps({ cron: "*/3 * * * *" });
		const source = createBiliSource(deps);
		const { ctx } = makeCtx([{ externalId: "1", post: true }], config);
		await source.start(ctx);
		expect(cronMock.instances[0]?.cronTime).toBe("*/3 * * * *");

		config.set({ healthCheckMinutes: 45 });
		expect(cronMock.instances).toHaveLength(1);

		config.set({ dynamicCron: "*/9 * * * *" });
		expect(cronMock.instances[0]?.stopCount).toBe(1);
		expect(cronMock.instances).toHaveLength(2);
		expect(cronMock.instances[1]?.cronTime).toBe("*/9 * * * *");
		await source.stop();
	});

	// 运行中由好变坏没有真实路径(写集成段的口都先过格式),这里用假读口造出来:照同一条规矩「哪格坏停哪样」。
	// 验红:`applyDynamic` 读不懂、引擎在的那一支什么都不做 → 动态不停;`applyLoginCheck` 不传 0 → 心跳不停。
	it("运行中动态与登录检查那两格从读得懂变成读不懂:引擎被停、dynamic() 回 undefined、报了问题;登录检查收到 0", async () => {
		const { deps, config, setHealthCheckMs } = makeDeps();
		const source = createBiliSource(deps);
		const { ctx } = makeCtx([{ externalId: "1", post: true }], config);
		await source.start(ctx);
		expect(source.dynamic()?.isActive).toBe(true);
		setHealthCheckMs.mockClear();

		config.setFailure(fail("invalid", "文件读不懂", { issues: [{ message: "Unexpected end" }] }));

		expect(source.dynamic()).toBeUndefined();
		expect(cronMock.instances[0]?.isActive).toBe(false);
		expect(setHealthCheckMs).toHaveBeenLastCalledWith(0);
		const reported = vi.mocked(ctx.reportProblem).mock.calls.map(([p]) => p.code);
		expect(reported).toEqual(["dynamic_settings_invalid", "login_check_settings_invalid"]);
		await source.stop();
	});

	// 验红:把 `applyDynamic` 里的 `ctx.resolveProblem` 挪到 `made.start()` 之前,这条红(起不来也把问题清了)。
	it("晚起时造引擎抛了别的错:没有往外抛、那一条问题还在、下一次设置变了再试", async () => {
		const { deps, config } = makeDeps();
		config.setRaw({ dynamicCron: 123, healthCheckMinutes: 30 });
		const source = createBiliSource(deps);
		const { ctx, logger } = makeCtx([{ externalId: "1", post: true }], config);
		await source.start(ctx);
		expect(source.dynamic()).toBeUndefined();
		const resolved = vi.mocked(ctx.resolveProblem);
		resolved.mockClear();

		// 引擎一起来就读名单:让名单读口炸一次。
		const roster = ctx.subscriptions;
		(ctx as { subscriptions: unknown }).subscriptions = () => {
			throw new Error("名单炸了");
		};
		expect(() => config.set({ dynamicCron: "*/5 * * * *" })).not.toThrow();

		expect(source.dynamic()).toBeUndefined();
		expect(cronMock.instances.every((c) => !c.isActive)).toBe(true);
		expect(resolved).not.toHaveBeenCalledWith(
			expect.objectContaining({ code: "dynamic_settings_invalid" }),
		);
		expect(logger.error.mock.calls.some(([m]) => String(m).includes("按新设置重来时抛错"))).toBe(
			true,
		);

		// 下一次变化再试:这回名单读得出来,引擎起来、问题清掉。
		(ctx as { subscriptions: unknown }).subscriptions = roster;
		config.set({ dynamicCron: "*/9 * * * *" });
		expect(source.dynamic()?.isActive).toBe(true);
		expect(resolved).toHaveBeenCalledWith({ code: "dynamic_settings_invalid", notify: false });
		await source.stop();
	});

	// 验红:去掉 `start` 里 catch 那段清理(`stopEngine()` / `setHealthCheckMs(0)` / 摘把手 / `started = false`),这条红
	// (cron 一直开着、心跳一直挂着、再 start 抛「already started」,而登记表不会替来源收拾)。
	it("start 半路抛了(动态已起、登录检查那一步炸了):来源自己什么都没留下,能重来", async () => {
		const { deps, config, setHealthCheckMs } = makeDeps();
		const source = createBiliSource(deps);
		const { ctx, watchDisposed } = makeCtx([{ externalId: "1", post: true }], config);
		// 动态引擎已 start(cron 起来了),再抛:模拟登录检查那一步的口炸了。
		setHealthCheckMs.mockImplementationOnce(() => {
			throw new Error("挂心跳炸了");
		});
		await expect(source.start(ctx)).rejects.toThrow("挂心跳炸了");
		expect(cronMock.instances[0]?.isActive).toBe(false);
		expect(source.dynamic()).toBeUndefined();
		expect(watchDisposed).toHaveBeenCalledTimes(1);
		expect(setHealthCheckMs).toHaveBeenLastCalledWith(0);
		expect(deps.problems.attach).not.toHaveBeenCalled();
		// 设置再变:被摘掉的订阅不会造出新的引擎
		config.set({ dynamicCron: "*/9 * * * *" });
		expect(cronMock.instances).toHaveLength(1);
		// 能重来
		const fresh = makeCtx([{ externalId: "1", post: true }], config);
		await source.start(fresh.ctx);
		expect(source.dynamic()).toBeDefined();
		await source.stop();
	});

	// 验红:`started = true` 放回 `ctx.settings(...)` 之前,这条红(第二次 start 报「already started」而不是起来)。
	it("start 里取设置的把手就抛了(组装处漏登记):原样抛出、不留「已起」的状态,能重来", async () => {
		const { deps, config } = makeDeps();
		const source = createBiliSource(deps);
		const bad = makeCtx([{ externalId: "1", post: true }], config);
		(bad.ctx as { settings: unknown }).settings = () => {
			throw new Error("没登记这个键");
		};
		await expect(source.start(bad.ctx)).rejects.toThrow("没登记这个键");
		expect(source.dynamic()).toBeUndefined();

		const fresh = makeCtx([{ externalId: "1", post: true }], config);
		await source.start(fresh.ctx);
		expect(source.dynamic()).toBeDefined();
		await source.stop();
	});

	it("来源把 deps.imageFetcher 递给引擎:带图的动态去抓图", async () => {
		vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-11T00:00:00Z") });
		const feed = {
			...EMPTY_FEED,
			data: {
				...EMPTY_FEED.data,
				items: [
					{
						...item(1, Math.floor(Date.parse("2026-10-11T00:00:10Z") / 1000)),
						modules: {
							...item(1, 0).modules,
							module_author: {
								...item(1, 0).modules.module_author,
								pub_ts: Math.floor(Date.parse("2026-10-11T00:00:10Z") / 1000),
							},
							module_dynamic: {
								desc: { text: "图", rich_text_nodes: [] },
								major: { opus: { pics: [{ url: "https://i0.hdslb.com/bfs/new_dyn/a.jpg" }] } },
							},
						},
					},
				],
			},
		};
		const { deps, fetchImage } = makeDeps({ fetchAllDynamic: async () => feed });
		fetchImage.mockResolvedValue({ ok: false, code: "unavailable", message: "x" });
		const source = createBiliSource(deps);
		const { ctx } = makeCtx([{ externalId: "1", post: true }]);
		await source.start(ctx);
		vi.setSystemTime(new Date("2026-10-11T00:00:20Z"));
		await source.dynamic()?.detectNow();
		expect(fetchImage).toHaveBeenCalled();
		await source.stop();
	});
});

describe("B 站来源 · health()(给 status 指令的那一行)", () => {
	const MIN = 60_000;
	/** 来源 + 一个能拨的时钟;动态引擎的 `lastFetchAt` 取真时钟,所以把假时钟拨到「抓取时刻 + 一段」。 */
	function setup(over: Parameters<typeof makeDeps>[0] = {}) {
		const made = makeDeps(over);
		let now = Date.now();
		const source = createBiliSource({ ...made.deps, now: () => now });
		return {
			...made,
			source,
			/** 把时钟拨到上次成功抓取之后 `ms` 毫秒。 */
			advanceAfterFetch(ms: number) {
				const at = source.dynamic()?.lastFetchAt();
				if (at === undefined) throw new Error("还没抓过");
				now = at + ms;
			},
		};
	}

	it("描述符的 label 是「B 站」", () => {
		expect(createBiliSource(makeDeps().deps).descriptor.label).toBe("B 站");
	});

	// 验红:`health()` 里把「没抓过」那一支删掉(落到 formatAgo(undefined)),这条红。
	it("还没成功抓过 → 「还没抓过」", async () => {
		const { source, config } = setup();
		await source.start(makeCtx([{ externalId: "1", post: true }], config).ctx);
		expect(source.health?.()).toEqual({ summary: "还没抓过" });
		await source.stop();
	});

	// 验红:`health()` 里把「抓过」那一支改成恒回「还没抓过」,这条红。
	it("抓过 → 「上次抓取 N 分钟前」,是相对时间", async () => {
		const { source, advanceAfterFetch } = setup();
		await source.start(makeCtx([{ externalId: "1", post: true }]).ctx);
		await source.dynamic()?.detectNow();
		advanceAfterFetch(2 * MIN);
		expect(source.health?.()).toEqual({ summary: "上次抓取 2 分钟前" });
		advanceAfterFetch(90 * MIN);
		expect(source.health?.()).toEqual({ summary: "上次抓取 1 小时前" });
		await source.stop();
	});

	it("刚抓过 → 「上次抓取 刚刚」,不说「0 分钟前」", async () => {
		const { source, advanceAfterFetch } = setup();
		await source.start(makeCtx([{ externalId: "1", post: true }]).ctx);
		await source.dynamic()?.detectNow();
		advanceAfterFetch(5_000);
		expect(source.health?.()?.summary).toBe("上次抓取 刚刚");
		expect(source.health?.()?.summary).not.toContain("0 分钟");
		await source.stop();
	});

	// 验红:把「动态停着」那一支挪到「抓过」之后判(或删掉),这条红。
	it("动态那一格设置读不懂、动态停着 → 「动态停着，设置读不懂」，优先于「上次抓取」;改好了回来", async () => {
		const { source, config } = setup();
		await source.start(makeCtx([{ externalId: "1", post: true }], config).ctx);
		await source.dynamic()?.detectNow();
		expect(source.health?.()?.summary).toContain("上次抓取");

		config.setRaw({ dynamicCron: 123, healthCheckMinutes: 30 });
		expect(source.dynamic()).toBeUndefined();
		expect(source.health?.()).toEqual({ summary: "动态停着，设置读不懂" });

		config.setRaw({ dynamicCron: "*/5 * * * *", healthCheckMinutes: 30 });
		expect(source.dynamic()).toBeDefined();
		expect(source.health?.()?.summary).toBe("还没抓过");
		await source.stop();
	});

	it("开机时动态那一格就读不懂 → 一上来就是「动态停着，设置读不懂」", async () => {
		const made = makeDeps();
		made.config.setRaw({ dynamicCron: 123, healthCheckMinutes: 30 });
		const source = createBiliSource(made.deps);
		await source.start(makeCtx([{ externalId: "1", post: true }], made.config).ctx);
		expect(source.health?.()).toEqual({ summary: "动态停着，设置读不懂" });
		await source.stop();
	});

	// 验红:`health()` 里读 `deps.auth.state()` 拼进半句登录,这条红。
	it("没登录时这一行不变:不提登录,也不去读登录态(登录由 status 的「登录」一行说)", async () => {
		const made = makeDeps();
		const state = vi.fn(() => ({ status: "logged-out" as const }));
		const source = createBiliSource({ ...made.deps, auth: { ...FAKE_AUTH, state } });
		await source.start(makeCtx([{ externalId: "1", post: true }]).ctx);
		expect(source.health?.()).toEqual({ summary: "还没抓过" });
		expect(state).not.toHaveBeenCalled();
		await source.stop();
	});

	it("没 start / 已 stop → 还没抓过(引擎不在、也不是设置读不懂)", async () => {
		const { source } = setup();
		expect(source.health?.()).toEqual({ summary: "还没抓过" });
		await source.start(makeCtx([{ externalId: "1", post: true }]).ctx);
		await source.stop();
		expect(source.health?.()).toEqual({ summary: "还没抓过" });
	});
});

describe("B 站来源 · 端到端(真订阅仓 + 真来源上下文 + 真动态引擎)", () => {
	const T0 = Date.parse("2026-10-11T00:00:00Z");
	const at = (sec: number) => Math.floor(T0 / 1000) + sec;
	const clock = (sec: number) => vi.setSystemTime(new Date(T0 + sec * 1000));

	async function boot(subs = [makeSub("sub-1", "1")]) {
		vi.useFakeTimers({ toFake: ["Date"], now: new Date(T0) });
		const world = makeWorld(subs);
		let feedItems: unknown[] = [];
		const { deps, fetchImage } = makeDeps({
			fetchAllDynamic: async () => ({
				...EMPTY_FEED,
				data: { ...EMPTY_FEED.data, items: feedItems },
			}),
		});
		const source = createBiliSource({ ...deps, bus: world.bus });
		const enqueue = vi.fn<(event: { subscriptionId: string; postId: string }) => void>();
		const logger = makeLogger();
		const registry = createSourceRegistry();
		const registration = await registerBuiltinSource({
			registry,
			linkResolvers: createLinkResolverRegistry(),
			source,
			integration: makeIntegration() as IntegrationContext,
			sourceKey: SOURCE_KEY,
			subscriptions: world.store,
			defaults: () => world.globals.defaults,
			bus: world.bus,
			logger,
			enqueue: enqueue as never,
			problems: { report: vi.fn(), resolve: vi.fn(), clearReporter: vi.fn() },
		});
		const feed = (...items: unknown[]) => {
			feedItems = items;
		};
		const round = async (sec: number, ...items: unknown[]) => {
			feed(...items);
			clock(sec);
			await source.dynamic()?.detectNow();
		};
		return { world, source, registration, enqueue, round, feed, fetchImage, logger };
	}

	it("对照:启用着、作品开关开着,新动态交出去", async () => {
		const { source, enqueue, round } = await boot();
		await round(20, item(1, at(10), "d1"));
		expect(enqueue.mock.calls.map(([e]) => [e.subscriptionId, e.postId])).toEqual([
			["sub-1", "d1"],
		]);
		await source.stop();
	});

	it("停用那条订阅 → 下一轮不交;重新启用 → 交(只交启用之后发的)", async () => {
		const { world, source, enqueue, round } = await boot();
		const sub = world.store.findById("sub-1");
		if (!sub) throw new Error("没有订阅");
		world.store.upsert({ ...sub, enabled: false });
		await round(40, item(1, at(30), "while-off"));
		expect(enqueue).not.toHaveBeenCalled();

		clock(50);
		world.store.upsert({ ...sub, enabled: true });
		// 启用前发的那条:锚点是「启用那一刻」,不交(已定 16)。
		await round(60, item(1, at(45), "before-on"));
		expect(enqueue).not.toHaveBeenCalled();
		await round(80, item(1, at(70), "after-on"));
		expect(enqueue.mock.calls.map(([e]) => e.postId)).toEqual(["after-on"]);
		await source.stop();
	});

	// 生产的形状:没人要动态时 cron 停着,关着期间没有「一轮」可跑,所以这里不手调 detectNow。
	// 验红:去掉 `applyRoster` 里「离开就删锚点」(留着旧锚点),这条与下一条红(关着期间的动态补推出来)。
	it("改全局作品开关 → 关了 cron 停;关着期间的动态,再开不补推,之后新发的照交", async () => {
		const { world, source, enqueue, round, feed } = await boot();
		world.globals.defaults.features.post = false;
		world.bus.emit("config-changed", { scope: "globals" });
		expect(cronMock.instances[0]?.isActive).toBe(false);
		feed(item(1, at(20), "while-off"));
		clock(50);

		world.globals.defaults.features.post = true;
		world.bus.emit("config-changed", { scope: "globals" });
		await round(80, item(1, at(20), "while-off"), item(1, at(70), "after-on"));
		expect(enqueue.mock.calls.map(([e]) => e.postId)).toEqual(["after-on"]);
		await source.stop();
	});

	it("唯一一条订阅关掉作品开关再打开:关着期间的动态不补推,之后新发的照交", async () => {
		const { world, source, enqueue, round, feed } = await boot();
		const sub = world.store.findById("sub-1");
		if (!sub) throw new Error("没有订阅");
		world.store.upsert({ ...sub, overrides: { ...sub.overrides, features: { post: false } } });
		expect(cronMock.instances[0]?.isActive).toBe(false);
		feed(item(1, at(20), "while-off"));
		clock(50);

		world.store.upsert({ ...sub, overrides: { ...sub.overrides, features: { post: true } } });
		await round(80, item(1, at(20), "while-off"), item(1, at(70), "after-on"));
		expect(enqueue.mock.calls.map(([e]) => e.postId)).toEqual(["after-on"]);
		await source.stop();
	});

	it("遗留的重复订阅(同一个 uid 两条、作品开关相反):这个人仍在要推的人里,动态照交", async () => {
		const { source, enqueue, round } = await boot([
			makeSub("sub-1", "1", { overrides: { features: { post: true } } }),
			makeSub("sub-2", "1", { overrides: { features: { post: false } } }),
		]);
		expect(cronMock.instances[0]?.isActive).toBe(true);
		await round(20, item(1, at(10), "d1"));
		expect(enqueue).toHaveBeenCalled();
		await source.stop();
	});

	// 验红:删掉 `DynamicPoller.stop()` 里清表的那句(`this.postAnchors = new Map()`),这条红。
	it("撤销登记时有一轮正卡在抓图:放行之后这条不交,来源上下文也没看到「停下还在上报」", async () => {
		const { source, registration, enqueue, feed, fetchImage, logger } = await boot();
		const gate = deferred<{ ok: false; code: string; message: string }>();
		fetchImage.mockReturnValue(gate.promise);
		const withPic = item(1, at(10), "in-flight");
		feed({
			...withPic,
			modules: {
				...withPic.modules,
				module_dynamic: {
					desc: { text: "图", rich_text_nodes: [] },
					major: { opus: { pics: [{ url: "https://i0.hdslb.com/bfs/new_dyn/a.jpg" }] } },
				},
			},
		});
		clock(20);
		const running = source.dynamic()?.detectNow();
		await vi.waitFor(() => expect(fetchImage).toHaveBeenCalled());

		registration.dispose();
		expect(source.dynamic()).toBeUndefined();
		gate.resolve({ ok: false, code: "unavailable", message: "x" });
		await running;

		expect(enqueue).not.toHaveBeenCalled();
		expect(logger.error.mock.calls.filter(([msg]) => String(msg).includes("已停下"))).toEqual([]);
	});
});
