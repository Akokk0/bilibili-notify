import {
	BILIBILI_GUARD_PROGRAM,
	type Disposable,
	fail,
	type ImageRef,
	type IntegrationContext,
	type LiveInteractionReader,
	type Logger,
	makeDefaultGlobalConfig,
	makeEmptySubscription,
	ok,
	type PostReport,
	type Result,
	type Source,
	type SourceAuth,
	type SourceContext,
	type SourceDescriptor,
	type Subscription,
} from "@bilibili-notify/internal";
import { createSubscriptionStore } from "@bilibili-notify/subscription";
import { type Mock, vi } from "vite-plus/test";
import { noCandidates, noProfile } from "../../__tests__/support/no-candidates.js";
import { createIntegrationSettings } from "../../integrations/settings-reader.js";
import type { ProblemTable } from "../../problems/problem-table.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { createSourceRegistry, type SourceRegistry } from "../registry.js";

export const SOURCE_KEY = "bilibili";

type SpyLogger = {
	[K in keyof Logger]: Mock<(msg: string, ...args: unknown[]) => void>;
};

export const makeLogger = (): SpyLogger => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
});

/**
 * 公共那一面(含 `http`、`fetchImage`、`storeImage`)+ 故意多带一格 `cookies`,模拟 B 站交进来的那个对象运行时的样子。
 * `settings` 是真的集成读手(`createIntegrationSettings`),读源是 `settingsHost`(不给就是一份空对象)。
 */
export const makeIntegration = (
	logger: Logger = makeLogger(),
	settingsHost: Pick<
		ReturnType<typeof makeSettingsHost>,
		"read" | "onChanged"
	> = makeSettingsHost(),
): IntegrationContext => {
	const kv = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
	return {
		timezone: () => "Asia/Shanghai",
		onTimezoneChanged: () => ({ dispose() {} }),
		logger,
		signal: new AbortController().signal,
		onDispose: vi.fn(),
		state: kv,
		secrets: kv,
		redact: vi.fn(),
		reportProblem: vi.fn(),
		resolveProblem: vi.fn(),
		settings: createIntegrationSettings({
			read: settingsHost.read,
			onChanged: settingsHost.onChanged,
			logger,
		}).settings,
		http: { fetch: vi.fn(), websocket: vi.fn() },
		fetchImage: vi.fn(),
		storeImage: vi.fn(),
		cookies: { header: vi.fn() },
	} as unknown as IntegrationContext;
};

/**
 * 集成上下文的 `settings` 读源的假宿主:盘上那一份可以 `set` 换掉(换完叫一声「可能变了」),
 * `listenerCount` 数得出挂着几个监听。不给初值就是一份空对象。
 */
export const makeSettingsHost = (initial: Result<{ settings: unknown }> = ok({ settings: {} })) => {
	let current = initial;
	const listeners = new Set<() => void>();
	return {
		read: (): Result<{ settings: unknown }> => current,
		onChanged(fn: () => void): Disposable {
			listeners.add(fn);
			return { dispose: () => void listeners.delete(fn) };
		},
		set(next: Result<{ settings: unknown }>) {
			current = next;
			for (const fn of [...listeners]) fn();
		},
		listenerCount: () => listeners.size,
	};
};

/** 问题表的写口替身:三个动作都是 spy。 */
export const makeProblems = () => ({
	report: vi.fn<ProblemTable["report"]>(),
	resolve: vi.fn<ProblemTable["resolve"]>(),
	clearReporter: vi.fn<ProblemTable["clearReporter"]>(),
});

export const makeSub = (
	id: string,
	externalId: string,
	patch: Partial<Subscription> = {},
	sourceKey = SOURCE_KEY,
): Subscription => ({
	...makeEmptySubscription({ id, identity: { sourceKey, externalId } }),
	enabled: true,
	...patch,
});

