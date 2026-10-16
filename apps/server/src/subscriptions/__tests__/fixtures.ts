import {
	BILIBILI_GUARD_PROGRAM,
	type Disposable,
	type IntegrationContext,
	type Logger,
	makeDefaultGlobalConfig,
	makeEmptySubscription,
	ok,
	type PostReport,
	type Result,
	type Source,
	type SourceContext,
	type SourceDescriptor,
	type Subscription,
} from "@bilibili-notify/internal";
import { createSubscriptionStore } from "@bilibili-notify/subscription";
import { type Mock, vi } from "vite-plus/test";
import { noCandidates } from "../../__tests__/support/no-candidates.js";
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

/** 公共五格 + 故意多带两格(`http`、`cookies`),模拟 B 站交进来的那个对象运行时的样子。 */
export const makeIntegration = (logger: Logger = makeLogger()): IntegrationContext => {
	const kv = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
	return {
		logger,
		signal: new AbortController().signal,
		onDispose: vi.fn(),
		state: kv,
		secrets: kv,
		redact: vi.fn(),
		reportProblem: vi.fn(),
		resolveProblem: vi.fn(),
		http: { get: vi.fn() },
		cookies: { header: vi.fn() },
	} as unknown as IntegrationContext;
};

/**
 * 来源上下文的 `settings` 那一格的假宿主:盘上那一份可以 `set` 换掉(换完叫一声「可能变了」),
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
				descriptor: { label: "测试", ...descriptor },
				searchCreators: noCandidates,
				start: async () => {},
				stop: async () => {},
			},
			{} as SourceContext,
		);
	});
	return registry;
};

/** 登着 B 站那份描述符(大航海三档)的来源登记表。 */
export const bilibiliLikeSources = (): SourceRegistry =>
	sourceRegistryOf({ membershipPrograms: [BILIBILI_GUARD_PROGRAM] });

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
		descriptor: { label: "测试", postNoun: "动态" },
		searchCreators: noCandidates,
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
