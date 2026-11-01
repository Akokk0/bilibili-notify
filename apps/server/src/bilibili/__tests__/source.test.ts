/**
 * B 站来源:`start(ctx)` 里造并启动动态轮询,`stop()` 里停它。
 *
 * 动态轮询用真的 `DynamicPoller`(假 `Api`,全程不外连);cron 换成惰性的假件,好数启停与新节奏。
 * 最后一组是「不用假名单」的端到端:真订阅仓 + 真来源上下文 + 真动态轮询,停用 / 启用 / 改全局作品开关逐个走一遍。
 */

import {
	type AiToolProvider,
	BILIBILI_GUARD_PROGRAM,
	fail,
	type Identity,
	type ImageRef,
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
import { fixedLocale } from "../../__tests__/support/fixed-locale.js";
import { memoryKeyValueStores } from "../../__tests__/support/memory-key-value-store.js";
import { deferred } from "../../__tests__/support/track-context.js";
import { createAiToolProviderRegistry } from "../../ai/tool-provider-registry.js";
import { i18n } from "../../i18n/index.js";
import { createSettingsReader } from "../../integrations/settings-reader.js";
import { createLinkResolverRegistry } from "../../link-preview/registry.js";
import { createProblemTable } from "../../problems/problem-table.js";
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
import { type BiliSettings, BiliSettingsSchema } from "../settings.js";
import { BILI_SOURCE_DESCRIPTOR, createBiliSource } from "../source.js";
import { fakeLoginDeps, fakeLoginSystem } from "./support/fake-login-system.js";

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
const roomsMock = vi.hoisted(() => ({
	instances: [] as Array<{
		opts: { rememberFanClubName(externalId: string, name: string): void };
	}>,
}));
// 只换 `CronJob`:动态读者的「能解析」那一道用的是同一个包里的 `CronTime`,要留真的。
vi.mock("cron", async (importOriginal) => ({
	...(await importOriginal<typeof import("cron")>()),
	CronJob: cronMock.FakeCronJob,
}));
// 登录那一套(真的状态机、罐子、存储)在 `auth/__tests__` 与 `compose.test.ts` 钉着:这里的来源单测换成假系统,
// `deps.context` 带着它(见 `support/fake-login-system.ts`)。
vi.mock("../auth/index.js", () => ({
	createAuthSystem: (o: { context: { login: unknown } }) => o.context.login,
}));
vi.mock("../live/session/bili-live-rooms.js", () => ({
	BiliLiveRooms: class {
		private readonly handles: Array<{ dispose(): void }> = [];
		constructor(opts: (typeof roomsMock.instances)[number]["opts"]) {
			roomsMock.instances.push({ opts });
		}
		start(source: { onSubscriptionsChanged(fn: () => void): { dispose(): void } }): void {
			this.handles.push(source.onSubscriptionsChanged(() => {}));
		}
		stop(): void {
			for (const handle of this.handles.splice(0)) handle.dispose();
		}
		fetchLiveStatus(): Promise<never> {
			return Promise.reject(new Error("not used"));
		}
		/** 直播那一支的预览:回一句能认出来的失败,来源原样交出去就算接上了。 */
		fetchPreview(identity: { externalId: string }): Promise<unknown> {
			return Promise.resolve({
				ok: false,
				code: "unavailable",
				message: `假房间预览 ${identity.externalId}`,
			});
		}
	},
}));

beforeEach(() => {
	cronMock.instances.length = 0;
	roomsMock.instances.length = 0;
});
afterEach(() => {
	vi.useRealTimers();
});

const EMPTY_FEED = ok({
	data: { has_more: false, items: [] as unknown[], offset: "", update_baseline: "", update_num: 0 },
});

/** 假上下文 `fetchImage` 回的图库引用(形状同真图库:64 位十六进制 + 后缀)。 */
const CONTEXT_IMAGE_REF = `${"c".repeat(64)}.webp`;

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

function makeDeps(
	over: {
		cron?: string;
		fetchAllDynamic?: () => unknown;
		fetchRelations?: (uids: string[]) => Promise<unknown>;
		follow?: (uid: string) => Promise<unknown>;
		auth?: SourceAuth;
		now?: () => number;
		/** 换掉来源手里那个可回收的定时器(关注同步的退避重试用);不给就什么都不挂。 */
		setTimeout?: (fn: () => void, ms: number) => { dispose(): void };
	} = {},
) {
	const config = makeConfig(over.cron ? { dynamicCron: over.cron } : {});
	const setHealthCheckMs = vi.fn<(ms: number) => void>();
	const logger = makeLogger();
	const fetchRelations = vi.fn(
		over.fetchRelations ?? (async (_uids: string[]) => ok({ data: null })),
	);
	const follow = vi.fn(over.follow ?? (async (_uid: string) => ok()));
	const login = fakeLoginSystem({
		api: {
			fetchAllDynamic: over.fetchAllDynamic ?? (async () => EMPTY_FEED),
			fetchRelations,
			follow,
		} as unknown as Api,
		auth: over.auth ?? FAKE_AUTH,
		setHealthCheckMs,
	});
	const liveContext = {
		logger,
		signal: new AbortController().signal,
		setInterval: () => ({ dispose() {} }),
		setTimeout: () => ({ dispose() {} }),
		onDispose() {},
		track() {},
	};
	return {
		config,
		setHealthCheckMs,
		/** 假登录系统(来源造出来的就是它);要换 `api` 的用例在造来源之前改 `login.api`。 */
		login,
		logger,
		deps: {
			...fakeLoginDeps(login, logger),
			locale: fixedLocale(),
			setTimeout: over.setTimeout ?? (() => ({ dispose() {} })),
			liveContext,
			...(over.now ? { now: over.now } : {}),
		},
		fetchRelations,
		follow,
	};
}

async function bootProblemTable(
	initialAuth: ReturnType<SourceAuth["state"]>,
	fetchAllDynamic: () => Promise<unknown> = async () => EMPTY_FEED,
) {
	const auth = makeAuth(initialAuth);
	const made = makeDeps({
		auth: auth.auth,
		fetchAllDynamic,
	});
	const source = createBiliSource(made.deps);
	const world = makeWorld([makeSub("sub-1", "1")]);
	const table = createProblemTable({ logger: made.logger });
	const registration = await registerBuiltinSource({
		registry: createSourceRegistry(),
		linkResolvers: createLinkResolverRegistry(),
		aiToolProviders: createAiToolProviderRegistry(),
		source,
		integration: makeIntegration(),
		sourceKey: SOURCE_KEY,
		subscriptions: world.store,
		defaults: () => world.globals.defaults,
		bus: world.bus,
		logger: made.logger,
		enqueue: () => {},
		liveSignals: () => {},
		liveInteractions: () => {},
		profiles: () => {},
		problems: table,
	});
	return { auth, registration, source, table };
}

/** 假登录口:来源只是原样挂着它。 */
const FAKE_AUTH: SourceAuth = {
	beginLogin: async () => ok(),
	logout: async () => ok(),
	state: () => ({ status: "logged-out" }),
	onChange: () => ({ dispose() {} }),
};

/** 可控登录口:换状态时同步叫所有 `onChange` 监听。 */
function makeAuth(initial: ReturnType<SourceAuth["state"]>) {
	let state = initial;
	const listeners = new Set<() => void>();
	const auth: SourceAuth = {
		beginLogin: async () => ok(),
		logout: async () => ok(),
		state: () => state,
		onChange(fn) {
			listeners.add(fn);
			return {
				dispose() {
					listeners.delete(fn);
				},
			};
		},
	};
	return {
		auth,
		set(next: ReturnType<SourceAuth["state"]>) {
			state = next;
			for (const fn of [...listeners]) fn();
		},
		listenerCount: () => listeners.size,
	};
}

/**
 * 假来源上下文:名单与回调可控,`onSubscriptionsChanged` 的把手记下有没有被摘;`settings(schema)` 与真上下文
 * 同一个做法(真把手 + 假宿主),把手随 `dispose()` 一起收。
 */
function makeCtx(
	roster: Array<{ externalId: string; post?: boolean; monitorsLive?: boolean }> = [],
	config: ReturnType<typeof makeConfig> = makeConfig(),
) {
	const watchers: Array<() => void> = [];
	const watchDisposed = vi.fn();
	const reportPost = vi.fn<(id: string, report: PostReport) => void>();
	/** 上下文提供的抓图口:每个地址回同一个引用,测试数调用。 */
	const fetchImage = vi.fn(
		async (
			_url: string,
			_options?: { headers?: Record<string, string>; signal?: AbortSignal },
		): Promise<Result<{ ref: ImageRef }>> => ok({ ref: CONTEXT_IMAGE_REF }),
	);
	const logger = makeLogger();
	const readers: Array<{ dispose(): void }> = [];
	const linkResolverDisposed = vi.fn();
	const state = memoryKeyValueStores("state").store;
	const registerLinkResolver = vi.fn((_resolver: LinkResolver) => ({
		dispose: linkResolverDisposed,
	}));
	const registerAiToolProvider = vi.fn((_provider: AiToolProvider) => ({ dispose() {} }));
	const ctx = {
		timezone: () => "Asia/Shanghai",
		onTimezoneChanged: () => ({ dispose() {} }),
		logger: logger as Logger,
		signal: new AbortController().signal,
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
				monitorsLive: r.monitorsLive ?? false,
			})),
		onSubscriptionsChanged: (fn: () => void) => {
			watchers.push(fn);
			return { dispose: watchDisposed };
		},
		reportPost,
		fetchImage,
		reportProblem: vi.fn(),
		resolveProblem: vi.fn(),
		registerLinkResolver,
		registerAiToolProvider,
		state,
	} as unknown as SourceContext;
	return {
		ctx,
		state,
		registerLinkResolver,
		registerAiToolProvider,
		linkResolverDisposed,
		watchers,
		watchDisposed,
		reportPost,
		fetchImage,
		logger,
		/** 收掉上下文:把手的宿主监听一起摘(登记表撤登记时真上下文做的事)。 */
		disposeContext: () => {
			for (const r of readers) r.dispose();
		},
	};
}

