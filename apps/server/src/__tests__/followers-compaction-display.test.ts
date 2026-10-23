/**
 * 🔴 **压缩前后,粉丝的「显示」逐字节相同**(ADR-0027 决策 8、15;㉘c)。这是粉丝样本压缩最要紧的一条:
 * 压缩只许让盘上的行变少,统计页的粉丝曲线、净增、首页粉丝面板的各格一个字都不许变。
 *
 * 夹具是 ㉘a 钉现状那四个测试用的那一批(30 天:每 10 分钟都在变的活跃订阅、好几天不变的长平段、BN 关了两天的缺口、
 * 一天只有一两条、压在整点与本地日边界上的样本、几条拓展订阅),外加一条「十天里每 10 分钟都不变」的平段
 * (压缩时会合成段、读的那一层要把它展开回来)。
 *
 * 三组:
 *   1. 同一份文件先读一遍 `/overview`(三个时区)、对每个文件跑 `compact`、再读一遍 —— 两次返回逐字节相同;
 *   2. 首页粉丝面板(B 站与拓展各一条,经粉丝轮询器):压过的目录与没压过的目录算出来的条目相同;
 *   3. 把「现在」往后推 10 天、追加几条新样本、再压、再读 —— 与「同样的数据从没压过」读出来的相同。
 *
 * 只假装 Date(固定「现在」),定时器是真的。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FollowersRefreshEntry, ok, type Subscription } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createFollowersStore, FOLLOWERS_DIR, type FollowersStore } from "../followers/store.js";
import { createStatsRoute } from "../routes/stats.js";
import { createStatsFollowersRoute } from "../routes/stats-followers.js";
import type { RouteDeps } from "../routes/types.js";
import { startMigratedProfileRefresh as startProfileRefresh } from "../runtime/__tests__/profile-refresh-support.js";
import { createNodeMessageBus } from "../runtime/message-bus.js";
import type { ProfileRefreshHandle } from "../runtime/profile-refresh.js";
import type { SubRuntime } from "../runtime/sub-runtime-store.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";
import { fakeProfileImages } from "./support/profile-images.js";

// cron 换成不排程的假货(同 profile-refresh-track 等的套路)。真的 CronJob 不归 serviceCtx 管;这里 Date 钉在
// 整点上,它眼下要 10 分钟后才到点,换个「现在」就不一定了 —— 别靠这个。
vi.mock("cron", () => ({
	CronJob: class {
		start(): void {}
		stop(): void {}
	},
}));

const at = (iso: string) => Date.parse(iso);
const NOW = at("2026-06-30T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TZS = [0, -480, 300] as const;
const silent = { debug() {}, info() {}, warn() {}, error() {} } as never;

type Sample = [atMs: number, value: number];

/** act:06-01 00:00Z 起每 10 分钟一条、每条 +1,一直到「现在」。 */
const ACT: Sample[] = Array.from(
	{ length: 4249 },
	(_, i): Sample => [at("2026-06-01T00:00:00.000Z") + i * 10 * MIN, 10000 + i],
);
/** plateau:06-05 起每 10 分钟一条、值一直是 500,到 06-15 23:50;06-16 00:00 涨到 530;之后偶尔一条。 */
const PLATEAU: Sample[] = [
	...Array.from(
		{ length: 11 * 144 },
		(_, i): Sample => [at("2026-06-05T00:00:00.000Z") + i * 10 * MIN, 500],
	),
	[at("2026-06-16T00:00:00.000Z"), 530],
	[at("2026-06-20T09:00:00.000Z"), 530],
	[at("2026-06-28T15:30:00.000Z"), 540],
];
/** flat:窗口之前一条;长平段、一天两条;涨;两天缺口;再涨;最后一条在今天。 */
const FLAT: Sample[] = [
	[at("2026-05-20T10:00:00.000Z"), 6990],
	[at("2026-06-03T10:00:00.000Z"), 7000],
	...[4, 5, 6, 7, 8, 9, 10, 11, 12].flatMap((d): Sample[] => [
		[at(`2026-06-${String(d).padStart(2, "0")}T10:00:00.000Z`), 7000],
		[at(`2026-06-${String(d).padStart(2, "0")}T22:00:00.000Z`), 7000],
	]),
	[at("2026-06-13T10:00:00.000Z"), 7010],
	[at("2026-06-16T10:00:00.000Z"), 7010],
	[at("2026-06-17T09:00:00.000Z"), 7025],
	[at("2026-06-30T11:00:00.000Z"), 7025],
];
/** edge:压在三个时区的本地日边界与整点上(同一小时里有两条的也有)。 */
const EDGE: Sample[] = [
	[at("2026-06-10T00:00:00.000Z"), 100],
	[at("2026-06-10T05:00:00.000Z"), 105],
	[at("2026-06-10T15:59:59.999Z"), 110],
	[at("2026-06-10T16:00:00.000Z"), 120],
	[at("2026-06-10T23:59:59.999Z"), 130],
	[at("2026-06-11T00:00:00.000Z"), 140],
	[at("2026-06-11T04:59:59.999Z"), 150],
	[at("2026-06-12T13:00:00.000Z"), 160],
	[at("2026-06-12T13:59:59.999Z"), 165],
	[at("2026-06-12T14:00:00.000Z"), 170],
];
const SPARSE: Sample[] = [
	[at("2026-06-20T08:00:00.000Z"), 900],
	[at("2026-06-20T20:00:00.000Z"), 905],
	[at("2026-06-21T09:30:00.000Z"), 905],
	[at("2026-06-25T03:00:00.000Z"), 880],
];
const EXT1: Sample[] = [
	[at("2026-06-05T12:00:00.000Z"), 300],
	[at("2026-06-06T12:00:00.000Z"), 310],
	[at("2026-06-10T12:00:00.000Z"), 330],
	[at("2026-06-29T12:00:00.000Z"), 340],
	[at("2026-06-30T09:00:00.000Z"), 345],
];
const EXT2: Sample[] = [
	[at("2026-06-28T12:00:00.000Z"), 50],
	[at("2026-06-29T12:00:00.000Z"), 60],
];

