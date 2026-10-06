/**
 * 首页粉丝面板的现状钉子(㉘a):`GET /api/stats/followers` 与 `fans-refreshed` 里每条的
 * `current / deltaSubscribed / delta24h / delta7d`,B 站订阅与拓展订阅各验,以及「涨粉起点」取哪一条、起点不被后来的样本改掉。
 *
 * ㉘c 要压缩粉丝样本文件、改行的形状;「采集与显示都不变」由这份测试裁判 —— 之后只许改 {@link sampleRow}
 * (夹具行的形状)与 {@link seedSeries} 里写盘的那一处,期望一个都不许动。从外面钉:粉丝仓是真的(tmpdir),
 * 看的是轮询器吐出来的条目、路由返回的 JSON、运行时仓里 `fansBaseline` 的值,不看盘上的行长什么样、不看内部怎么调。
 *
 * 取数口径(现状):24h / 7d = 「那一刻**之前**最近的一条样本」(`ts <= now − 24h / 7d`,之后的不算);
 * 那之前没有样本 → `null`。B 站起点 = 运行时仓里的 `fansBaseline`(第一次采到时写成当时的值,之后不再改);
 * 开机按盘上最早一条自愈(最早的比 baseline 更早才改)。拓展起点 = 盘上第一条样本。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FansRefreshEntry, Subscription } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { createFollowersStore, FOLLOWERS_DIR } from "../../followers/store.js";
import { createStatsFollowersRoute } from "../../routes/stats-followers.js";
import type { RouteDeps } from "../../routes/types.js";
import { type FansPollerHandle, startFansPoller } from "../fans-poller.js";
import { createNodeMessageBus } from "../message-bus.js";
import type { SubRuntime } from "../sub-runtime-store.js";

const GLOBALS = { app: { fansCron: "*/10 * * * *" } } as never;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let dataDir: string;
let handle: FansPollerHandle | undefined;

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

const profile = (fans?: number, lastRefreshedAt = isoAgo(5 * 60_000)): SubRuntime => ({
	cachedProfile: { name: "x", sign: "", ...(fans === undefined ? {} : { fans }), lastRefreshedAt },
});