describe("createBiliSource", () => {
	it("start 之后登录失效:问题表只剩登录失效那一条", async () => {
		const { auth, registration, source, table } = await bootProblemTable(
			{ status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" },
			async () => failureFromBili(-352, "risk"),
		);
		await source.dynamic()?.detectNow();
		expect(table.list().map((problem) => problem.code)).toEqual(["risk_controlled"]);

		auth.set({ status: "expired", message: "失效" });

		expect(table.list()).toHaveLength(1);
		expect(table.list()[0]).toMatchObject({ reporter: SOURCE_KEY, code: "auth_lost" });
		await registration.dispose();
	});

	it("停下来源后登录再变化:问题表不再收到新的", async () => {
		const { auth, registration, table } = await bootProblemTable({ status: "logged-out" });
		expect(table.list().map((problem) => problem.code)).toEqual(["auth_lost"]);

		await registration.dispose();
		expect(auth.listenerCount()).toBe(0);
		auth.set({ status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" });
		auth.set({ status: "expired", message: "失效" });

		expect(table.list()).toEqual([]);
	});

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

	it("start 里登记 B 站的 AI 工具提供方:两把本名是累计数据与最近视频", async () => {
		const { deps } = makeDeps();
		const source = createBiliSource(deps);
		const { ctx, registerAiToolProvider } = makeCtx();

		await source.start(ctx);

		expect(registerAiToolProvider).toHaveBeenCalledTimes(1);
		const provider = registerAiToolProvider.mock.calls[0]?.[0] as
			| { readOnly: Array<{ definition: { function: { name: string } } }> }
			| undefined;
		expect(provider?.readOnly.map((tool) => tool.definition.function.name)).toEqual([
			"get_up_totals",
			"get_up_videos",
		]);
		await source.stop();
	});

	it("来源实例的 featureHints 在访问时取当前语言，不被描述符拷贝冻结", () => {
		const source = createBiliSource(makeDeps().deps);
		const state = i18n.state();
		const key = "bilibili.source.featureHints.post";
		try {
			i18n.set({ locale: "zh-CN", voice: "plain" });
			expect(source.descriptor.featureHints).toEqual({
				post: "投稿 / 转发 / 专栏",
				superchat: "Super Chat 提醒",
			});
			i18n.set({ locale: "en" });
			const translate = vi
				.spyOn(i18n.state(), "t")
				.mockImplementation((requested) =>
					requested === key ? "Current post hint" : String(requested),
				);
			try {
				expect(source.descriptor.featureHints?.post).toBe("Current post hint");
			} finally {
				translate.mockRestore();
			}
		} finally {
			i18n.set({ locale: state.locale, voice: state.voice });
		}
	});

	it("描述符的 postNoun 是「动态」", () => {
		expect(createBiliSource(makeDeps().deps).descriptor.postNoun).toBe("动态");
	});

	it("描述符表示这个平台管外部 id 叫 UID", () => {
		expect(createBiliSource(makeDeps().deps).descriptor.externalIdNoun).toBe("UID");
	});

	it("描述符声明外部 id 是纯数字(UID),整串匹配", () => {
		expect(createBiliSource(makeDeps().deps).descriptor.externalIdRegex).toBe("^\\d+$");
	});

	it("描述符交出大航海这一套会员体系", () => {
		expect(createBiliSource(makeDeps().deps).descriptor.membershipPrograms).toEqual([
			BILIBILI_GUARD_PROGRAM,
		]);
	});

	it("直播取到粉丝牌名:只写进这位 UP 的资料状态", async () => {
		const { deps } = makeDeps();
		const source = createBiliSource(deps);
		const { ctx, state } = makeCtx([{ externalId: "1", monitorsLive: true }]);
		await source.start(ctx);

		roomsMock.instances[0]?.opts.rememberFanClubName("1", "甲牌");

		await vi.waitFor(() => {
			expect(state.get("profile:1")).toEqual({ fanClubName: "甲牌" });
		});
		await source.stop();
	});

	it("start 之后 B 站来源的 fetchProfile 接在同一个 API 与资料状态上", async () => {
		const { deps, login } = makeDeps();
		const fetchUserCard = vi.fn(async () =>
			ok({ data: { card: { name: "阿甲", face: "", sign: "", fans: 7 } } }),
		);
		login.api = { ...login.api, fetchUserCard } as unknown as Api;
		const source = createBiliSource(deps);
		const { ctx, state } = makeCtx([{ externalId: "1" }]);
		await source.start(ctx);

		const result = await source.fetchProfile(
			{ sourceKey: "bilibili", externalId: "1" },
			new AbortController().signal,
		);

		expect(result).toMatchObject({ ok: true, name: "阿甲", followers: 7 });
		expect(fetchUserCard).toHaveBeenCalledWith("1");
		expect(state.get("profile:1")).toEqual({});
		await source.stop();
	});

	it("start 之后 fetchPreview 接上:作品取同一个 API 的 space 列表,直播交给直播房间;start 前回 unavailable", async () => {
		const { deps, login } = makeDeps();
		const fetchUserSpaceDynamic = vi.fn(async () => ({ code: 0, data: { items: [] } }));
		login.api = { ...login.api, fetchUserSpaceDynamic } as unknown as Api;
		const source = createBiliSource(deps);
		const identity = { sourceKey: "bilibili", externalId: "42" };
		const signal = new AbortController().signal;
		await expect(
			source.fetchPreview?.(identity, { kind: "post", nth: 1 }, signal),
		).resolves.toMatchObject({ ok: false, code: "unavailable" });

		const { ctx } = makeCtx([{ externalId: "42" }]);
		await source.start(ctx);

		await expect(
			source.fetchPreview?.(identity, { kind: "post", nth: 1 }, signal),
		).resolves.toMatchObject({ ok: false, code: "not_found" });
		expect(fetchUserSpaceDynamic).toHaveBeenCalledWith("42");
		await expect(source.fetchPreview?.(identity, { kind: "live" }, signal)).resolves.toMatchObject({
			ok: false,
			message: "假房间预览 42",
		});
		await source.stop();
	});

	// 接线守卫(4-15):搜人的候选头像经 `ctx.fetchImage` 抓进图库。验红:`searchCreators` 不递抓图口,这条红。
	it("start 之后搜人的候选头像经 ctx.fetchImage 抓进图库;start 前照样能搜,只是不带头像", async () => {
		const { deps, login } = makeDeps();
		const fetchUserCard = vi.fn(async () =>
			ok({
				data: { card: { mid: "7", name: "阿七", face: "https://i0.hdslb.com/bfs/face/7.jpg" } },
			}),
		);
		login.api = { ...login.api, fetchUserCard } as unknown as Api;
		const source = createBiliSource(deps);
		const signal = new AbortController().signal;
		await expect(source.searchCreators("7", signal)).resolves.toEqual({
			ok: true,
			candidates: [{ externalId: "7", name: "阿七" }],
		});

		const { ctx, fetchImage } = makeCtx([]);
		await source.start(ctx);
		fetchImage.mockClear();
		const found = await source.searchCreators("7", signal);
		expect(fetchImage).toHaveBeenCalledWith(
			expect.stringContaining("/bfs/face/7.jpg@480w"),
			expect.anything(),
		);
		expect(found.ok && found.candidates[0]?.avatar).toEqual(expect.any(String));
		await source.stop();
	});

	it("ctx.state 预置房号时,来源的直播把手直接读它,不请求用户信息", async () => {
		const { deps, login } = makeDeps();
		const fetchUserInfo = vi.fn();
		login.api = { ...login.api, fetchUserInfo } as unknown as Api;
		const source = createBiliSource(deps);
		const { ctx, state } = makeCtx([{ externalId: "42", monitorsLive: true }]);
		await state.set("room:42", "5050");

		await source.start(ctx);

		expect(source.liveRooms()?.roomIdOf("42")).toBe("5050");
		expect(fetchUserInfo).not.toHaveBeenCalled();
		await source.stop();
	});

	it("B 站自己的资料状态经同步读口交头像网址;start 前与坏值都没有", async () => {
		const { deps } = makeDeps();
		const source = createBiliSource(deps);
		const { ctx, state } = makeCtx([{ externalId: "42" }]);
		await state.set("profile:42", { avatarUrl: "https://i0.hdslb.com/bfs/face/42.jpg" });
		await state.set("profile:43", { avatarUrl: 43 });

		expect(source.profileAvatars()).toBeUndefined();
		await source.start(ctx);
		expect(source.profileAvatars()?.avatarUrlOf("42")).toBe("https://i0.hdslb.com/bfs/face/42.jpg");
		expect(source.profileAvatars()?.avatarUrlOf("43")).toBeUndefined();
		expect(source.profileAvatars()?.avatarUrlOf("missing")).toBeUndefined();
		await source.stop();
		expect(source.profileAvatars()).toBeUndefined();
	});

	it("名单去掉一位时,删掉他的 profile 状态", async () => {
		const { deps } = makeDeps();
		const source = createBiliSource(deps);
		const roster = [{ externalId: "1" }];
		const { ctx, state, watchers } = makeCtx(roster);
		await state.set("profile:1", { fanClubName: "甲牌" });
		await source.start(ctx);

		roster.splice(0);
		for (const watcher of watchers) watcher();

		await vi.waitFor(() => {
			expect(state.get("profile:1")).toBeUndefined();
		});
		await source.stop();
	});

	it("每个来源实例一份描述符,抓图补上的引用不改模块常量", () => {
		const first = createBiliSource(makeDeps().deps);
		const second = createBiliSource(makeDeps().deps);
		expect(first.descriptor).not.toBe(second.descriptor);
		expect(first.descriptor.membershipPrograms?.[0]).not.toBe(
			second.descriptor.membershipPrograms?.[0],
		);
		expect(BILI_SOURCE_DESCRIPTOR.membershipPrograms?.[0]?.tiers).not.toBe(
			first.descriptor.membershipPrograms?.[0]?.tiers,
		);
	});

	it("有人要连直播间:start 抓三档、写进实例描述符,但不等待抓图", async () => {
		const { deps } = makeDeps();
		const source = createBiliSource(deps);
		const { ctx, fetchImage } = makeCtx([{ externalId: "1", post: true, monitorsLive: true }]);
		const pending = deferred<Result<{ ref: ImageRef }>>();
		fetchImage.mockImplementation(() => pending.promise);

		await source.start(ctx);
		expect(fetchImage).toHaveBeenCalledTimes(3);
		expect(fetchImage.mock.calls.map(([url]) => url)).toEqual(
			Array.isArray(BILIBILI_GUARD_PROGRAM.tiers)
				? BILIBILI_GUARD_PROGRAM.tiers.map((tier) => tier.icon?.url)
				: [],
		);
		for (const [, options] of fetchImage.mock.calls) {
			expect(options?.headers).toEqual({ Referer: "https://www.bilibili.com/" });
			expect(Object.keys(options?.headers ?? {}).map((name) => name.toLowerCase())).not.toContain(
				"cookie",
			);
		}

		pending.resolve(ok({ ref: CONTEXT_IMAGE_REF }));
		await source.liveInteractions?.fetchTierIcon(
			{ sourceKey: "bilibili", externalId: "1" },
			"guard",
			"captain",
			new AbortController().signal,
		);
		const tiers = source.descriptor.membershipPrograms?.[0]?.tiers;
		expect(Array.isArray(tiers) ? tiers.map((tier) => tier.icon?.ref) : []).toEqual([
			CONTEXT_IMAGE_REF,
			CONTEXT_IMAGE_REF,
			CONTEXT_IMAGE_REF,
		]);
		expect(BILI_SOURCE_DESCRIPTOR.membershipPrograms?.[0]?.tiers).not.toEqual(
			source.descriptor.membershipPrograms?.[0]?.tiers,
		);
		await source.stop();
	});

	it("没人要连直播间:start 不抓徽章,等懒取口再抓", async () => {
		const { deps } = makeDeps();
		const source = createBiliSource(deps);
		const { ctx, fetchImage } = makeCtx([{ externalId: "1", post: true }]);
		await source.start(ctx);
		expect(fetchImage).not.toHaveBeenCalled();

		const identity: Identity = { sourceKey: "bilibili", externalId: "1" };
		const result = await source.liveInteractions?.fetchTierIcon(
			identity,
			"guard",
			"commander",
			new AbortController().signal,
		);
		expect(result).toMatchObject({ ok: true, ref: CONTEXT_IMAGE_REF });
		expect(fetchImage).toHaveBeenCalledTimes(3);
		await source.stop();
	});

	it("懒取失败后 5 分钟内不重试,到点才补", async () => {
		let clock = 1_000_000;
		const { deps } = makeDeps({ now: () => clock });
		const source = createBiliSource(deps);
		const { ctx, fetchImage } = makeCtx([{ externalId: "1", post: true }]);
		fetchImage.mockResolvedValue(fail("unavailable", "down"));
		await source.start(ctx);
		const identity: Identity = { sourceKey: "bilibili", externalId: "1" };
		const fetchIcon = () =>
			source.liveInteractions?.fetchTierIcon(
				identity,
				"guard",
				"captain",
				new AbortController().signal,
			);

		expect(await fetchIcon()).toMatchObject({ ok: false });
		expect(fetchImage).toHaveBeenCalledTimes(3);
		clock += 5 * 60_000 - 1;
		expect(await fetchIcon()).toMatchObject({ ok: false });
		expect(fetchImage).toHaveBeenCalledTimes(3);
		clock += 1;
		expect(await fetchIcon()).toMatchObject({ ok: false });
		expect(fetchImage).toHaveBeenCalledTimes(6);
		await source.stop();
	});

	it("start 后动态轮询在跑、dynamic() 拿得到;stop 后 dynamic() 是 undefined、把手都摘了、登录检查停掉", async () => {
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
		expect(watchDisposed).toHaveBeenCalledTimes(3);
		expect(setHealthCheckMs).toHaveBeenLastCalledWith(0);

		// stop 之后设置再变(上下文还没收):来源自己的订阅已摘,不会造出新的动态轮询、也不会再动登录检查。
		setHealthCheckMs.mockClear();
		config.set({ dynamicCron: "*/9 * * * *", healthCheckMinutes: 45 });
		expect(cronMock.instances).toHaveLength(1);
		expect(setHealthCheckMs).not.toHaveBeenCalled();

		// 登记表撤登记时上下文一起收掉:把手的宿主监听都摘了。
		expect(config.listeners()).toBeGreaterThan(0);
		disposeContext();
		expect(config.listeners()).toBe(0);
	});

	// 验红:把 `problems?.detach()` 挪到动态轮询停下之后,这条红(动态轮询收尾的「不再适用」被当成「已恢复」)。
	it("start 后风控进表;stop 先摘上报器再停动态轮询,不补「已恢复」", async () => {
		const auth = makeAuth({ status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" });
		const { deps } = makeDeps({
			auth: auth.auth,
			fetchAllDynamic: async () => failureFromBili(-352, "risk"),
		});
		const source = createBiliSource(deps);
		const { ctx } = makeCtx([{ externalId: "1", post: true }]);
		await source.start(ctx);
		await source.dynamic()?.detectNow();
		expect(ctx.reportProblem).toHaveBeenCalledWith(
			expect.objectContaining({ code: "risk_controlled", notify: true }),
		);
		vi.mocked(ctx.resolveProblem).mockClear();

		await source.stop();
		expect(ctx.resolveProblem).not.toHaveBeenCalled();
	});

	// 验红:动态那格读不懂时不报这条问题,第一条断言红;把 `layers.attach(ctx)` 挪进动态轮询起来的那一支,
	// 关注失败那条断言红(上报器没接上核心,经它报的问题进不了表)。
	it("动态那格读不懂、动态轮询没造:设置问题照样进表,上报器照样接上核心", async () => {
		const auth = makeAuth({ status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" });
		const { deps, config } = makeDeps({
			auth: auth.auth,
			follow: async () => fail("unavailable", "关注失败"),
		});
		config.setRaw({ dynamicCron: 123, healthCheckMinutes: 30 });
		const source = createBiliSource(deps);
		const { ctx } = makeCtx([{ externalId: "1", post: true }], config);

		await source.start(ctx);

		expect(source.dynamic()).toBeUndefined();
		expect(ctx.reportProblem).toHaveBeenCalledWith(
			expect.objectContaining({ code: "dynamic_settings_invalid", notify: false }),
		);
		await vi.waitFor(() =>
			expect(ctx.reportProblem).toHaveBeenCalledWith(
				expect.objectContaining({ externalId: "1", code: "follow_failed" }),
			),
		);
		await source.stop();
	});

	// 验红:把 source.ts 递给动态轮询的 `problems: layers` 换成别的对象,这条红。
	it("动态轮询用的就是来源的那个上报器:拉动态撞 -352 报到它身上", async () => {
		const auth = makeAuth({ status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" });
		const { deps } = makeDeps({
			auth: auth.auth,
			fetchAllDynamic: async () => failureFromBili(-352, "risk"),
		});
		const source = createBiliSource(deps);
		const { ctx } = makeCtx([{ externalId: "1", post: true }]);
		await source.start(ctx);
		await source.dynamic()?.detectNow();
		expect(ctx.reportProblem).toHaveBeenCalledWith(
			expect.objectContaining({ code: "risk_controlled", notify: true }),
		);
		await source.stop();
	});

	// 验红:让分层上报器重新报 `auth_lost`(留着 `reportLogin`),这条红(真上报器 + 记录用的假 ctx,开机登录已失效)。
	it("真上报器:登录是 expired 时,start 之后核心那头不收 auth_lost(登录问题归宿主报)", async () => {
		const { deps } = makeDeps({
			auth: {
				...FAKE_AUTH,
				state: () => ({ status: "expired", message: "失效" }),
			},
		});
		const source = createBiliSource(deps);
		const { ctx } = makeCtx();
		await source.start(ctx);
		expect(ctx.reportProblem).not.toHaveBeenCalled();
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

	it("名单变了的回调接到动态轮询:新增一个开着作品的人就起 cron", async () => {
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

	it("初始 cron 取自 B 站设置;cron 变了动态轮询换节奏,别的设置变了不动", async () => {
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
	// 验红:`applyDynamic` 读不懂、动态轮询在的那一支什么都不做 → 动态不停;`applyLoginCheck` 不传 0 → 心跳不停。
	it("运行中动态与登录检查那两格从读得懂变成读不懂:动态轮询被停、dynamic() 回 undefined、报了问题;登录检查收到 0", async () => {
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
	it("晚起时造动态轮询抛了别的错:没有往外抛、那一条问题还在、下一次设置变了再试", async () => {
		const { deps, config } = makeDeps();
		config.setRaw({ dynamicCron: 123, healthCheckMinutes: 30 });
		const source = createBiliSource(deps);
		const { ctx, logger } = makeCtx([{ externalId: "1", post: true }], config);
		await source.start(ctx);
		expect(source.dynamic()).toBeUndefined();
		const resolved = vi.mocked(ctx.resolveProblem);
		resolved.mockClear();

		// 动态轮询一起来就读名单:让名单读口炸一次。
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

		// 下一次变化再试:这回名单读得出来,动态轮询起来、问题清掉。
		(ctx as { subscriptions: unknown }).subscriptions = roster;
		config.set({ dynamicCron: "*/9 * * * *" });
		expect(source.dynamic()?.isActive).toBe(true);
		expect(resolved).toHaveBeenCalledWith({ code: "dynamic_settings_invalid", notify: false });
		await source.stop();
	});

	// 验红:去掉 `start` 里 catch 那段清理(`stopEngine()` / `setHealthCheckMs(0)` / 摘把手 / `started = false`),这条红
	// (cron 一直开着、心跳一直挂着、再 start 抛「already started」,而登记表不会替来源收拾)。
	it("start 半路抛了(动态已起、登录检查那一步炸了):来源自己什么都没留下,能重来", async () => {
		const { deps, config, setHealthCheckMs, login } = makeDeps();
		const source = createBiliSource(deps);
		const { ctx, watchDisposed } = makeCtx([{ externalId: "1", post: true }], config);
		// 动态轮询已 start(cron 起来了),再抛:模拟登录检查那一步的口炸了。
		setHealthCheckMs.mockImplementationOnce(() => {
			throw new Error("挂心跳炸了");
		});
		await expect(source.start(ctx)).rejects.toThrow("挂心跳炸了");
		// 登录也跟着停(来源的 start 抛了,登记表不会替它停登录)。
		expect(login.stop).toHaveBeenCalledTimes(1);
		expect(cronMock.instances[0]?.isActive).toBe(false);
		expect(source.dynamic()).toBeUndefined();
		expect(watchDisposed).toHaveBeenCalledTimes(3);
		expect(setHealthCheckMs).toHaveBeenLastCalledWith(0);
		expect(ctx.reportProblem).not.toHaveBeenCalled();
		// 设置再变:被摘掉的订阅不会造出新的动态轮询
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

	it("来源用的是上下文的 fetchImage:带图的动态,作品里图的引用就是上下文回的那个", async () => {
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
		const { deps } = makeDeps({ fetchAllDynamic: async () => feed });
		const source = createBiliSource(deps);
		const { ctx, reportPost, fetchImage } = makeCtx([{ externalId: "1", post: true }]);
		await source.start(ctx);
		vi.setSystemTime(new Date("2026-10-11T00:00:20Z"));
		await source.dynamic()?.detectNow();
		expect(fetchImage).toHaveBeenCalled();
		expect(reportPost).toHaveBeenCalledTimes(1);
		expect(reportPost.mock.calls[0]?.[1].post.images?.[0]?.ref).toBe(CONTEXT_IMAGE_REF);
		await source.stop();
	});
});

describe("B 站来源 · health()(给 status 指令的那一行)", () => {
	const MIN = 60_000;
	/** 来源 + 一个能拨的时钟;动态轮询的 `lastFetchAt` 取真时钟,所以把假时钟拨到「抓取时刻 + 一段」。 */
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

	// 验红:`health()` 里再读登录口的 `state()` 拼进半句登录,这条红。
	it("没登录时这一行不变:health() 不额外读登录态(登录由 status 的「登录」一行说)", async () => {
		const state = vi.fn(() => ({ status: "logged-out" as const }));
		const made = makeDeps({ auth: { ...FAKE_AUTH, state } });
		const source = createBiliSource(made.deps);
		await source.start(makeCtx([{ externalId: "1", post: true }]).ctx);
		const readsAtStart = state.mock.calls.length;
		expect(source.health?.()).toEqual({ summary: "还没抓过" });
		expect(state).toHaveBeenCalledTimes(readsAtStart);
		await source.stop();
	});

	it("没 start / 已 stop → 还没抓过(动态轮询不在、也不是设置读不懂)", async () => {
		const { source } = setup();
		expect(source.health?.()).toEqual({ summary: "还没抓过" });
		await source.start(makeCtx([{ externalId: "1", post: true }]).ctx);
		await source.stop();
		expect(source.health?.()).toEqual({ summary: "还没抓过" });
	});
});

describe("B 站来源 · 端到端(真订阅仓 + 真来源上下文 + 真动态轮询)", () => {
	const T0 = Date.parse("2026-10-11T00:00:00Z");
	const at = (sec: number) => Math.floor(T0 / 1000) + sec;
	const clock = (sec: number) => vi.setSystemTime(new Date(T0 + sec * 1000));

	async function boot(subs = [makeSub("sub-1", "1")]) {
		vi.useFakeTimers({ toFake: ["Date"], now: new Date(T0) });
		const world = makeWorld(subs);
		let feedItems: unknown[] = [];
		const { deps } = makeDeps({
			fetchAllDynamic: async () => ({
				...EMPTY_FEED,
				data: { ...EMPTY_FEED.data, items: feedItems },
			}),
		});
		const source = createBiliSource(deps);
		const enqueue = vi.fn<(event: { subscriptionId: string; postId: string }) => void>();
		const logger = makeLogger();
		const integration = {
			...makeIntegration(),
			state: memoryKeyValueStores("state").store,
		} as IntegrationContext;
		const fetchImage = vi.fn<(url: string) => Promise<Result<{ ref: ImageRef }>>>(async () =>
			ok({ ref: CONTEXT_IMAGE_REF }),
		);
		integration.fetchImage = fetchImage;
		const registry = createSourceRegistry();
		const registration = await registerBuiltinSource({
			registry,
			linkResolvers: createLinkResolverRegistry(),
			aiToolProviders: createAiToolProviderRegistry(),
			source,
			integration,
			sourceKey: SOURCE_KEY,
			subscriptions: world.store,
			defaults: () => world.globals.defaults,
			bus: world.bus,
			logger,
			enqueue: enqueue as never,
			liveSignals: () => {},
			liveInteractions: () => {},
			profiles: () => {},
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
		const gate = deferred<Result<{ ref: ImageRef }>>();
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

describe("createBiliSource — 关注同步", () => {
	const loggedIn = { status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" } as const;

	it("已登录 start → 只查作品开着的人", async () => {
		const auth = makeAuth(loggedIn);
		const made = makeDeps({ auth: auth.auth });
		const source = createBiliSource(made.deps);
		await source.start(
			makeCtx([
				{ externalId: "1", post: true },
				{ externalId: "2", post: false },
			]).ctx,
		);

		await vi.waitFor(() => expect(made.fetchRelations).toHaveBeenCalledWith(["1"]));
		expect(made.fetchRelations).not.toHaveBeenCalledWith(["1", "2"]);
		await source.stop();
	});

	it("名单里新加一个人 → 只对他发一轮关注", async () => {
		const auth = makeAuth(loggedIn);
		const made = makeDeps({ auth: auth.auth });
		const roster = [{ externalId: "1", post: true }];
		const source = createBiliSource(made.deps);
		const fake = makeCtx(roster);
		await source.start(fake.ctx);
		await vi.waitFor(() => expect(made.fetchRelations).toHaveBeenCalledWith(["1"]));

		roster.push({ externalId: "2", post: true });
		for (const changed of fake.watchers) changed();

		await vi.waitFor(() => expect(made.fetchRelations).toHaveBeenCalledWith(["2"]));
		expect(made.fetchRelations).toHaveBeenCalledTimes(2);
		await source.stop();
	});

	// 补关注是写接口、最招风控:名单回调只对新进关注范围的人发请求。验红:把回调里的 `run(added)` 换成 `run()`,这条红。
	it("名单变了但没人新进关注范围 → 一个请求都不发", async () => {
		const auth = makeAuth(loggedIn);
		const made = makeDeps({ auth: auth.auth });
		const roster = [
			{ externalId: "1", post: true },
			{ externalId: "2", post: false },
		];
		const source = createBiliSource(made.deps);
		const fake = makeCtx(roster);
		await source.start(fake.ctx);
		await vi.waitFor(() => expect(made.follow).toHaveBeenCalledWith("1"));

		// 只开直播的那位还是只开直播:名单回调来了,但关注范围没变。
		for (const changed of fake.watchers) changed();

		expect(made.fetchRelations).toHaveBeenCalledTimes(1);
		expect(made.follow).toHaveBeenCalledTimes(1);
		await source.stop();
	});

	// 定案许了「剩下的等下一次关注同步」:撞风控那一轮没处理完的人,下一次名单变化要带上。
	it("撞风控那一轮欠着的人,名单下一次变化时一起补", async () => {
		const auth = makeAuth(loggedIn);
		let first = true;
		const made = makeDeps({
			auth: auth.auth,
			fetchRelations: async () => {
				if (first) {
					first = false;
					return fail("rate_limited", "请求过于频繁", { upstreamCode: -352 });
				}
				return ok({ data: null });
			},
		});
		const roster = [{ externalId: "1", post: true }];
		const source = createBiliSource(made.deps);
		const fake = makeCtx(roster);
		await source.start(fake.ctx);
		await vi.waitFor(() => expect(made.fetchRelations).toHaveBeenCalledWith(["1"]));
		// 等那一轮的收尾把欠着的记下来(结果在 promise 里回来)。
		await new Promise((resolve) => setTimeout(resolve, 0));

		roster.push({ externalId: "2", post: true });
		for (const changed of fake.watchers) changed();

		await vi.waitFor(() => expect(made.fetchRelations).toHaveBeenCalledTimes(2));
		expect(made.fetchRelations).toHaveBeenLastCalledWith(["1", "2"]);
		await source.stop();
	});

	it("撞风控欠着的人,名单变了但没人新进时也补一轮", async () => {
		const auth = makeAuth(loggedIn);
		let first = true;
		const made = makeDeps({
			auth: auth.auth,
			fetchRelations: async () => {
				if (first) {
					first = false;
					return fail("rate_limited", "请求过于频繁", { upstreamCode: -352 });
				}
				return ok({ data: null });
			},
		});
		const roster = [{ externalId: "1", post: true }];
		const source = createBiliSource(made.deps);
		const fake = makeCtx(roster);
		await source.start(fake.ctx);
		await vi.waitFor(() => expect(made.fetchRelations).toHaveBeenCalledWith(["1"]));
		await new Promise((resolve) => setTimeout(resolve, 0));

		for (const changed of fake.watchers) changed();

		await vi.waitFor(() => expect(made.fetchRelations).toHaveBeenCalledTimes(2));
		expect(made.fetchRelations).toHaveBeenLastCalledWith(["1"]);
		await source.stop();
	});

	// 主人 10-27 定（乙）：欠着的非空时，关注同步自己按 `RISK_BACKOFF_STEPS_MS` 的档位再跑一轮。
	// 只用假定时器，不能用 `vi.waitFor`（它会和假定时器互相等死）。
	const timerHandoff = (fn: () => void, ms: number): { dispose(): void } => {
		const handle = setTimeout(fn, ms);
		return { dispose: () => clearTimeout(handle) };
	};
	const settle = async (): Promise<void> => {
		await vi.advanceTimersByTimeAsync(0);
	};

	it("撞风控欠着 → 60 秒后自动再查一次,只发一个读、参数是欠着的人", async () => {
		vi.useFakeTimers();
		const auth = makeAuth(loggedIn);
		const made = makeDeps({
			auth: auth.auth,
			setTimeout: timerHandoff,
			fetchRelations: async () => fail("rate_limited", "请求过于频繁", { upstreamCode: -352 }),
		});
		const source = createBiliSource(made.deps);
		await source.start(
			makeCtx([
				{ externalId: "1", post: true },
				{ externalId: "2", post: true },
			]).ctx,
		);
		await settle();
		expect(made.fetchRelations).toHaveBeenCalledTimes(1);
		expect(made.follow).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(60_000);

		expect(made.fetchRelations).toHaveBeenCalledTimes(2);
		expect(made.fetchRelations).toHaveBeenLastCalledWith(["1", "2"]);
		// 还在风控：重试那一轮也只发这一个读，一个写都不发。
		expect(made.follow).not.toHaveBeenCalled();
		await source.stop();
	});

	it("重试还在风控 → 下一档 5 分钟后", async () => {
		vi.useFakeTimers();
		const auth = makeAuth(loggedIn);
		let calls = 0;
		const made = makeDeps({
			auth: auth.auth,
			setTimeout: timerHandoff,
			fetchRelations: async () => {
				calls++;
				return calls <= 2
					? fail("rate_limited", "请求过于频繁", { upstreamCode: -352 })
					: ok({ data: null });
			},
		});
		const source = createBiliSource(made.deps);
		await source.start(makeCtx([{ externalId: "1", post: true }]).ctx);
		await settle();
		expect(made.fetchRelations).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(made.fetchRelations).toHaveBeenCalledTimes(2);

		await vi.advanceTimersByTimeAsync(299_999);
		expect(made.fetchRelations).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(made.fetchRelations).toHaveBeenCalledTimes(3);
		await source.stop();
	});

	it("重试补全 → 不再挂计时器,档位归零", async () => {
		vi.useFakeTimers();
		const auth = makeAuth(loggedIn);
		let calls = 0;
		const made = makeDeps({
			auth: auth.auth,
			setTimeout: timerHandoff,
			fetchRelations: async () => {
				calls++;
				return calls === 1 || calls === 3
					? fail("rate_limited", "请求过于频繁", { upstreamCode: -352 })
					: ok({ data: null });
			},
		});
		const roster = [{ externalId: "1", post: true }];
		const fake = makeCtx(roster);
		const source = createBiliSource(made.deps);
		await source.start(fake.ctx);
		await settle();
		expect(made.fetchRelations).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(made.fetchRelations).toHaveBeenCalledTimes(2);
		expect(made.follow).toHaveBeenCalledWith("1");

		// 欠账清了:再等多久都不该有下一轮。
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		expect(made.fetchRelations).toHaveBeenCalledTimes(2);

		// 档位归零:下一次风控从 60 秒重新起算,不是接着上一档的 5 分钟。
		roster.push({ externalId: "2", post: true });
		for (const changed of fake.watchers) changed();
		await settle();
		expect(made.fetchRelations).toHaveBeenCalledTimes(3);

		await vi.advanceTimersByTimeAsync(59_999);
		expect(made.fetchRelations).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(1);
		expect(made.fetchRelations).toHaveBeenCalledTimes(4);
		await source.stop();
	});

	it("没登录时不重试", async () => {
		vi.useFakeTimers();
		const auth = makeAuth(loggedIn);
		const made = makeDeps({
			auth: auth.auth,
			setTimeout: timerHandoff,
			fetchRelations: async () => fail("rate_limited", "请求过于频繁", { upstreamCode: -352 }),
		});
		const source = createBiliSource(made.deps);
		await source.start(makeCtx([{ externalId: "1", post: true }]).ctx);
		await settle();
		expect(made.fetchRelations).toHaveBeenCalledTimes(1);

		auth.set({ status: "logged-out" });
		await vi.advanceTimersByTimeAsync(60_000);

		expect(made.fetchRelations).toHaveBeenCalledTimes(1);
		await source.stop();
	});

	it("dispose 之后不再重试", async () => {
		vi.useFakeTimers();
		const auth = makeAuth(loggedIn);
		const made = makeDeps({
			auth: auth.auth,
			setTimeout: timerHandoff,
			fetchRelations: async () => fail("rate_limited", "请求过于频繁", { upstreamCode: -352 }),
		});
		const source = createBiliSource(made.deps);
		await source.start(makeCtx([{ externalId: "1", post: true }]).ctx);
		await settle();
		expect(made.fetchRelations).toHaveBeenCalledTimes(1);

		await source.stop();
		await vi.advanceTimersByTimeAsync(30 * 60_000);

		expect(made.fetchRelations).toHaveBeenCalledTimes(1);
	});

	it("作品关掉 → 按不再适用清掉那个人的 follow_failed", async () => {
		const auth = makeAuth(loggedIn);
		const made = makeDeps({
			auth: auth.auth,
			follow: async () => fail("unavailable", "关注失败"),
		});
		const roster = [{ externalId: "1", post: true }];
		const source = createBiliSource(made.deps);
		const fake = makeCtx(roster);
		await source.start(fake.ctx);
		await vi.waitFor(() =>
			expect(fake.ctx.reportProblem).toHaveBeenCalledWith(
				expect.objectContaining({ externalId: "1", code: "follow_failed" }),
			),
		);

		const first = roster[0];
		if (first === undefined) throw new Error("roster fixture is empty");
		first.post = false;
		for (const changed of fake.watchers) changed();

		expect(fake.ctx.resolveProblem).toHaveBeenCalledWith(
			expect.objectContaining({ externalId: "1", code: "follow_failed", notify: false }),
		);
		await source.stop();
	});

	it("auth.onChange 从没登录变已登录 → 全量再跑一轮", async () => {
		const auth = makeAuth({ status: "logged-out" });
		const made = makeDeps({ auth: auth.auth });
		const source = createBiliSource(made.deps);
		await source.start(makeCtx([{ externalId: "1", post: true }]).ctx);
		expect(made.fetchRelations).not.toHaveBeenCalled();

		auth.set(loggedIn);

		await vi.waitFor(() => expect(made.fetchRelations).toHaveBeenCalledWith(["1"]));
		await source.stop();
	});

	it("没登录时名单变化只更新集合,不发请求", async () => {
		const auth = makeAuth({ status: "logged-out" });
		const made = makeDeps({ auth: auth.auth });
		const roster = [{ externalId: "1", post: true }];
		const source = createBiliSource(made.deps);
		const fake = makeCtx(roster);
		await source.start(fake.ctx);

		roster.push({ externalId: "2", post: true });
		for (const changed of fake.watchers) changed();

		expect(made.fetchRelations).not.toHaveBeenCalled();
		expect(made.follow).not.toHaveBeenCalled();
		await source.stop();
	});

	it("stop() 后在途那一轮不再发下一个关注", async () => {
		const auth = makeAuth(loggedIn);
		const first = deferred<void>();
		const follow = vi.fn(() => first.promise.then(() => ok()));
		const made = makeDeps({ auth: auth.auth, follow });
		const source = createBiliSource(made.deps);
		const fake = makeCtx([
			{ externalId: "1", post: true },
			{ externalId: "2", post: true },
		]);
		await source.start(fake.ctx);
		await vi.waitFor(() => expect(follow).toHaveBeenCalledWith("1"));

		await source.stop();
		first.resolve();

		await first.promise;
		expect(follow).toHaveBeenCalledTimes(1);
		expect(follow).not.toHaveBeenCalledWith("2");
	});
});

describe("createBiliSource — 登录那一套归来源:造一次、start 第一步起、stop 最后一步停", () => {
	const REAL_AUTH_MARK = { ...FAKE_AUTH } as Required<SourceAuth>;

	it("构造时 Source.auth 就在(登记表在 start 之前就抄它),就是登录系统交出的登录口", () => {
		const { deps, login } = makeDeps({ auth: REAL_AUTH_MARK });
		const source = createBiliSource(deps);
		expect(source.auth).toBe(REAL_AUTH_MARK);
		expect(login.start).not.toHaveBeenCalled();
	});

	// 验红:去掉 `start` 里的 `await login.start()`(或挪到动态轮询起来之后),这条红(动态轮询在登录落定之前就起了)。
	it("start 第一步是起登录:它落定之前动态轮询与直播监听一个都不起,落定之后才起", async () => {
		const { deps, login } = makeDeps();
		const gate = deferred<void>();
		login.start.mockImplementationOnce(() => gate.promise);
		const source = createBiliSource(deps);
		const { ctx } = makeCtx([{ externalId: "1", post: true }]);

		const starting = source.start(ctx);
		await Promise.resolve();
		expect(login.start).toHaveBeenCalledTimes(1);
		expect(cronMock.instances).toHaveLength(0);
		expect(roomsMock.instances).toHaveLength(0);

		gate.resolve();
		await starting;
		expect(cronMock.instances).toHaveLength(1);
		expect(roomsMock.instances).toHaveLength(1);
		await source.stop();
	});

	it("登录起不来:start 抛出登录的错、登录被停、来源什么都没留下,再 start 能成", async () => {
		const { deps, login } = makeDeps();
		login.start.mockRejectedValueOnce(new Error("登录起不来"));
		const source = createBiliSource(deps);
		const { ctx } = makeCtx([{ externalId: "1", post: true }]);

		await expect(source.start(ctx)).rejects.toThrow("登录起不来");
		expect(login.stop).toHaveBeenCalledTimes(1);
		expect(cronMock.instances).toHaveLength(0);
		expect(source.dynamic()).toBeUndefined();
		expect(source.login()).toBeUndefined();

		await source.start(ctx);
		expect(source.dynamic()?.isActive).toBe(true);
		await source.stop();
	});

	// 验红:去掉 `stop` 末尾的 `login.stop()`,或把它挪到动态轮询停之前,这条红。
	it("stop 的同步段里先停干净自己的活(心跳摘掉、动态轮询停掉),最后才停登录", async () => {
		const { deps, login, setHealthCheckMs } = makeDeps();
		const source = createBiliSource(deps);
		await source.start(makeCtx([{ externalId: "1", post: true }]).ctx);
		let engineActiveWhenLoginStopped: boolean | undefined;
		login.stop.mockImplementation(() => {
			engineActiveWhenLoginStopped = cronMock.instances[0]?.isActive;
		});

		const stopping = source.stop();

		// 同步段:不用等 promise,登录已经停了、动态轮询已经不在。
		expect(login.stop).toHaveBeenCalledTimes(1);
		expect(engineActiveWhenLoginStopped).toBe(false);
		expect(setHealthCheckMs.mock.invocationCallOrder.at(-1)).toBeLessThan(
			login.stop.mock.invocationCallOrder[0] ?? 0,
		);
		expect(setHealthCheckMs).toHaveBeenLastCalledWith(0);
		await stopping;
	});

	it("动态轮询与直播监听读登录系统交出的原始登录口,Source.auth 读套过壳的;Api 一律是壳(开发壳钩子)", async () => {
		const { deps, login } = makeDeps({ auth: REAL_AUTH_MARK });
		const shellAuth = { ...REAL_AUTH_MARK } as Required<SourceAuth>;
		const shellApi = { fetchAllDynamic: async () => EMPTY_FEED } as unknown as Api;
		const devShells = {
			api: vi.fn((_real: Api) => shellApi),
			auth: vi.fn((_real: Required<SourceAuth>) => shellAuth),
		};
		const source = createBiliSource({ ...deps, devShells });
		expect(devShells.api).toHaveBeenCalledWith(login.api);
		expect(devShells.auth).toHaveBeenCalledWith(REAL_AUTH_MARK);
		expect(source.auth).toBe(shellAuth);
		expect(source.api()).toBe(shellApi);

		await source.start(makeCtx([{ externalId: "1", monitorsLive: true }]).ctx);

		const opts = roomsMock.instances[0]?.opts as unknown as { auth: unknown; api: unknown };
		expect(opts.auth).toBe(REAL_AUTH_MARK);
		expect(opts.api).toBe(shellApi);
		await source.stop();
	});

	it("不传开发壳钩子(生产):Api 与 Source.auth 都是登录系统造的原样", () => {
		const { deps, login } = makeDeps({ auth: REAL_AUTH_MARK });
		const source = createBiliSource(deps);
		expect(source.api()).toBe(login.api);
		expect(source.auth).toBe(REAL_AUTH_MARK);
	});

	it("login() 把手:start 前与 stop 后是 undefined,运行中把三个登录口原样转给登录系统", async () => {
		const { deps, login } = makeDeps();
		login.healthCheckNow.mockResolvedValue(false);
		const source = createBiliSource(deps);
		expect(source.login()).toBeUndefined();

		await source.start(makeCtx().ctx);
		await expect(source.login()?.healthCheckNow()).resolves.toBe(false);
		await source.login()?.handleAuthLost();
		await source.login()?.reportAccountInfo();
		expect(login.healthCheckNow).toHaveBeenCalledTimes(1);
		expect(login.handleAuthLost).toHaveBeenCalledTimes(1);
		expect(login.reportAccountInfo).toHaveBeenCalledTimes(1);

		await source.stop();
		expect(source.login()).toBeUndefined();
	});
});