const bili = (id: string, uid: string): Subscription =>
	({ id, identity: { sourceKey: "bilibili", externalId: uid }, enabled: true }) as never;
const ext = (id: string, externalId: string): Subscription =>
	makeExtensionSubscription({ id, extensionId: "douyin", externalId, enabled: true });

const SUBS: Subscription[] = [
	bili("b-act", "1001"),
	bili("b-plateau", "1005"),
	bili("b-flat", "1002"),
	bili("b-edge", "1003"),
	bili("b-sparse", "1004"),
	ext("e-1", "s1"),
	ext("e-2", "s2"),
];
const SERIES: Record<string, Sample[]> = {
	"b-act": ACT,
	"b-plateau": PLATEAU,
	"b-flat": FLAT,
	"b-edge": EDGE,
	"b-sparse": SPARSE,
	"e-1": EXT1,
	"e-2": EXT2,
};

const dirs: string[] = [];
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
});
afterEach(async () => {
	vi.useRealTimers();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const lineOf = ([ms, followers]: Sample) =>
	`${JSON.stringify({ sampledAt: new Date(ms).toISOString(), followers })}\n`;

/** 一个新的数据根,按 `series` 落盘(没给就用上面那一批)。 */
async function seededRoot(series: Record<string, Sample[]> = SERIES): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "bn-followers-compaction-display-"));
	dirs.push(root);
	await mkdir(join(root, ...FOLLOWERS_DIR), { recursive: true });
	for (const [key, samples] of Object.entries(series)) {
		await writeFile(join(root, ...FOLLOWERS_DIR, `${key}.jsonl`), samples.map(lineOf).join(""));
	}
	return root;
}

const storeOf = (root: string): FollowersStore =>
	createFollowersStore({ dataRoot: root, logger: silent });

async function compactAll(root: string, now: Date): Promise<void> {
	const store = storeOf(root);
	for (const key of await store.keys()) await store.compact(key, now);
}

const rawFile = (root: string, key: string) =>
	readFile(join(root, ...FOLLOWERS_DIR, `${key}.jsonl`), "utf8");

/** `/overview` 的整份返回文本(按订阅 id 排好不用,路由本身有序)。 */
async function overviewText(root: string, days: number, tz: number): Promise<string> {
	const deps = {
		store: { getSubscriptions: () => SUBS },
		runtime: {
			engines: null,
			profileRefresh: {
				getLastEntries: () => [
					{
						subscriptionId: "b-flat",
						identity: { sourceKey: "bilibili", externalId: "1002" },
						current: 8888,
					},
				],
			},
			fansStore: storeOf(root),
			statsStore: {
				listPosts: async () => [],
				listLiveSessions: async () => [],
				listRecording: async () => [],
			},
			subRuntimeStore: {
				get: (id: string) => (id === "e-1" ? { cachedProfile: { fans: 999 } } : undefined),
			},
			serviceCtx: { logger: silent },
		},
	} as unknown as RouteDeps;
	const res = await createStatsRoute(deps).request(`/overview?days=${days}&tz=${tz}`);
	expect(res.status).toBe(200);
	return res.text();
}

