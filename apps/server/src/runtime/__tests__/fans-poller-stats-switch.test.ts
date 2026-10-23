/**
 * **统计总开关 × 粉丝轮询**(ADR-0027 决策 9;㉙a)。
 *
 * B 站粉丝轮询直接往粉丝仓 `append`、绕开记录器,所以总开关要在这里单独拦。关着时:
 *   - 不写粉丝样本;
 *   - **照跑**:当前粉丝数写进资料缓存(订阅卡上的数)、`followers-refreshed` 照发、行里的当前数照给;
 *   - 「订阅以来涨了多少」照读时序第一条;时序还没有样本时为 `null`;
 *   - 「24 小时 / 7 天涨跌」是 `null`(靠时序的范围查询)。
 * 开关现取、不重启:同一个 poller 下一轮 tick 就按新值办。
 *
 * 对照用例是开着时同样的一轮 —— 只断言「没写」会在什么都没跑时空绿。
 */

import { type FollowersRefreshEntry, ok } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { fakeProfileImages } from "../../__tests__/support/profile-images.js";
import type { SubRuntime } from "../sub-runtime-store.js";

const cronMock = vi.hoisted(() => {
	const instances: Array<{ onTick: () => void }> = [];
	class FakeCronJob {
		constructor(
			public cronTime: string,
			public onTick: () => void,
		) {
			instances.push(this);
		}
		start(): void {}
		stop(): void {}
	}
	return { instances, FakeCronJob };
});
vi.mock("cron", () => ({ CronJob: cronMock.FakeCronJob }));

const { startFansPoller } = await import("../fans-poller.js");
const { createNodeMessageBus } = await import("../message-bus.js");

const GLOBALS = { profileRefreshCron: "*/10 * * * *" } as never;
const BILI_SUB = {
	id: "sub-1",
	identity: { sourceKey: "bilibili", externalId: "12345" },
	enabled: true,
};
const HOUR = 3_600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

let handle: { dispose(): void } | undefined;
let enabled: boolean;

beforeEach(() => {
	cronMock.instances.length = 0;
	enabled = true;
});
afterEach(() => {
	handle?.dispose();
	handle = undefined;
});

interface Setup {
	runtime: Map<string, SubRuntime>;
	rtPatch: ReturnType<typeof vi.fn>;
	append: ReturnType<typeof vi.fn>;
	findNearestBefore: ReturnType<typeof vi.fn>;
	findEarliest: ReturnType<typeof vi.fn>;
	snapshots: FollowersRefreshEntry[][];
	poll(): Promise<void>;
	entries(): FollowersRefreshEntry[];
}

