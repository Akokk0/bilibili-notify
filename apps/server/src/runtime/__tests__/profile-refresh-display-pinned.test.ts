/**
 * 首页粉丝面板的现状钉子(㉘a):`GET /api/stats/followers` 与 `followers-refreshed` 里每条的
 * `current / deltaSubscribed / delta24h / delta7d`,B 站订阅与拓展订阅各验,以及「涨粉起点」取哪一条、起点不被后来的样本改掉。
 *
 * ㉘c 要压缩粉丝样本文件、改行的形状;「采集与显示都不变」由这份测试裁判 —— 之后只许改 {@link sampleRow}
 * (夹具行的形状)与 {@link seedSeries} 里写盘的那一处,期望一个都不许动。从外面钉:粉丝仓是真的(tmpdir),
 * 看的是轮询器吐出来的条目与路由返回的 JSON,不看盘上的行长什么样、不看内部怎么调。
 *
 * 取数口径(现状):24h / 7d = 「那一刻**之前**最近的一条样本」(`ts <= now − 24h / 7d`,之后的不算);
 * 那之前没有样本 → `null`。两种来源的起点都取盘上第一条样本。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FollowersRefreshEntry, ok, type Subscription } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { fakeProfileImages } from "../../__tests__/support/profile-images.js";
import { createFollowersStore, FOLLOWERS_DIR } from "../../followers/store.js";
import { createStatsFollowersRoute } from "../../routes/stats-followers.js";
import type { RouteDeps } from "../../routes/types.js";
import { createNodeMessageBus } from "../message-bus.js";
import type { ProfileRefreshHandle } from "../profile-refresh.js";
import type { SubscriptionState } from "../subscription-state-store.js";
import { startMigratedProfileRefresh } from "./profile-refresh-support.js";

// cron 换成不排程的假货(同 profile-refresh-track 等的套路)。真的 CronJob 按墙钟每 10 分钟整点放一轮 tick,
// 不归 serviceCtx 管:用例跨过整点时它会插进来多跑一轮。
vi.mock("cron", () => ({
	CronJob: class {
		start(): void {}
		stop(): void {}
	},
}));

const GLOBALS = { profileRefreshCron: "*/10 * * * *" } as never;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let dataDir: string;
let handle: ProfileRefreshHandle | undefined;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-fans-display-"));
});
afterEach(async () => {
	handle?.dispose();
	handle = undefined;
	await rm(dataDir, { recursive: true, force: true });
});

const ago = (ms: number) => Date.now() - ms;
const isoAgo = (ms: number) => new Date(ago(ms)).toISOString();

/** ㉘c 只改这一个帮手:一条粉丝样本在盘上的行。 */
function sampleRow(atMs: number, value: number): { sampledAt: string; followers: number } {
	return { sampledAt: new Date(atMs).toISOString(), followers: value };
}

type Sample = [atMs: number, value: number];

/** 把一份样本序列(时间升序)写成这条订阅的粉丝文件。 */
async function seedSeries(key: string, samples: Sample[]): Promise<void> {
	await mkdir(join(dataDir, ...FOLLOWERS_DIR), { recursive: true });
	await writeFile(
		join(dataDir, ...FOLLOWERS_DIR, `${key}.jsonl`),
		samples.map(([ms, v]) => `${JSON.stringify(sampleRow(ms, v))}\n`).join(""),
	);
}

const biliSub = (id: string, uid: string): Subscription =>
	({ id, identity: { sourceKey: "bilibili", externalId: uid }, enabled: true }) as never;
const extSub = (id: string, externalId: string): Subscription =>
	makeExtensionSubscription({ id, extensionId: "douyin", externalId, enabled: true });

const profile = (followers?: number, refreshedAt = isoAgo(5 * 60_000)): SubscriptionState => ({
	cachedProfile: { name: "x", ...(followers === undefined ? {} : { followers }), refreshedAt },
});