describe("压缩前后:GET /api/stats/overview 的粉丝各格逐字节相同", () => {
	it.each(TZS)("同一份文件压缩前后各读一遍,整份返回相同(30 天窗口)[tz=%i]", async (tz) => {
		const root = await seededRoot();
		const before = await overviewText(root, 30, tz);
		const sizeBefore = (await rawFile(root, "b-act")).length;

		await compactAll(root, new Date(NOW));

		// 压缩真的发生了:每 10 分钟的两份文件缩了、长平段合成了段 —— 否则「相同」什么都证明不了。
		expect((await rawFile(root, "b-act")).length).toBeLessThan(sizeBefore);
		expect(await rawFile(root, "b-plateau")).toContain("lastSampledAt");
		expect(await overviewText(root, 30, tz)).toBe(before);
		// 内容不是空的:返回里有这些订阅的粉丝曲线。
		expect(before).toContain('"b-plateau"');
		expect(before).toContain("14248");
	});

	it("窗口换成 7 天与 90 天也相同", async () => {
		const root = await seededRoot();
		const before = await Promise.all([7, 90].map((days) => overviewText(root, days, -480)));
		await compactAll(root, new Date(NOW));
		expect(await Promise.all([7, 90].map((days) => overviewText(root, days, -480)))).toEqual(
			before,
		);
	});
});

const GLOBALS = { profileRefreshCron: "*/10 * * * *" } as never;

/** 起一个粉丝轮询器(B 站每个 uid 报 `follower[uid]`),跑一轮,回面板上每条的条目(按订阅 id 排)。 */
async function panelEntries(root: string): Promise<FollowersRefreshEntry[]> {
	const subs = [bili("b-act", "1001"), bili("b-flat", "1002"), ext("e-1", "s1"), ext("e-2", "s2")];
	const runtime = new Map<string, SubRuntime>([
		[
			"b-act",
			{
				cachedProfile: {
					name: "x",
					sign: "",
					fans: 14248,
					lastRefreshedAt: "2026-06-30T11:55:00.000Z",
				},
			},
		],
		[
			"b-flat",
			{
				cachedProfile: {
					name: "x",
					sign: "",
					fans: 7025,
					lastRefreshedAt: "2026-06-30T11:55:00.000Z",
				},
			},
		],
		[
			"e-1",
			{
				cachedProfile: {
					name: "x",
					sign: "",
					fans: 350,
					lastRefreshedAt: "2026-06-30T11:50:00.000Z",
				},
			},
		],
		[
			"e-2",
			{ cachedProfile: { name: "x", sign: "", lastRefreshedAt: "2026-06-30T11:50:00.000Z" } },
		],
	]);
	const follower: Record<string, number> = { "1001": 14250, "1002": 7030 };
	const serviceCtx = {
		setTimeout: vi.fn(() => undefined),
		setInterval: vi.fn(() => undefined),
		track: vi.fn(),
		signal: new AbortController().signal,
	};
	const handle: ProfileRefreshHandle = startProfileRefresh({
		images: fakeProfileImages(),
		isStatsEnabled: () => true,
		bus: createNodeMessageBus(),
		logger: silent,
		configStore: { getGlobals: () => GLOBALS, patchSubscription: vi.fn() } as never,
		subscriptionStore: { list: () => subs } as never,
		subRuntimeStore: {
			get: (id: string) => runtime.get(id),
			getAll: () => Object.fromEntries(runtime),
			patch: vi.fn(async (id: string, p: SubRuntime) => {
				runtime.set(id, { ...runtime.get(id), ...p });
			}),
			prune: vi.fn(async () => {}),
			load: vi.fn(async () => {}),
		} as never,
		fansStore: storeOf(root),
		api: {
			fetchUserCard: vi.fn(async (uid: string) =>
				ok({
					data: { card: { fans: follower[uid], name: `UP${uid}`, face: "", sign: "" } },
				}),
			),
		} as never,
		serviceCtx: serviceCtx as never,
	});
	try {
		await vi.waitFor(() => expect(serviceCtx.setTimeout).toHaveBeenCalled());
		await handle.pollNow();
		const app = createStatsFollowersRoute({
			runtime: { profileRefresh: handle },
		} as unknown as RouteDeps);
		const res = await app.request("/");
		expect(res.status).toBe(200);
		const { entries } = (await res.json()) as { entries: FollowersRefreshEntry[] };
		// B 站条目的 `refreshedAt` 是这一轮采样的时刻(轮询里有真实的等待,假时钟不是定死的),不是被测的东西,抹掉。
		return entries
			.map((entry) =>
				entry.identity.sourceKey === "bilibili" ? { ...entry, refreshedAt: "(这一轮)" } : entry,
			)
			.sort((a, b) => a.subscriptionId.localeCompare(b.subscriptionId));
	} finally {
		handle.dispose();
	}
}

