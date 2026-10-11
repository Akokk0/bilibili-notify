import {
	type IntegrationContext,
	type Logger,
	makeDefaultGlobalConfig,
	makeEmptySubscription,
	type Source,
	type SourceContext,
	type Subscription,
} from "@bilibili-notify/internal";
import { createSubscriptionStore } from "@bilibili-notify/subscription";
import { type Mock, vi } from "vite-plus/test";
import { createNodeMessageBus } from "../../runtime/message-bus.js";

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
		http: { get: vi.fn() },
		cookies: { header: vi.fn() },
	} as unknown as IntegrationContext;
};

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

export const makeSource = (): Source & {
	started: SourceContext[];
	stops: number;
} => {
	const source = {
		descriptor: { postNoun: "动态" },
		started: [] as SourceContext[],
		stops: 0,
		async start(ctx: SourceContext) {
			source.started.push(ctx);
		},
		async stop() {
			source.stops += 1;
		},
	};
	return source;
};
