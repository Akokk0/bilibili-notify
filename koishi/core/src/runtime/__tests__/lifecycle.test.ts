/**
 * 刻画测试:钉住 bringUp()/tearDown() 的槽位生命周期契约 —— 切片9深度重构(render/
 * ai/dynamic/live 从 Service 改造成普通类、构造挪进 bringUp() 内部)的安全网。
 *
 * 1. bringUp() 一次性造好 api/push/loginBridge/store/registry/subLoader/engines
 *    并填入 slots。
 * 2. tearDown() 按顺序释放 cleanups、析构 engines、停掉各 slot、最终把 slots 全部
 *    清空为 null。
 * 3. `bn restart`(tearDown 再 bringUp)之后,新一轮的实例(含 engines)与旧一轮
 *    **不是同一个引用**—— 这正是本次重构要修的潜伏 bug:重构前 render/ai/dynamic/
 *    live 由独立 ctx.plugin() 注册,restart 并不会重建它们;重构后它们与 api/push
 *    同生命周期,必须同样在每轮 bringUp/tearDown 间保持"新鲜"。
 * 4. cleanups 数组在 tearDown 后归零,不会跨重启累积 listener。
 */

import type { Logger } from "koishi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BilibiliNotifyConfig } from "../../config";

const apiInstances: Array<Record<string, unknown>> = [];
const pushInstances: Array<Record<string, unknown>> = [];
const loginBridgeInstances: Array<Record<string, unknown>> = [];
const subLoaderInstances: Array<Record<string, unknown>> = [];
const registryInstances: Array<Record<string, unknown>> = [];
const storeInstances: Array<Record<string, unknown>> = [];
const enginesBuilt: Array<Record<string, unknown>> = [];

vi.mock("@bilibili-notify/api", () => {
	class BilibiliAPI {
		start = vi.fn().mockResolvedValue(undefined);
		stop = vi.fn();
		loadCookies = vi.fn().mockResolvedValue(undefined);
		markLoginInfoLoaded = vi.fn();
		// 返回含 bili_jct 的 cookie,让 hasLoginCookie() 走"已登录"分支,
		// 避免额外分叉出冷启动未登录的 listener 挂载路径。
		getCookiesJson = vi.fn().mockReturnValue(JSON.stringify([{ key: "bili_jct" }]));
		constructor(public opts: unknown) {
			apiInstances.push(this as unknown as Record<string, unknown>);
		}
	}
	return { BilibiliAPI, BiliLoginStatus: { LOGGED_IN: 1, NOT_LOGIN: 0 } };
});

vi.mock("@bilibili-notify/push", () => {
	class BilibiliPush {
		start = vi.fn();
		stop = vi.fn();
		recheckMasterReachability = vi.fn();
		sendPrivateMsg = vi.fn().mockResolvedValue(undefined);
		constructor(public opts: unknown) {
			pushInstances.push(this as unknown as Record<string, unknown>);
		}
	}
	return { BilibiliPush };
});

vi.mock("@bilibili-notify/subscription", () => ({
	createSubscriptionStore: vi.fn(() => {
		const store = { list: vi.fn().mockReturnValue([]), replaceAll: vi.fn() };
		storeInstances.push(store);
		return store;
	}),
}));

vi.mock("../service-context", () => ({
	makeKoishiMessageBus: vi.fn(() => ({ on: vi.fn(), emit: vi.fn() })),
	makeKoishiServiceContext: vi.fn(() => ({
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		setInterval: vi.fn(),
		setTimeout: vi.fn(),
		onDispose: vi.fn(),
	})),
}));

// render/ai/dynamic/live 引擎的真实构造(DynamicEngine/LiveEngine 等)不是本测试
// 关心的行为 —— 只钉住"bringUp 造一份、tearDown 析构一份、restart 换新一份"这个
// 生命周期契约,engines 本身的构造细节由各自的单测覆盖。
vi.mock("../engines", () => ({
	buildEngines: vi.fn(() => {
		const engines = { render: null, ai: null, dynamic: {}, live: {}, stop: vi.fn() };
		enginesBuilt.push(engines);
		return engines;
	}),
	disposeEngines: vi.fn(),
}));