async function start(subs: Subscription[], seed: Record<string, SubscriptionState>) {
	const runtime = new Map<string, SubscriptionState>(Object.entries(seed));
	const bus = createNodeMessageBus();
	const snapshots: FollowersRefreshEntry[][] = [];
	bus.on("followers-refreshed", ({ entries }) => {
		snapshots.push(entries);
	});
	/** 每个 uid 这一轮 B 站报的粉丝数,用例里随时改。 */
	const follower: Record<string, number> = {};
	const serviceCtx = {
		setTimeout: vi.fn(() => undefined),
		setInterval: vi.fn(() => undefined),
		track: vi.fn(),
		signal: new AbortController().signal,
	};
	const patch = vi.fn(async (id: string, p: SubscriptionState) => {
		runtime.set(id, { ...runtime.get(id), ...p });
	});
	handle = startMigratedProfileRefresh({
		images: fakeProfileImages(),
		isStatsEnabled: () => true,
		bus,
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
		configStore: { getGlobals: () => GLOBALS, patchSubscription: vi.fn() } as never,
		subscriptionStore: { list: () => subs } as never,
		subscriptionStateStore: {
			get: (id: string) => runtime.get(id),
			getAll: () => Object.fromEntries(runtime),
			patch,
			prune: vi.fn(async () => {}),
			load: vi.fn(async () => {}),
		} as never,
		fansStore: createFollowersStore({
			dataRoot: dataDir,
			logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
		}),
		api: {
			fetchUserCard: vi.fn(async (uid: string) =>
				ok({
					data: { card: { fans: follower[uid], name: `UP${uid}`, face: "", sign: "" } },
				}),
			),
		} as never,
		serviceCtx: serviceCtx as never,
	});
	// 开机恢复跑完才会排那个 3s 延时的首 tick —— 等它被排上,恢复就不会和用例的 tick 交错。
	await vi.waitFor(() => expect(serviceCtx.setTimeout).toHaveBeenCalled());
	const poller = handle as ProfileRefreshHandle;
	return {
		bus,
		runtime,
		snapshots,
		follower,
		handle: poller,
		entries: () =>
			[...poller.getLastEntries()].sort((a, b) => a.subscriptionId.localeCompare(b.subscriptionId)),
	};
}

async function getFollowers(h: ProfileRefreshHandle | undefined) {
	const app = createStatsFollowersRoute({ runtime: { profileRefresh: h } } as unknown as RouteDeps);
	const res = await app.request("/");
	expect(res.status).toBe(200);
	return (await res.json()) as { entries: FollowersRefreshEntry[] };
}

/** B 站那条:30 天的样本(远过 8 天),24h / 7d 的基准点两侧各放一条,用来看「取那一刻之前最近的一条」。 */
const BILI_LONG: Sample[] = [
	[ago(20 * DAY), 1000],
	[ago(10 * DAY), 1100],
	[ago(7 * DAY + 2 * HOUR), 1200], // 7 天前之前最近的一条 → 7d 基准
	[ago(7 * DAY - 2 * HOUR), 1250], // 7 天前之后 → 不算
	[ago(24 * HOUR + 3 * HOUR), 1300], // 24 小时前之前最近的一条 → 24h 基准
	[ago(24 * HOUR - 3 * HOUR), 1320], // 24 小时前之后 → 不算
	[ago(HOUR), 1330],
];

describe("首页粉丝面板 × B 站订阅:一轮轮询后的各格", () => {
	// 验红:把轮询器里 24h 基准点的目标从「24 小时前」改成「18 小时前」(基准往后挪),24h 格从 50 变 30(基准取到 1320),本条与 /followers 那条红。
	it("当前 = 这一轮拉到的数;起点 = 粉丝时序第一条;24h / 7d = 那一刻之前最近的样本", async () => {
		await seedSeries("b1", BILI_LONG);
		const p = await start([biliSub("b1", "111")], {
			// 盘上残留的旧起点与第一条样本不同,不再读它。
			b1: {
				...profile(1330),
				fansBaseline: { value: 900, ts: isoAgo(21 * DAY) },
			} as SubscriptionState,
		});
		p.follower["111"] = 1350;
		expect(await p.handle.pollNow()).toBe(true);

		expect(p.entries()).toEqual([
			{
				subscriptionId: "b1",
				identity: { sourceKey: "bilibili", externalId: "111" },
				current: 1350,
				refreshedAt: expect.any(String),
				deltaSubscribed: 350, // 1350 − 时序第一条 1000,不是旧起点 900
				delta24h: 50, // 1350 − 1300(不是之后的 1320)
				delta7d: 150, // 1350 − 1200(不是之后的 1250)
			},
		]);
		// 这一轮的采样时刻就是「现在」。
		expect(Math.abs(Date.parse(p.entries()[0]?.refreshedAt as string) - Date.now())).toBeLessThan(
			5_000,
		);
		// 接口返回与事件快照是同一份(`followers-refreshed` 里各条目的数)。
		expect((await getFollowers(p.handle)).entries).toEqual(p.entries());
		expect(p.snapshots.at(-1)).toEqual(p.entries());
	});

	// 验红:把 `delta7d = near7d ? … : null` 改成 `near7d ? … : 0`,没有 7 天前样本的那条变 0,红。
	it("24h / 7d 之前还没有样本 → 那一格是 null(不是 0);起点取时序第一条", async () => {
		await seedSeries("b3", [[ago(30 * HOUR), 700]]); // 只有 24h 之前这一条
		await seedSeries("b2", [[ago(3 * HOUR), 500]]); // 24h 之内才有第一条
		const p = await start([biliSub("b3", "333"), biliSub("b2", "222")], {
			b3: profile(700),
			b2: profile(500),
		});
		p.follower["333"] = 730;
		p.follower["222"] = 520;
		await p.handle.pollNow();

		const by = new Map(p.entries().map((e) => [e.subscriptionId, e]));
		expect(by.get("b3")).toMatchObject({
			current: 730,
			deltaSubscribed: 30,
			delta24h: 30,
			delta7d: null,
		});
		expect(by.get("b2")).toMatchObject({
			current: 520,
			deltaSubscribed: 20,
			delta24h: null,
			delta7d: null,
		});
	});
});