async function start(
	over: {
		subs?: unknown[];
		runtime?: Record<string, SubRuntime>;
		nearest?: (key: string, beforeIso: string) => { sampledAt: string; followers: number } | null;
		earliest?: { sampledAt: string; followers: number } | undefined;
		fans?: number;
	} = {},
): Promise<Setup> {
	const runtime = new Map<string, SubRuntime>(Object.entries(over.runtime ?? {}));
	const bus = createNodeMessageBus();
	const snapshots: FollowersRefreshEntry[][] = [];
	bus.on("followers-refreshed", ({ entries }) => {
		snapshots.push(entries);
	});
	const rtPatch = vi.fn(async (id: string, patch: SubRuntime) => {
		runtime.set(id, { ...runtime.get(id), ...patch });
	});
	const append = vi.fn(async () => {});
	const findNearestBefore = vi.fn(async (key: string, beforeIso: string) =>
		over.nearest ? over.nearest(key, beforeIso) : null,
	);
	const findEarliest = vi.fn(async () => over.earliest);
	const fans = over.fans ?? 4242;
	const setTimeoutSpy = vi.fn(() => undefined);
	const poller = startFansPoller({
		images: fakeProfileImages(),
		bus,
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
		configStore: { getGlobals: () => GLOBALS, patchSubscription: vi.fn() } as never,
		subscriptionStore: { list: () => over.subs ?? [BILI_SUB] } as never,
		subRuntimeStore: {
			get: (id: string) => runtime.get(id),
			getAll: () => Object.fromEntries(runtime),
			patch: rtPatch,
			prune: vi.fn(async () => {}),
			load: vi.fn(async () => {}),
		} as never,
		fansStore: { append, findNearestBefore, findEarliest, drop: vi.fn(async () => {}) } as never,
		api: {
			fetchUserCard: vi.fn(async () =>
				ok({
					data: { card: { name: "UP", face: "f", sign: "s", fans } },
				}),
			),
			fetchRelationStat: vi.fn(async () => ({ code: 0, data: { follower: fans } })),
			fetchUserCards: vi.fn(async () => ({ code: 0, data: {} })),
		} as never,
		serviceCtx: {
			// 不放行启动那次 3s 延时 tick:只看各用例自己 pollNow 的那几轮。
			setTimeout: setTimeoutSpy,
			setInterval: vi.fn(() => undefined),
			track: vi.fn(),
			signal: new AbortController().signal,
		} as never,
		isStatsEnabled: () => enabled,
	});
	handle = poller;
	// 启动恢复跑完才会去排那个 3s 延时 —— 等它被排上,恢复的读就不会和用例的 tick 交错。
	await vi.waitFor(() => expect(setTimeoutSpy).toHaveBeenCalled());
	return {
		runtime,
		rtPatch,
		append,
		findNearestBefore,
		findEarliest,
		snapshots,
		poll: async () => {
			await poller.pollNow();
		},
		entries: () => poller.getLastEntries(),
	};
}

describe("粉丝轮询 × 总开关(B 站)", () => {
	it("对照:开着时写样本、涨跌与订阅以来按时序算", async () => {
		const p = await start({
			earliest: { sampledAt: iso(0), followers: 4242 },
			nearest: (_key, beforeIso) => {
				// 24h 之前、7d 之前各有一条样本。
				return { sampledAt: beforeIso, followers: beforeIso < iso(2 * 24 * HOUR) ? 3000 : 4000 };
			},
		});
		await p.poll();
		expect(p.append).toHaveBeenCalledTimes(1);
		expect(p.entries()[0]).toMatchObject({
			current: 4242,
			deltaSubscribed: 0,
			delta24h: 242,
			delta7d: 1242,
		});
	});

	it("关着:不写样本、不新建起点;当前数照写进资料缓存、followers-refreshed 照发、涨跌两格与订阅以来都是 null", async () => {
		enabled = false;
		const p = await start();
		// 开机从盘上恢复首屏那一次读不算:只看这一轮 tick 有没有去翻时序。
		const readsAtBoot = p.findNearestBefore.mock.calls.length;
		await p.poll();

		expect(p.append).not.toHaveBeenCalled();
		// 涨跌不去翻时序。
		expect(p.findNearestBefore).toHaveBeenCalledTimes(readsAtBoot);
		// 资料缓存照写(订阅卡上的当前粉丝数),但不带起点。
		expect(p.rtPatch).toHaveBeenCalledTimes(1);
		const patch = p.rtPatch.mock.calls[0]?.[1] as SubRuntime;
		expect(patch.cachedProfile).toMatchObject({ fans: 4242 });
		expect(Object.keys(patch)).toEqual(["cachedProfile"]);
		// 事件照发、当前数照给,涨跌给空。
		expect(p.snapshots.at(-1)).toEqual([
			{
				subscriptionId: "sub-1",
				identity: { sourceKey: "bilibili", externalId: "12345" },
				current: 4242,
				refreshedAt: expect.any(String),
				deltaSubscribed: null,
				delta24h: null,
				delta7d: null,
			},
		]);
	});

	it("关着、时序第一条早就存着:「订阅以来」照给,24h / 7d 给空", async () => {
		enabled = false;
		const p = await start({
			runtime: {
				"sub-1": {
					cachedProfile: { name: "旧名", sign: "", fans: 100, lastRefreshedAt: iso(HOUR) },
				},
			},
			earliest: { sampledAt: "2026-04-01T00:00:00.000Z", followers: 4000 },
		});
		await p.poll();
		const patch = p.rtPatch.mock.calls[0]?.[1] as SubRuntime;
		expect(Object.keys(patch)).toEqual(["cachedProfile"]);
		expect(p.entries()[0]).toMatchObject({
			current: 4242,
			deltaSubscribed: 242,
			delta24h: null,
			delta7d: null,
		});
	});

	it("热更新:同一个 poller,开着一轮写、关着一轮不写、再开着一轮又写 —— 不重启", async () => {
		const p = await start();
		await p.poll();
		expect(p.append).toHaveBeenCalledTimes(1);
		enabled = false;
		await p.poll();
		expect(p.append).toHaveBeenCalledTimes(1);
		enabled = true;
		await p.poll();
		expect(p.append).toHaveBeenCalledTimes(2);
	});
});