vi.mock("../../bridges/login-flow-bridge", () => {
	class LoginFlowBridge {
		install = vi.fn();
		flow = {
			start: vi.fn().mockResolvedValue(undefined),
			stop: vi.fn(),
			reportAccountInfo: vi.fn().mockResolvedValue(undefined),
			reportLoggedOut: vi.fn(),
			current: vi.fn(),
			handleAuthLost: vi.fn(),
		};
		constructor(public opts: unknown) {
			loginBridgeInstances.push(this as unknown as Record<string, unknown>);
		}
		stop = vi.fn();
	}
	return { LoginFlowBridge };
});

vi.mock("../../subscriptions/subscription-loader", () => {
	class SubscriptionLoader {
		loadInitialSubscriptions = vi.fn().mockResolvedValue(undefined);
		dispose = vi.fn();
		constructor(public opts: unknown) {
			subLoaderInstances.push(this as unknown as Record<string, unknown>);
		}
	}
	return { SubscriptionLoader };
});

vi.mock("../../push/target-registry", () => {
	class TargetRegistry {
		findKoishiBotAdapter = vi.fn();
		setAdapter = vi.fn();
		set = vi.fn();
		get = vi.fn();
		getAdapter = vi.fn();
		clear = vi.fn();
		constructor() {
			registryInstances.push(this as unknown as Record<string, unknown>);
		}
	}
	return { TargetRegistry };
});

vi.mock("../../push/sink", () => ({
	createKoishiSink: vi.fn(() => ({})),
}));

vi.mock("../../push/target-synthesis", () => ({
	synthesizeKoishiBotAdapter: vi.fn(),
	synthesizeMasterTarget: vi.fn(),
}));

const { bringUp, tearDown } = await import("../lifecycle");
const { disposeEngines } = await import("../engines");

function makeFakeCtx() {
	const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
	return {
		on(name: string, fn: (...args: unknown[]) => void) {
			let set = listeners.get(name);
			if (!set) {
				set = new Set();
				listeners.set(name, set);
			}
			set.add(fn);
			return () => set?.delete(fn);
		},
		emit(name: string, ...args: unknown[]) {
			for (const fn of listeners.get(name) ?? []) fn(...args);
		},
		sleep: vi.fn().mockResolvedValue(undefined),
		// biome-ignore lint/suspicious/noExplicitAny: 测试替身,只需满足 bringUp() 用到的 ctx 表面
	} as any;
}

function makeConfig(): BilibiliNotifyConfig {
	return {
		account: {
			userAgent: "test-ua",
			logLevel: 2,
			loginHealthCheckMinutes: 5,
			cookieEncryptionKey: undefined,
		},
		push: { master: { enable: false }, quietHours: [] },
		subscriptions: { list: [] },
		render: { enabled: false },
		ai: { enabled: false },
		dynamic: {},
		live: {},
		advancedSub: { enabled: false, subs: {} },
		// biome-ignore lint/suspicious/noExplicitAny: 测试只填 bringUp() 实际读取的字段
	} as any;
}

function makeStorageMgr() {
	return {
		cookieStore: {
			load: vi.fn().mockResolvedValue(null),
			save: vi.fn().mockResolvedValue(undefined),
			resetKey: vi.fn().mockResolvedValue(undefined),
		},
		// biome-ignore lint/suspicious/noExplicitAny: 测试替身
	} as any;
}