async function start(subs: Subscription[], seed: Record<string, SubRuntime>) {
	const runtime = new Map<string, SubRuntime>(Object.entries(seed));
	const bus = createNodeMessageBus();
	const snapshots: FansRefreshEntry[][] = [];
	bus.on("fans-refreshed", ({ entries }) => {
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
	const patch = vi.fn(async (id: string, p: SubRuntime) => {
		runtime.set(id, { ...runtime.get(id), ...p });
	});
	handle = startFansPoller({
		isStatsEnabled: () => true,
		bus,
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
		configStore: { getGlobals: () => GLOBALS, patchSubscription: vi.fn() } as never,
		subscriptionStore: { list: () => subs } as never,
		subRuntimeStore: {
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
			getUserCardsBatch: vi.fn(async () => ({ code: 0, data: {} })),
			getRelationStat: vi.fn(async (uid: string) => ({
				code: 0,
				data: { follower: follower[uid] },
			})),
			getUserCardInfo: vi.fn(async (uid: string) => ({
				code: 0,
				data: { card: { fans: follower[uid], name: `UP${uid}`, face: "", sign: "" } },
			})),
		} as never,
		serviceCtx: serviceCtx as never,
	});
	// 开机恢复跑完才会排那个 3s 延时的首 tick —— 等它被排上,恢复就不会和用例的 tick 交错。
	await vi.waitFor(() => expect(serviceCtx.setTimeout).toHaveBeenCalled());
	const poller = handle as FansPollerHandle;
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

async function getFollowers(h: FansPollerHandle | undefined) {
	const app = createStatsFollowersRoute({ runtime: { fansPoller: h } } as unknown as RouteDeps);
	const res = await app.request("/");
	expect(res.status).toBe(200);
	return (await res.json()) as { entries: FansRefreshEntry[] };
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
	it("当前 = 这一轮拉到的数;起点 = 运行时仓里的 fansBaseline;24h / 7d = 那一刻之前最近的样本", async () => {
		await seedSeries("b1", BILI_LONG);
		const p = await start([biliSub("b1", "111")], {
			b1: { ...profile(1330), fansBaseline: { value: 1000, ts: isoAgo(20 * DAY) } },
		});
		p.follower["111"] = 1350;
		expect(await p.handle.pollNow()).toBe(true);

		expect(p.entries()).toEqual([
			{
				subscriptionId: "b1",
				uid: "111",
				current: 1350,
				ts: expect.any(String),
				deltaSubscribed: 350, // 1350 − 起点 1000
				delta24h: 50, // 1350 − 1300(不是之后的 1320)
				delta7d: 150, // 1350 − 1200(不是之后的 1250)
			},
		]);
		// 这一轮的采样时刻就是「现在」。
		expect(Math.abs(Date.parse(p.entries()[0]?.ts as string) - Date.now())).toBeLessThan(5_000);
		// 接口返回与事件快照是同一份(`fans-refreshed` 里各条目的数)。
		expect((await getFollowers(p.handle)).entries).toEqual(p.entries());
		expect(p.snapshots.at(-1)).toEqual(p.entries());
	});

	// 验红:把 `delta7d = near7d ? … : null` 改成 `near7d ? … : 0`,没有 7 天前样本的那条变 0,红。
	it("24h / 7d 之前还没有样本 → 那一格是 null(不是 0);起点只有 baseline", async () => {
		await seedSeries("b3", [[ago(30 * HOUR), 700]]); // 只有 24h 之前这一条
		await seedSeries("b2", [[ago(3 * HOUR), 500]]); // 24h 之内才有第一条
		const p = await start([biliSub("b3", "333"), biliSub("b2", "222")], {
			b3: { ...profile(700), fansBaseline: { value: 690, ts: isoAgo(2 * DAY) } },
			b2: { ...profile(500), fansBaseline: { value: 480, ts: isoAgo(4 * HOUR) } },
		});
		p.follower["333"] = 730;
		p.follower["222"] = 520;
		await p.handle.pollNow();

		const by = new Map(p.entries().map((e) => [e.subscriptionId, e]));
		expect(by.get("b3")).toMatchObject({
			current: 730,
			deltaSubscribed: 40,
			delta24h: 30,
			delta7d: null,
		});
		expect(by.get("b2")).toMatchObject({
			current: 520,
			deltaSubscribed: 40,
			delta24h: null,
			delta7d: null,
		});
	});
});

describe("涨粉起点:订阅以来涨了多少取哪一条当起点", () => {
	// 验红:把 `const nextBaseline = baseline ?? { value: current, ts }` 改成每轮都取当时的值(并每轮写回),deltaSubscribed 恒为 0、起点被改写,本条红。
	it("B 站:第一次采到的那一刻写成起点(当时的值),之后的样本不改它", async () => {
		await seedSeries("b2", [[ago(3 * HOUR), 500]]);
		const p = await start([biliSub("b2", "222")], { b2: profile(500) }); // 没有 baseline
		p.follower["222"] = 520;
		const before = Date.now();
		await p.handle.pollNow();
		const first = p.runtime.get("b2")?.fansBaseline;
		// 起点是这一轮拉到的数(520),不是盘上更早那条 500;时刻是这一轮的采样时刻。
		expect(first).toEqual({ value: 520, ts: expect.any(String) });
		expect(Date.parse(first?.ts as string)).toBeGreaterThanOrEqual(before - 1);
		expect(p.entries()[0]).toMatchObject({ current: 520, deltaSubscribed: 0 });

		p.follower["222"] = 540;
		await p.handle.pollNow();
		expect(p.runtime.get("b2")?.fansBaseline).toEqual(first);
		expect(p.entries()[0]).toMatchObject({ current: 540, deltaSubscribed: 20 });
	});

	// 验红:把自愈的比较 `earliest.ts < baseline.ts` 改成 `>`,baseline 不再被校准,红。
	it("B 站:开机时盘上最早一条比 baseline 更早 → 以盘上最早一条校准起点;恢复出来的条目按校准后的算", async () => {
		await seedSeries("b1", [
			[ago(20 * DAY), 1000],
			[ago(10 * DAY), 1100],
			[ago(2 * HOUR), 1330],
		]);
		const p = await start([biliSub("b1", "111")], {
			b1: { ...profile(1330), fansBaseline: { value: 1500, ts: isoAgo(5 * DAY) } },
		});
		const healed = p.runtime.get("b1")?.fansBaseline;
		expect(healed?.value).toBe(1000);
		// 时刻是盘上最早那条样本的时刻(20 天前,不是原来 5 天前的 baseline 时刻)。
		expect(Math.abs(Date.parse(healed?.ts as string) - ago(20 * DAY))).toBeLessThan(5_000);
		// 恢复出来的首屏条目:当前 = 盘上末条 1330,起点 = 校准后的 1000;24h / 7d 留给第一轮正式采样。
		expect(p.entries()).toEqual([
			{
				subscriptionId: "b1",
				uid: "111",
				current: 1330,
				ts: expect.any(String),
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
	it("返回最近一轮的 entries:B 站带 uid、拓展带拓展 id + 外部 id;各格的数一一对得上", async () => {
		await seedSeries("b1", BILI_LONG);
		await seedSeries("e1", [
			[ago(25 * DAY), 100],
			[ago(9 * DAY), 150], // 7 天前之前最近的一条
			[ago(7 * DAY - HOUR), 190], // 7 天前之后 → 不算
			[ago(30 * HOUR), 300], // 24 小时前之前最近的一条
			[ago(23 * HOUR), 330], // 之后 → 不算
			[ago(HOUR), 400],
		]);
		const lastRefreshedAt = isoAgo(5 * 60_000);
		const p = await start([biliSub("b1", "111"), extSub("e1", "sec-1")], {
			b1: { ...profile(1330), fansBaseline: { value: 1000, ts: isoAgo(20 * DAY) } },
			e1: profile(420, lastRefreshedAt),
		});
		p.follower["111"] = 1350;
		await p.handle.pollNow();

		const body = await getFollowers(p.handle);
		expect(
			[...body.entries].sort((a, b) => a.subscriptionId.localeCompare(b.subscriptionId)),
		).toEqual([
			{
				subscriptionId: "b1",
				uid: "111",
				current: 1350,
				ts: expect.any(String),
				deltaSubscribed: 350,
				delta24h: 50,
				delta7d: 150,
			},
			{
				subscriptionId: "e1",
				extensionId: "douyin",
				externalId: "sec-1",
				current: 420, // 取它最近报的资料,不是样本末值 400
				ts: lastRefreshedAt,
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