/** 真总线 + 真订阅仓,测试里改仓、发事件都是真的。 */
export const makeWorld = (subs: Subscription[] = []) => {
	const bus = createNodeMessageBus();
	const store = createSubscriptionStore(bus);
	for (const s of subs) store.upsert(s);
	const globals = makeDefaultGlobalConfig();
	return { bus, store, globals };
};

/**
 * 一张登了来源的真登记表。`register` 在第一个 `await` 之前就把键认领了,所以这里不必等它 ——
 * 假来源的 `start` 什么都不做。
 */
export const sourceRegistryOf = (...descriptors: Partial<SourceDescriptor>[]): SourceRegistry => {
	const registry = createSourceRegistry();
	descriptors.forEach((descriptor, index) => {
		void registry.register(
			`probe-${index}`,
			{
				descriptor: { label: "测试", supportedFeatures: ["post"], ...descriptor },
				searchCreators: noCandidates,
				fetchProfile: noProfile,
				start: async () => {},
				stop: async () => {},
			},
			{} as SourceContext,
		);
	});
	return registry;
};

/**
 * 登着 B 站那份描述符(大航海三档)的来源登记表;可用测试引用或懒取口替换档图。卡片预览的用例可以再给它
 * 一个 `fetchPreview` 与登录着的账号名(`auth.account()` 只答名字)。
 */
export const bilibiliLikeSources = (
	options: {
		iconRef?: ImageRef;
		fetchTierIcon?: LiveInteractionReader["fetchTierIcon"];
		fetchPreview?: Source["fetchPreview"];
		accountName?: string;
	} = {},
): SourceRegistry => {
	const registry = createSourceRegistry();
	const program = {
		...BILIBILI_GUARD_PROGRAM,
		tiers: Array.isArray(BILIBILI_GUARD_PROGRAM.tiers)
			? BILIBILI_GUARD_PROGRAM.tiers.map((tier) => ({
					...tier,
					icon: { ...tier.icon, ...(options.iconRef ? { ref: options.iconRef } : {}) },
				}))
			: BILIBILI_GUARD_PROGRAM.tiers,
	};
	void registry.register(
		SOURCE_KEY,
		{
			descriptor: { label: "B 站", supportedFeatures: ["post"], membershipPrograms: [program] },
			searchCreators: noCandidates,
			fetchProfile: noProfile,
			liveInteractions: {
				fetchViewerAvatar: async () => fail("unavailable", "no viewer avatar"),
				fetchTierIcon: options.fetchTierIcon ?? (async () => fail("unavailable", "no tier icon")),
			},
			...(options.fetchPreview ? { fetchPreview: options.fetchPreview } : {}),
			...(options.accountName === undefined
				? {}
				: { auth: { account: () => ({ name: options.accountName }) } as unknown as SourceAuth }),
			start: async () => {},
			stop: async () => {},
		},
		{} as SourceContext,
	);
	return registry;
};

/** 假来源:`start` 时记下来源上下文(`started` 记全部、`ctx` 是最近一个),`stop` 记一次;`start` / `stop` 是 spy,可换实现。 */
export interface FakeSource extends Source {
	started: SourceContext[];
	stops: number;
	ctx?: SourceContext;
	start: Mock<(ctx: SourceContext) => Promise<void>>;
	stop: Mock<() => Promise<void>>;
	/** 假来源经上下文交作品。 */
	reportPost(externalId: string, report: PostReport): void;
}

export const makeSource = (): FakeSource => {
	const source: FakeSource = {
		descriptor: { label: "测试", supportedFeatures: ["post"], postNoun: "动态" },
		searchCreators: noCandidates,
		fetchProfile: noProfile,
		started: [],
		stops: 0,
		start: vi.fn(async (ctx: SourceContext) => {
			source.started.push(ctx);
			source.ctx = ctx;
		}),
		stop: vi.fn(async () => {
			source.stops += 1;
		}),
		reportPost(externalId, report) {
			if (!source.ctx) throw new Error("假来源还没 start");
			source.ctx.reportPost(externalId, report);
		},
	};
	return source;
};