function makeLogger(): Logger {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

// biome-ignore lint/suspicious/noExplicitAny: ManagerSlots 测试替身
function makeSlots(): any {
	return {
		api: null,
		push: null,
		loginBridge: null,
		store: null,
		registry: null,
		subLoader: null,
		engines: null,
		cleanups: [],
	};
}

describe("bringUp/tearDown — 槽位生命周期契约(切片9重构基线)", () => {
	beforeEach(() => {
		apiInstances.length = 0;
		pushInstances.length = 0;
		loginBridgeInstances.length = 0;
		subLoaderInstances.length = 0;
		registryInstances.length = 0;
		storeInstances.length = 0;
		enginesBuilt.length = 0;
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("bringUp() 一次性把 api/push/loginBridge/store/registry/subLoader/engines 填进 slots", async () => {
		const ctx = makeFakeCtx();
		const slots = makeSlots();

		const ok = await bringUp({
			ctx,
			logger: makeLogger(),
			getConfig: makeConfig,
			storageMgr: makeStorageMgr(),
			slots,
			subList: () => "没有订阅任何UP",
		});

		expect(ok).toBe(true);
		expect(slots.api).toBe(apiInstances[0]);
		expect(slots.push).toBe(pushInstances[0]);
		expect(slots.loginBridge).toBe(loginBridgeInstances[0]);
		expect(slots.store).toBe(storeInstances[0]);
		expect(slots.registry).toBe(registryInstances[0]);
		expect(slots.subLoader).toBe(subLoaderInstances[0]);
		expect(slots.engines).toBe(enginesBuilt[0]);
	});

	it("tearDown() 释放全部 cleanups、析构 engines、停掉各 slot、把 slots 清空为 null", async () => {
		const ctx = makeFakeCtx();
		const slots = makeSlots();
		await bringUp({
			ctx,
			logger: makeLogger(),
			getConfig: makeConfig,
			storageMgr: makeStorageMgr(),
			slots,
			subList: () => "没有订阅任何UP",
		});

		const api = slots.api;
		const push = slots.push;
		const loginBridge = slots.loginBridge;
		const subLoader = slots.subLoader;
		const engines = slots.engines;
		expect(slots.cleanups.length).toBeGreaterThan(0);

		tearDown({ logger: makeLogger(), slots });

		expect(disposeEngines).toHaveBeenCalledWith(engines);
		expect(push.stop).toHaveBeenCalledTimes(1);
		expect(api.stop).toHaveBeenCalledTimes(1);
		expect(loginBridge.stop).toHaveBeenCalledTimes(1);
		expect(subLoader.dispose).toHaveBeenCalledTimes(1);
		expect(slots.api).toBeNull();
		expect(slots.push).toBeNull();
		expect(slots.loginBridge).toBeNull();
		expect(slots.store).toBeNull();
		expect(slots.registry).toBeNull();
		expect(slots.subLoader).toBeNull();
		expect(slots.engines).toBeNull();
		expect(slots.cleanups).toHaveLength(0);
	});

	it("`bn restart`(tearDown 再 bringUp)产出全新实例(含 engines),不复用旧一轮的引用", async () => {
		const ctx = makeFakeCtx();
		const slots = makeSlots();
		const deps = {
			ctx,
			logger: makeLogger(),
			getConfig: makeConfig,
			storageMgr: makeStorageMgr(),
			slots,
			subList: () => "没有订阅任何UP",
		};

		await bringUp(deps);
		const firstApi = slots.api;
		const firstPush = slots.push;
		const firstRegistry = slots.registry;
		const firstEngines = slots.engines;

		tearDown({ logger: makeLogger(), slots });
		await bringUp(deps);

		expect(slots.api).not.toBeNull();
		expect(slots.api).not.toBe(firstApi);
		expect(slots.push).not.toBe(firstPush);
		expect(slots.registry).not.toBe(firstRegistry);
		expect(slots.engines).not.toBeNull();
		expect(slots.engines).not.toBe(firstEngines);
		expect(apiInstances).toHaveLength(2);
		expect(pushInstances).toHaveLength(2);
		expect(enginesBuilt).toHaveLength(2);
	});

	it("cleanups 不跨重启累积:两轮 bringUp/tearDown 后计数与单轮一致", async () => {
		const ctx = makeFakeCtx();
		const slots = makeSlots();
		const deps = {
			ctx,
			logger: makeLogger(),
			getConfig: makeConfig,
			storageMgr: makeStorageMgr(),
			slots,
			subList: () => "没有订阅任何UP",
		};

		await bringUp(deps);
		const firstRoundCleanupCount = slots.cleanups.length;
		tearDown({ logger: makeLogger(), slots });
		expect(slots.cleanups).toHaveLength(0);

		await bringUp(deps);
		expect(slots.cleanups).toHaveLength(firstRoundCleanupCount);
	});
});
