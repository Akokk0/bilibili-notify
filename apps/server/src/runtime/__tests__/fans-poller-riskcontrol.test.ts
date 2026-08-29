/**
 * ① fansCron 解耦 + ② 风控熔断。
 *
 * ①:FansPoller 的 cron 取 `globals.app.fansCron`(不再复用 dynamicCron)。
 * ②:稳态用 getRelationStat 取 follower;某个 UP 命中风控码(-352 等)时立即
 *    **中止本轮 sweep**(不继续刷后面的 UP)并退避,下一 tick 直接跳过 —— 对齐
 *    动态引擎「被限流就别继续敲」的机制。
 */

import type { GlobalConfig } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const cronMock = vi.hoisted(() => {
	const instances: Array<{ cronTime: string; onTick: () => void }> = [];
	class FakeCronJob {
		isActive = false;
		constructor(
			public cronTime: string,
			public onTick: () => void,
		) {
			instances.push(this);
		}
		start(): void {
			this.isActive = true;
		}
		stop(): void {
			this.isActive = false;
		}
	}
	return { instances, FakeCronJob };
});
vi.mock("cron", () => ({ CronJob: cronMock.FakeCronJob }));

const { startFansPoller } = await import("../fans-poller.js");
const { createNodeMessageBus } = await import("../message-bus.js");

const GLOBALS = {
	app: { dynamicCron: "*/2 * * * *", fansCron: "*/10 * * * *" },
} as unknown as GlobalConfig;

const PROFILE = { name: "UP", avatar: "a", sign: "s", fans: 100, lastRefreshedAt: "x" };

function baseDeps(over: {
	subs: Array<{ id: string; uid: string; enabled: boolean }>;
	getRelationStat: ReturnType<typeof vi.fn>;
	rtGet?: ReturnType<typeof vi.fn>;
}) {
	const bus = createNodeMessageBus();
	return {
		bus,
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
		configStore: { getGlobals: () => GLOBALS, patchSubscription: vi.fn() } as never,
		subscriptionStore: { list: () => over.subs } as never,
		subRuntimeStore: {
			get: over.rtGet ?? vi.fn(() => ({ cachedProfile: { ...PROFILE } })),
			getAll: () => ({}),
			patch: vi.fn(async () => {}),
			prune: vi.fn(async () => {}),
			load: vi.fn(async () => {}),
		} as never,
		fansStore: {
			append: vi.fn(async () => {}),
			findNearestBefore: vi.fn(async () => null),
			findEarliest: vi.fn(async () => undefined),
			dropUid: vi.fn(async () => {}),
		} as never,
		api: {
			getRelationStat: over.getRelationStat,
			getUserCardInfo: vi.fn(async () => ({ code: 0, data: { card: { ...PROFILE, fans: 1 } } })),
			getUserCardsBatch: vi.fn(async () => ({ code: 0, data: {} })),
		} as never,
		serviceCtx: {
			setTimeout: vi.fn(() => undefined),
			setInterval: vi.fn(() => undefined),
		} as never,
	};
}

let handle: { dispose(): void } | undefined;

beforeEach(() => {
	cronMock.instances.length = 0;
	vi.restoreAllMocks();
});
afterEach(() => {
	handle?.dispose();
	handle = undefined;
});

describe("① fansCron 解耦", () => {
	it("cron 用 app.fansCron,而不是 dynamicCron", () => {
		handle = startFansPoller(
			baseDeps({ subs: [{ id: "s1", uid: "1", enabled: true }], getRelationStat: vi.fn() }),
		);
		expect(cronMock.instances).toHaveLength(1);
		expect(cronMock.instances[0]?.cronTime).toBe("*/10 * * * *");
	});
});

describe("② 风控熔断", () => {
	it("首个 UP 命中 -352 → 中止 sweep,后续 UP 不再请求;下一 tick 直接跳过", async () => {
		const getRelationStat = vi.fn(async (uid: string) =>
			uid === "1" ? { code: -352, data: null } : { code: 0, data: { follower: 5 } },
		);
		handle = startFansPoller(
			baseDeps({
				subs: [
					{ id: "s1", uid: "1", enabled: true },
					{ id: "s2", uid: "2", enabled: true },
				],
				getRelationStat,
			}),
		);

		cronMock.instances[0]?.onTick();
		// 首个 UP 打了一次(-352),sweep 立即中止 → 第二个 UP(uid=2)永不被请求。
		await vi.waitFor(() => expect(getRelationStat).toHaveBeenCalledTimes(1), {
			timeout: 2000,
			interval: 10,
		});
		expect(getRelationStat.mock.calls.every(([uid]) => uid === "1")).toBe(true);

		// 再驱动一次 tick:仍在退避窗口内 → 整轮跳过,不新增任何请求。
		cronMock.instances[0]?.onTick();
		await new Promise((r) => setTimeout(r, 50));
		expect(getRelationStat).toHaveBeenCalledTimes(1);
	});
});