describe("涨粉起点:订阅以来涨了多少取哪一条当起点", () => {
	// 验红:把时序第一条改成取最近一条,deltaSubscribed 会变小,本条红。
	it("B 站:起点 = 盘上第一条样本;后来的样本不改它", async () => {
		await seedSeries("b2", [[ago(3 * HOUR), 500]]);
		const p = await start([biliSub("b2", "222")], { b2: profile(500) });
		p.follower["222"] = 520;
		await p.handle.pollNow();
		// 起点是盘上更早那条 500,不是这一轮拉到的 520。
		expect(p.entries()[0]).toMatchObject({ current: 520, deltaSubscribed: 20 });

		p.follower["222"] = 540;
		await p.handle.pollNow();
		expect(p.entries()[0]).toMatchObject({ current: 540, deltaSubscribed: 40 });
	});

	it("B 站:开机恢复的条目也从盘上第一条样本算「订阅以来」", async () => {
		await seedSeries("b1", [
			[ago(20 * DAY), 1000],
			[ago(10 * DAY), 1100],
			[ago(2 * HOUR), 1330],
		]);
		const p = await start([biliSub("b1", "111")], { b1: profile(1330) });
		expect(p.entries()).toEqual([
			{
				subscriptionId: "b1",
				identity: { sourceKey: "bilibili", externalId: "111" },
				current: 1330,
				refreshedAt: expect.any(String),
				deltaSubscribed: 330,
				delta24h: null,
				delta7d: null,
			},
		]);
	});

	// 验红:把 extensionEntry 里的 `findEarliest` 换成取最近一条(`findNearestBefore(key, FUTURE_ISO)`),deltaSubscribed 变小,红。
	it("拓展:起点 = 盘上第一条样本;后来又写进来的样本不改它", async () => {
		await seedSeries("e1", [
			[ago(25 * DAY), 100],
			[ago(9 * DAY), 150],
			[ago(30 * HOUR), 300],
			[ago(HOUR), 400],
		]);
		const p = await start([extSub("e1", "sec-1")], { e1: profile(420) });
		await p.handle.pollNow();
		expect(p.entries()[0]).toMatchObject({ current: 420, deltaSubscribed: 320 });

		// 盘上又进来几条新样本、资料也报了新数:起点仍是 25 天前那第一条(100)。
		await seedSeries("e1", [
			[ago(25 * DAY), 100],
			[ago(9 * DAY), 150],
			[ago(30 * HOUR), 300],
			[ago(HOUR), 400],
			[ago(30 * 60_000), 430],
		]);
		p.runtime.set("e1", profile(450));
		await p.handle.pollNow();
		expect(p.entries()[0]).toMatchObject({ current: 450, deltaSubscribed: 350 });
	});
});

describe("GET /api/stats/followers — B 站与拓展各一条", () => {
	// 验红:把 extensionEntry 里 24h 基准的目标改成 7 天前(与 7d 同一个点),拓展的 delta24h 从 120 变 270,红。
	it("返回最近一轮的 entries:B 站与拓展各带 identity(来源键 + 外部 id);各格的数一一对得上", async () => {
		await seedSeries("b1", BILI_LONG);
		await seedSeries("e1", [
			[ago(25 * DAY), 100],
			[ago(9 * DAY), 150], // 7 天前之前最近的一条
			[ago(7 * DAY - HOUR), 190], // 7 天前之后 → 不算
			[ago(30 * HOUR), 300], // 24 小时前之前最近的一条
			[ago(23 * HOUR), 330], // 之后 → 不算
			[ago(HOUR), 400],
		]);
		const refreshedAt = isoAgo(5 * 60_000);
		const p = await start([biliSub("b1", "111"), extSub("e1", "sec-1")], {
			b1: profile(1330),
			e1: profile(420, refreshedAt),
		});
		p.follower["111"] = 1350;
		await p.handle.pollNow();

		const body = await getFollowers(p.handle);
		expect(
			[...body.entries].sort((a, b) => a.subscriptionId.localeCompare(b.subscriptionId)),
		).toEqual([
			{
				subscriptionId: "b1",
				identity: { sourceKey: "bilibili", externalId: "111" },
				current: 1350,
				refreshedAt: expect.any(String),
				deltaSubscribed: 350,
				delta24h: 50,
				delta7d: 150,
			},
			{
				subscriptionId: "e1",
				identity: { sourceKey: "douyin", externalId: "sec-1" },
				current: 420, // 取它最近报的资料,不是样本末值 400
				refreshedAt,
				deltaSubscribed: 320, // 420 − 第一条 100
				delta24h: 120, // 420 − 300
				delta7d: 270, // 420 − 150
			},
		]);
	});

	it("粉丝轮询还没挂上(开机早期)→ 200 + 空 entries", async () => {
		expect(await getFollowers(undefined)).toEqual({ entries: [] });
	});
});