describe("压缩前后:GET /api/stats/followers(首页粉丝面板)的各格相同", () => {
	it("B 站与拓展各条的 current / 起点 / 24h / 7d:压过的目录与没压过的目录算出来一样(起点只按定案挪)", async () => {
		const plain = await seededRoot();
		const squeezed = await seededRoot();
		await compactAll(squeezed, new Date(NOW));
		const want = await panelEntries(plain);
		// 有数:四条都在、各格都不是 null(24h / 7d 之前有样本的那几条)。
		expect(want.map((e) => e.subscriptionId)).toEqual(["b-act", "b-flat", "e-1", "e-2"]);
		expect(want.find((e) => e.subscriptionId === "b-act")).toMatchObject({
			current: 14250,
			delta24h: expect.any(Number),
			delta7d: expect.any(Number),
		});
		// 「订阅以来」从时序第一条算:压缩把第一个小时并成那个小时的末值,起点最多挪一小时(data-model 定的,
		// 不算截尾)。b-act 第一个小时里一直在涨,压过之后起点是那个小时的末值,只有这一格少掉这么多;
		// 别的格、别的条(第一个小时平着)一字不差。
		const [firstAt, firstValue] = ACT[0] as Sample; // 夹具里 ACT 不空
		const firstHourLast = ACT.filter(([ts]) => ts < firstAt + 60 * MIN).at(-1)?.[1] ?? firstValue;
		expect(firstHourLast).toBeGreaterThan(firstValue);
		expect(await panelEntries(squeezed)).toEqual(
			want.map((e) =>
				e.subscriptionId === "b-act" && e.deltaSubscribed !== null
					? { ...e, deltaSubscribed: e.deltaSubscribed - (firstHourLast - firstValue) }
					: e,
			),
		);
	});
});

describe("压缩、再往后走:「现在」推后 10 天、追加新样本、再压", () => {
	/** 10 天后又有的样本:活跃订阅接着每 10 分钟(隔了 10 天的缺口),平段订阅与拓展各来几条。 */
	const LATER = NOW + 10 * DAY;
	const MORE: Record<string, Sample[]> = {
		"b-act": Array.from(
			{ length: 37 },
			(_, i): Sample => [LATER - 6 * HOUR + i * 10 * MIN, 20000 + i],
		),
		"b-plateau": [
			[LATER - 5 * HOUR, 540],
			[LATER - 4 * HOUR, 560],
		],
		"b-flat": [[LATER - 3 * HOUR, 7025]],
		"e-2": [[LATER - 2 * HOUR, 80]],
	};

	async function appendMore(root: string): Promise<void> {
		const store = storeOf(root);
		for (const [key, samples] of Object.entries(MORE)) {
			for (const [ms, followers] of samples) {
				await store.append(key, { sampledAt: new Date(ms).toISOString(), followers });
			}
		}
	}

	it.each(TZS)("与「同样的数据从没压过」读出来逐字节相同 [tz=%i]", async (tz) => {
		const squeezed = await seededRoot();
		const never = await seededRoot();
		await compactAll(squeezed, new Date(NOW));
		vi.setSystemTime(LATER);
		await appendMore(squeezed);
		await appendMore(never);
		await compactAll(squeezed, new Date(LATER));

		expect(await rawFile(squeezed, "b-plateau")).toContain("lastSampledAt");
		expect((await rawFile(squeezed, "b-act")).length).toBeLessThan(
			(await rawFile(never, "b-act")).length,
		);
		expect(await overviewText(squeezed, 30, tz)).toBe(await overviewText(never, 30, tz));
	});

	it("再压一次(同一个「现在」)不改任何文件", async () => {
		const root = await seededRoot();
		await compactAll(root, new Date(NOW));
		const first = await Promise.all(Object.keys(SERIES).map((key) => rawFile(root, key)));
		const store = storeOf(root);
		for (const key of Object.keys(SERIES)) {
			expect((await store.compact(key, new Date(NOW))).rewritten).toBe(false);
		}
		expect(await Promise.all(Object.keys(SERIES).map((key) => rawFile(root, key)))).toEqual(first);
	});
});
