/**
 * ① profileRefreshCron 解耦 + ② 风控熔断。
 *
 * ①:FansPoller 的 cron 取 `globals.profileRefreshCron`(不再复用 dynamicCron)。
 * ②:稳态用 fetchRelationStat 取 follower;某个 UP 命中风控码(-352 等)时立即
 *    **中止本轮 sweep**(不继续刷后面的 UP)并退避,下一 tick 直接跳过 —— 对齐
 *    动态引擎「被限流就别继续敲」的机制。
 */

import { type GlobalConfig, ok } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { fakeProfileImages } from "../../__tests__/support/profile-images.js";

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
	profileRefreshCron: "*/10 * * * *",
} as unknown as GlobalConfig;

const PROFILE = { name: "UP", avatarUrl: "a", sign: "s", fans: 100, lastRefreshedAt: "x" };

function baseDeps(over: {
	subs: Array<{
		id: string;
		identity: { sourceKey: string; externalId: string };
		enabled: boolean;
	}>;
	fetchRelationStat: ReturnType<typeof vi.fn>;
	rtGet?: ReturnType<typeof vi.fn>;
}) {
	const bus = createNodeMessageBus();
	return {
		bus,
		images: fakeProfileImages(),
		isStatsEnabled: () => true,
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
			drop: vi.fn(async () => {}),
		} as never,
		api: {
			fetchRelationStat: over.fetchRelationStat,
			fetchUserCard: vi.fn(async () => ok({ data: { card: { ...PROFILE, fans: 1 } } })),
			fetchUserCards: vi.fn(async () => ({ code: 0, data: {} })),
		} as never,
		serviceCtx: {
			setTimeout: vi.fn(() => undefined),
			setInterval: vi.fn(() => undefined),
			track: vi.fn(),
			signal: new AbortController().signal,
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

describe("① profileRefreshCron 解耦", () => {
	it("cron 用 profileRefreshCron(动态轮询那条在 B 站自己的设置里,粉丝轮询不碰)", () => {
		handle = startFansPoller(
			baseDeps({
				subs: [{ id: "s1", identity: { sourceKey: "bilibili", externalId: "1" }, enabled: true }],
				fetchRelationStat: vi.fn(),
			}),
		);
		expect(cronMock.instances).toHaveLength(1);
		expect(cronMock.instances[0]?.cronTime).toBe("*/10 * * * *");
	});
});

describe("② 风控熔断", () => {
	it("首个 UP 命中 -352 → 中止 sweep,后续 UP 不再请求;下一 tick 直接跳过", async () => {
		const fetchRelationStat = vi.fn(async (uid: string) =>
			uid === "1" ? { code: -352, data: null } : { code: 0, data: { follower: 5 } },
		);
		handle = startFansPoller(
			baseDeps({
				subs: [
					{ id: "s1", identity: { sourceKey: "bilibili", externalId: "1" }, enabled: true },
					{ id: "s2", identity: { sourceKey: "bilibili", externalId: "2" }, enabled: true },
				],
				fetchRelationStat,
			}),
		);

		cronMock.instances[0]?.onTick();
		// 首个 UP 打了一次(-352),sweep 立即中止 → 第二个 UP(uid=2)永不被请求。
		await vi.waitFor(() => expect(fetchRelationStat).toHaveBeenCalledTimes(1), {
			timeout: 2000,
			interval: 10,
		});
		expect(fetchRelationStat.mock.calls.every(([uid]) => uid === "1")).toBe(true);

		// 再驱动一次 tick:仍在退避窗口内 → 整轮跳过,不新增任何请求。
		cronMock.instances[0]?.onTick();
		await new Promise((r) => setTimeout(r, 50));
		expect(fetchRelationStat).toHaveBeenCalledTimes(1);
	});
});
