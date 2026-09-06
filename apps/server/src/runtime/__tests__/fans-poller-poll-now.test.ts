import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { type FansPollerHandle, startFansPoller } from "../fans-poller.js";
import { createNodeMessageBus } from "../message-bus.js";

/**
 * `pollNow`:把粉丝轮询提前到现在(devtools「现在就跑」)。走的就是 cron 到点调的那个
 * tick;上一轮还在跑就跳过(与 cron 撞上一样),回 false。
 */

const GLOBALS = { app: { fansCron: "*/10 * * * *" } } as never;
const SUB = { id: "s1", uid: "1", enabled: true } as never;

let handle: FansPollerHandle | undefined;
afterEach(() => {
	handle?.dispose();
	handle = undefined;
});

function start(getRelationStat: ReturnType<typeof vi.fn>) {
	handle = startFansPoller({
		bus: createNodeMessageBus(),
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
		configStore: { getGlobals: () => GLOBALS, patchSubscription: vi.fn() } as never,
		subscriptionStore: { list: () => [SUB] } as never,
		subRuntimeStore: {
			get: vi.fn(() => ({
				cachedProfile: { name: "甲", avatar: "a", fans: 1, lastRefreshedAt: "x" },
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
			dropUid: vi.fn(async () => {}),
		} as never,
		api: {
			getUserCardsBatch: vi.fn(async () => ({ code: 0, data: {} })),
			getRelationStat,
			getUserCardInfo: vi.fn(),
		} as never,
		// 不放行启动那次延时 tick:这里只看 pollNow 自己触发的那一轮。
		serviceCtx: {
			setTimeout: vi.fn(() => undefined),
			setInterval: vi.fn(() => undefined),
		} as never,
	});
	return handle;
}

describe("fans poller pollNow", () => {
	it("立刻跑一轮:拉每个启用订阅的粉丝数,promise 在这一轮结束时落定", async () => {
		const getRelationStat = vi.fn(async () => ({ code: 0, data: { follower: 123 } }));
		const h = start(getRelationStat);
		expect(await h.pollNow()).toBe(true);
		expect(getRelationStat).toHaveBeenCalledWith("1");
		expect(h.getLastEntries().map((e) => e.uid)).toEqual(["1"]);
	});

	it("上一轮还在跑就跳过,回 false", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const getRelationStat = vi.fn(async () => {
			await gate;
			return { code: 0, data: { follower: 1 } };
		});
		const h = start(getRelationStat);
		const first = h.pollNow();
		await Promise.resolve();
		expect(await h.pollNow()).toBe(false);
		release();
		expect(await first).toBe(true);
		expect(getRelationStat).toHaveBeenCalledTimes(1);
	});
});
