import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fakeProfileImages } from "../../__tests__/support/profile-images.js";
import { type FansPollerHandle, startFansPoller } from "../fans-poller.js";
import { createNodeMessageBus } from "../message-bus.js";

/**
 * `pollNow`:把粉丝轮询提前到现在(devtools「现在就跑」)。走的就是 cron 到点调的那个
 * tick;上一轮还在跑就跳过(与 cron 撞上一样),回 false。
 */

// cron 换成不排程的假货(同 fans-poller-track 等的套路)。真的 CronJob 按墙钟每 10 分钟整点放一轮 tick,
// 不归 serviceCtx 管:用例跨过整点时它会插进来多跑一轮。
vi.mock("cron", () => ({
	CronJob: class {
		start(): void {}
		stop(): void {}
	},
}));

const GLOBALS = { profileRefreshCron: "*/10 * * * *" } as never;
const SUB = {
	id: "s1",
	identity: { sourceKey: "bilibili", externalId: "1" },
	enabled: true,
} as never;

let handle: FansPollerHandle | undefined;
afterEach(() => {
	handle?.dispose();
	handle = undefined;
});

function start(fetchRelationStat: ReturnType<typeof vi.fn>) {
	handle = startFansPoller({
		images: fakeProfileImages(),
		isStatsEnabled: () => true,
		bus: createNodeMessageBus(),
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
		configStore: { getGlobals: () => GLOBALS, patchSubscription: vi.fn() } as never,
		subscriptionStore: { list: () => [SUB] } as never,
		subRuntimeStore: {
			get: vi.fn(() => ({
				cachedProfile: { name: "甲", fans: 1, lastRefreshedAt: "x" },
			})),
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
			fetchUserCards: vi.fn(async () => ({ code: 0, data: {} })),
			fetchRelationStat,
			fetchUserCard: vi.fn(),
		} as never,
		// 不放行启动那次延时 tick:这里只看 pollNow 自己触发的那一轮。
		serviceCtx: {
			setTimeout: vi.fn(() => undefined),
			setInterval: vi.fn(() => undefined),
			track: vi.fn(),
			signal: new AbortController().signal,
		} as never,
	});
	return handle;
}

describe("fans poller pollNow", () => {
	it("立刻跑一轮:拉每个启用订阅的粉丝数,promise 在这一轮结束时落定", async () => {
		const fetchRelationStat = vi.fn(async () => ({ code: 0, data: { follower: 123 } }));
		const h = start(fetchRelationStat);
		expect(await h.pollNow()).toBe(true);
		expect(fetchRelationStat).toHaveBeenCalledWith("1");
		expect(h.getLastEntries().map((e) => e.uid)).toEqual(["1"]);
	});

	it("上一轮还在跑就跳过,回 false", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const fetchRelationStat = vi.fn(async () => {
			await gate;
			return { code: 0, data: { follower: 1 } };
		});
		const h = start(fetchRelationStat);
		const first = h.pollNow();
		await Promise.resolve();
		expect(await h.pollNow()).toBe(false);
		release();
		expect(await first).toBe(true);
		expect(fetchRelationStat).toHaveBeenCalledTimes(1);
	});
});
