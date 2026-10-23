/**
 * 粉丝样本压缩之后,涨粉起点的两个读法(ADR-0027 决策 15;㉘d 补 ㉘c 没钉的):
 *
 * 1. **拓展订阅**的起点是盘上第一行的值。压缩把最早那一小时换成「小时末值」(那一小时里最晚的一条):起点最多挪一小时,
 *    不算截尾,不另存起点 —— 主人定的(`docs/1.0/construction-plan.md`「涨粉起点」那条)。所以第一个小时里有好几条
 *    值不同的样本时,压缩后 `deltaSubscribed` 以那个小时的末值为起点。
 * 2. **B 站**与拓展同一口径,压缩后也从第一个小时的末值算「订阅以来」。
 *
 * 粉丝仓是真的(tmpdir),压缩用仓的 `compact`;期望全是手写字面量。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FollowersRefreshEntry, ok, type Subscription } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { fakeProfileImages } from "../../__tests__/support/profile-images.js";
import { createFollowersStore, FOLLOWERS_DIR } from "../../followers/store.js";
import { createNodeMessageBus } from "../message-bus.js";
import type { ProfileRefreshHandle } from "../profile-refresh.js";
import type { SubRuntime } from "../sub-runtime-store.js";
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
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const silent = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

let dataDir: string;
let handle: ProfileRefreshHandle | undefined;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-fans-compressed-"));
});
afterEach(async () => {
	handle?.dispose();
	handle = undefined;
	await rm(dataDir, { recursive: true, force: true });
});

const iso = (ms: number) => new Date(ms).toISOString();
const ago = (ms: number) => Date.now() - ms;
type Sample = [atMs: number, value: number];

async function seed(key: string, samples: Sample[]): Promise<void> {
	await mkdir(join(dataDir, ...FOLLOWERS_DIR), { recursive: true });
	await writeFile(
		join(dataDir, ...FOLLOWERS_DIR, `${key}.jsonl`),
		samples
			.map(([ms, followers]) => `${JSON.stringify({ sampledAt: iso(ms), followers })}\n`)
			.join(""),
	);
}

async function compact(key: string): Promise<void> {
	await createFollowersStore({ dataRoot: dataDir, logger: silent }).compact(key, new Date());
}

async function start(subs: Subscription[], seeded: Record<string, SubRuntime>) {
	const runtime = new Map<string, SubRuntime>(Object.entries(seeded));
	const patch = vi.fn(async (id: string, p: SubRuntime) => {
		runtime.set(id, { ...runtime.get(id), ...p });
	});
	const serviceCtx = {
		setTimeout: vi.fn(() => undefined),
		setInterval: vi.fn(() => undefined),
		track: vi.fn(),
		signal: new AbortController().signal,
	};
	handle = startMigratedProfileRefresh({
		images: fakeProfileImages(),
		isStatsEnabled: () => true,
		bus: createNodeMessageBus(),
		logger: silent,
		configStore: { getGlobals: () => GLOBALS, patchSubscription: vi.fn() } as never,
		subscriptionStore: { list: () => subs } as never,
		subRuntimeStore: {
			get: (id: string) => runtime.get(id),
			getAll: () => Object.fromEntries(runtime),
			patch,
			prune: vi.fn(async () => {}),
			load: vi.fn(async () => {}),
		} as never,
		fansStore: createFollowersStore({ dataRoot: dataDir, logger: silent }),
		api: {
			fetchUserCards: vi.fn(async () => ({ code: 0, data: {} })),
			fetchRelationStat: vi.fn(async () => ({ code: 0, data: { follower: 0 } })),
			fetchUserCard: vi.fn(async () => ok({ data: { card: {} } })),
		} as never,
		serviceCtx: serviceCtx as never,
	});
	await vi.waitFor(() => expect(serviceCtx.setTimeout).toHaveBeenCalled());
	const poller = handle as ProfileRefreshHandle;
	return {
		runtime,
		patch,
		entries: (): FollowersRefreshEntry[] => [...poller.getLastEntries()],
		handle: poller,
	};
}

const profile = (fans: number): SubRuntime => ({
	cachedProfile: { name: "x", sign: "", fans, lastRefreshedAt: iso(ago(5 * MIN)) },
});

describe("拓展订阅:压缩后的起点 = 第一个小时的末值", () => {
	// 25 天前那个整点小时里有两条:10 分 100、50 分 130。压缩每小时只留最晚的一条 → 起点从 100 挪成 130。
	const series = (): Sample[] => {
		const h0 = Math.floor(ago(25 * DAY) / HOUR) * HOUR;
		return [
			[h0 + 10 * MIN, 100],
			[h0 + 50 * MIN, 130],
			[ago(9 * DAY), 150],
			[ago(30 * HOUR), 300],
			[ago(HOUR), 400],
		];
	};

	it("没压过:起点是 100,涨了 320(对照)", async () => {
		await seed("e1", series());
		const p = await start(
			[
				makeExtensionSubscription({
					id: "e1",
					extensionId: "douyin",
					externalId: "s",
					enabled: true,
				}),
			],
			{ e1: profile(420) },
		);
		await p.handle.pollNow();
		expect(p.entries()[0]).toMatchObject({
			subscriptionId: "e1",
			current: 420,
			deltaSubscribed: 320,
		});
	});

	it("压过之后:起点是第一个小时的末值 130,涨了 290;24h / 7d 不受影响", async () => {
		await seed("e1", series());
		await compact("e1");
		const p = await start(
			[
				makeExtensionSubscription({
					id: "e1",
					extensionId: "douyin",
					externalId: "s",
					enabled: true,
				}),
			],
			{ e1: profile(420) },
		);
		await p.handle.pollNow();
		expect(p.entries()[0]).toMatchObject({
			subscriptionId: "e1",
			current: 420,
			deltaSubscribed: 290,
			delta24h: 120, // 420 − 300(30 小时前那条)
			delta7d: 270, // 420 − 150(9 天前那条)
		});
	});
});

describe("B 站同拓展:压缩后的起点 = 第一个小时的末值", () => {
	const biliSub = (): Subscription =>
		({ id: "b1", identity: { sourceKey: "bilibili", externalId: "111" }, enabled: true }) as never;

	it("第一个小时里有两条:压缩后从小时末的 1005 算,涨了 325", async () => {
		const h0 = Math.floor(ago(20 * DAY) / HOUR) * HOUR;
		await seed("b1", [
			[h0 + 10 * MIN, 1000],
			[h0 + 50 * MIN, 1005],
			[ago(2 * HOUR), 1330],
		]);
		await compact("b1");
		const p = await start([biliSub()], { b1: profile(1330) });
		expect(p.entries()[0]).toMatchObject({
			subscriptionId: "b1",
			current: 1330,
			deltaSubscribed: 325,
		});
	});
});