describe("粉丝轮询 × 总开关(拓展订阅那一行)", () => {
	const EXT = makeExtensionSubscription({
		id: "e1",
		extensionId: "douyin",
		externalId: "sec-1",
		enabled: true,
	});
	const extRuntime = (fans: number): Record<string, SubRuntime> => ({
		e1: { cachedProfile: { name: "抖音甲", sign: "", fans, lastRefreshedAt: iso(HOUR) } },
	});
	const series = (key: string, beforeIso: string) =>
		key === "e1" ? { sampledAt: beforeIso, followers: 300 } : null;

	it("对照:开着时拓展那一行按时序算涨跌", async () => {
		const p = await start({
			subs: [EXT],
			runtime: extRuntime(450),
			nearest: series,
			earliest: { sampledAt: iso(10 * 24 * HOUR), followers: 100 },
		});
		await p.poll();
		expect(p.entries()[0]).toMatchObject({
			subscriptionId: "e1",
			current: 450,
			deltaSubscribed: 350,
			delta24h: 150,
			delta7d: 150,
		});
	});

	it("关着:当前数照给(取最近报的资料),订阅以来照给,24h / 7d 给空", async () => {
		enabled = false;
		const p = await start({
			subs: [EXT],
			runtime: extRuntime(450),
			nearest: series,
			earliest: { sampledAt: iso(10 * 24 * HOUR), followers: 100 },
		});
		await p.poll();
		expect(p.entries()[0]).toMatchObject({
			subscriptionId: "e1",
			current: 450,
			deltaSubscribed: 350,
			delta24h: null,
			delta7d: null,
		});
	});

	it("关着:两种来源的「订阅以来」都照给,24h / 7d 都空", async () => {
		enabled = false;
		const p = await start({
			subs: [BILI_SUB, EXT],
			runtime: {
				"sub-1": {
					cachedProfile: { name: "B 站甲", sign: "", fans: 100, lastRefreshedAt: iso(HOUR) },
				},
				...extRuntime(450),
			},
			earliest: { sampledAt: iso(10 * 24 * HOUR), followers: 100 },
		});
		await p.poll();
		expect(p.entries()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					subscriptionId: "sub-1",
					current: 4242,
					deltaSubscribed: 4142,
					delta24h: null,
					delta7d: null,
				}),
				expect.objectContaining({
					subscriptionId: "e1",
					current: 450,
					deltaSubscribed: 350,
					delta24h: null,
					delta7d: null,
				}),
			]),
		);
	});

	it("关着、盘上还没有时序:只要资料报了粉丝数,这一行照样在(与 B 站那一支对称)", async () => {
		enabled = false;
		const p = await start({ subs: [EXT], runtime: extRuntime(450) });
		await p.poll();
		expect(p.entries()[0]).toMatchObject({ subscriptionId: "e1", current: 450 });
	});
});
