import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fakeProfileImages } from "../../__tests__/support/profile-images.js";
import { createNodeMessageBus } from "../message-bus.js";
import type { ProfileRefreshHandle } from "../profile-refresh.js";
import { startMigratedProfileRefresh } from "./profile-refresh-support.js";

/**
 * `pollNow`:把粉丝轮询提前到现在(devtools「现在就跑」)。走的就是 cron 到点调的那个
 * tick;上一轮还在跑就跳过(与 cron 撞上一样),回 false。
 */

// cron 换成不排程的假货(同 profile-refresh-track 等的套路)。真的 CronJob 按墙钟每 10 分钟整点放一轮 tick,
// 不归 serviceCtx 管:用例跨过整点时它会插进来多跑一轮。
const cronMock = vi.hoisted(() => ({
	instances: [] as Array<{ timezone?: string; stopped: boolean }>,
}));
vi.mock("cron", () => ({
	CronJob: class {
		stopped = false;
		constructor(
			_expression: string,
			_onTick: () => void,
			_onComplete?: unknown,
			_start?: boolean,
			public timezone?: string,
		) {
			cronMock.instances.push(this);
		}
		start(): void {}
		stop(): void {
			this.stopped = true;
		}
	},
}));

const startupTimers: number[] = [];

const GLOBALS = { profileRefreshCron: "*/10 * * * *", timezone: "UTC" };
const SUB = {
	id: "s1",
	identity: { sourceKey: "bilibili", externalId: "1" },
	enabled: true,
} as never;

let handle: ProfileRefreshHandle | undefined;
afterEach(() => {
	handle?.dispose();
	handle = undefined;
	GLOBALS.timezone = "UTC";
	cronMock.instances.length = 0;
	startupTimers.length = 0;
});

function start(fetchUserCard: ReturnType<typeof vi.fn>, bus = createNodeMessageBus()) {
	handle = startMigratedProfileRefresh({
		images: fakeProfileImages(),
		isStatsEnabled: () => true,
		bus,
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
		configStore: { getGlobals: () => GLOBALS, patchSubscription: vi.fn() } as never,
		subscriptionStore: { list: () => [SUB] } as never,
		subscriptionStateStore: {
			get: vi.fn(() => ({
				cachedProfile: { name: "甲", followers: 1, refreshedAt: "x" },
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
			fetchUserCard,
		} as never,
		// 不放行启动那次延时 tick:这里只看 pollNow 自己触发的那一轮。
		serviceCtx: {
			setTimeout: vi.fn((_fn: () => void, ms: number) => {
				startupTimers.push(ms);
				return undefined;
			}),
			setInterval: vi.fn(() => undefined),
			track: vi.fn(),
			signal: new AbortController().signal,
		} as never,
	});
	return handle;
}

describe("profile refresh pollNow", () => {
	it("立刻跑一轮:拉每个启用订阅的粉丝数,promise 在这一轮结束时落定", async () => {
		const fetchUserCard = vi.fn(async () => ({
			data: { card: { name: "甲", fans: 123 } },
		}));
		const h = start(fetchUserCard);
		expect(await h.pollNow()).toBe(true);
		expect(fetchUserCard).toHaveBeenCalledWith("1");
		expect(h.getLastEntries().map((e) => e.identity.externalId)).toEqual(["1"]);
	});

	it("上一轮还在跑就跳过,回 false", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const fetchUserCard = vi.fn(async () => {
			await gate;
			return { data: { card: { name: "甲", fans: 1 } } };
		});
		const h = start(fetchUserCard);
		const first = h.pollNow();
		await Promise.resolve();
		expect(await h.pollNow()).toBe(false);
		release();
		expect(await first).toBe(true);
		expect(fetchUserCard).toHaveBeenCalledTimes(1);
	});
});

it("re-arms only the cron job when timezone changes and disposes its listener", async () => {
	const bus = createNodeMessageBus();
	const fetch = vi.fn();
	const h = start(fetch, bus);
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(startupTimers).toEqual([3000]);
	expect(cronMock.instances.map((job) => job.timezone)).toEqual(["UTC"]);
	bus.emit("config-changed", { scope: "globals" });
	expect(cronMock.instances).toHaveLength(1);
	GLOBALS.timezone = "Asia/Kathmandu";
	bus.emit("config-changed", { scope: "globals" });
	expect(cronMock.instances.map((job) => [job.timezone, job.stopped])).toEqual([
		["UTC", true],
		["Asia/Kathmandu", false],
	]);
	expect(fetch).not.toHaveBeenCalled();
	expect(startupTimers).toEqual([3000]);
	h.dispose();
	GLOBALS.timezone = "UTC";
	bus.emit("config-changed", { scope: "globals" });
	expect(cronMock.instances).toHaveLength(2);
	expect(cronMock.instances.every((job) => job.stopped)).toBe(true);
});
