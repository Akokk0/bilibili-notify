/**
 * 清掉数据统计之后,**两种订阅的「订阅以来涨了多少」都从下一次采样重新算**(㉙d,ADR-0027 决策 17)。
 *
 * 真的粉丝轮询 + 真的粉丝仓 + 真的订阅运行态(都在自己建的临时目录里),接上存储占用的 `clear("stats")`:
 * - 两种订阅的起点都是粉丝时序的第一条样本;时序一清,下一条样本就是新起点;
 * - 清完轮询手里的快照里「订阅 / 24 小时 / 7 天」涨跌立刻置空(当前粉丝数留着),并发出一次 `followers-refreshed`。
 * 「不清」那一支先跑一遍当对照,证明时序确实是被清掉的而不是本来就没有。
 */

import type { FollowersRefreshEntry } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { fakeProfileImages } from "../../__tests__/support/profile-images.js";
import { makeStorageWorld, type StorageWorld } from "../../__tests__/support/storage-world.js";
import { createNodeMessageBus } from "../message-bus.js";
import type { ProfileRefreshHandle } from "../profile-refresh.js";
import { createStorageUsage } from "../storage-usage.js";
import { startMigratedProfileRefresh } from "./profile-refresh-support.js";

// cron 换成不排程的假货(同 profile-refresh-track 等的套路)。真的 CronJob 按墙钟每 10 分钟整点放一轮 tick,
// 不归 serviceCtx 管:用例恰好跨过整点时,清完之后那一轮会把当时的粉丝数写成新起点,「起点没了」就偶发红。
vi.mock("cron", () => ({
	CronJob: class {
		start(): void {}
		stop(): void {}
	},
}));

const GLOBALS = { profileRefreshCron: "*/10 * * * *" } as never;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

const BILI = {
	id: "b1",
	identity: { sourceKey: "bilibili", externalId: "1" },
	enabled: true,
} as const;
const EXT = makeExtensionSubscription({ id: "e1", externalId: "x", enabled: true });

let world: StorageWorld;
let handle: ProfileRefreshHandle | undefined;
let follower: number;
let snapshots: FollowersRefreshEntry[][];

beforeEach(async () => {
	world = await makeStorageWorld();
	follower = 130;
	snapshots = [];
});
afterEach(async () => {
	handle?.dispose();
	handle = undefined;
	await world.dispose();
});

async function start() {
	const bus = createNodeMessageBus();
	bus.on("followers-refreshed", ({ entries }) => snapshots.push(entries));
	// B 站订阅:两天前一个样本;拓展订阅:十天前开始记,资料里报 80。
	await world.subscriptionStateStore.patch("b1", {
		cachedProfile: { name: "甲", followers: 110, refreshedAt: iso(HOUR) },
	});
	await world.subscriptionStateStore.patch("e1", {
		cachedProfile: { name: "乙", followers: 80, refreshedAt: iso(HOUR) },
	});
	await world.fansStore.append("b1", { sampledAt: iso(2 * DAY), followers: 100 });
	await world.fansStore.append("e1", { sampledAt: iso(10 * DAY), followers: 50 });
	await world.fansStore.append("e1", { sampledAt: iso(HOUR), followers: 80 });
	handle = startMigratedProfileRefresh({
		images: fakeProfileImages(),
		isStatsEnabled: () => true,
		bus,
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
		configStore: { getGlobals: () => GLOBALS } as never,
		subscriptionStore: { list: () => [BILI, EXT] } as never,
		subscriptionStateStore: world.subscriptionStateStore,
		fansStore: world.fansStore,
		api: {
			fetchUserCard: vi.fn(async () => ({
				data: { card: { name: "UP", face: "", sign: "", fans: follower } },
			})),
		} as never,
		// 不放行启动那次延时 tick(cron 也不到点,见文件顶上的 mock):只看各用例自己触发的那一轮。
		serviceCtx: {
			setTimeout: vi.fn(() => undefined),
			setInterval: vi.fn(() => undefined),
			track: vi.fn(),
			signal: new AbortController().signal,
		} as never,
	});
	const storage = createStorageUsage({ ...world.options, profileRefresh: () => handle ?? null });
	return { storage, poller: handle };
}

const byId = (entries: FollowersRefreshEntry[], id: string) =>
	entries.find((e) => e.subscriptionId === id);

describe("清数据统计 × 粉丝轮询的快照与涨粉起点", () => {
	it("对照:不清,两种订阅都有「订阅以来」的涨幅", async () => {
		const { poller } = await start();
		await poller.pollNow();
		const entries = poller.getLastEntries();
		expect(byId(entries, "b1")?.deltaSubscribed).toBe(30); // 130 − 起点 100
		expect(byId(entries, "e1")?.deltaSubscribed).toBe(30); // 80 − 时序第一条 50
	});

	it("清完:快照里的涨跌置空、当前数留着、发了一次新快照;时序没了", async () => {
		const { storage, poller } = await start();
		await poller.pollNow();
		const emittedBefore = snapshots.length;

		await storage.clear("stats");

		const entries = poller.getLastEntries();
		const b = byId(entries, "b1");
		expect(b).toMatchObject({ current: 130, deltaSubscribed: null, delta24h: null, delta7d: null });
		// 拓展订阅:时序清空了,面板上那一行跟着没了(与「没有时序不上面板」同一个规矩)。
		expect(byId(entries, "e1")).toBeUndefined();
		expect(snapshots.length).toBe(emittedBefore + 1);
	});

	it("清完的下一次采样:两种来源都从新的第一条样本算「订阅以来」", async () => {
		const { storage, poller } = await start();
		await poller.pollNow();
		await storage.clear("stats");

		follower = 140;
		// 拓展订阅清空后第一次报粉丝:资料里 90,时序里记下第一条 90。
		await world.subscriptionStateStore.patch("e1", {
			cachedProfile: { name: "乙", followers: 90, refreshedAt: iso(0) },
		});
		await world.fansStore.append("e1", { sampledAt: iso(0), followers: 90 });
		await poller.pollNow();

		const entries = poller.getLastEntries();
		expect(byId(entries, "b1")?.deltaSubscribed).toBe(0); // 新起点 = 这一次的 140
		expect(byId(entries, "b1")?.current).toBe(140);
		expect(byId(entries, "e1")?.deltaSubscribed).toBe(0); // 新的第一条样本 90
		// 再涨一点,从新起点量。
		follower = 150;
		await poller.pollNow();
		expect(byId(poller.getLastEntries(), "b1")?.deltaSubscribed).toBe(10);
	});
});
