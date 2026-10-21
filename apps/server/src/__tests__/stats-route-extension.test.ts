/**
 * 路由测试 — `GET /api/stats/overview` 里的**拓展订阅行**(ADR-0020 决策 1 / 9 / 18)。
 *
 * 守的是四件事:
 *   - 行以订阅 id 为键,身份随行带着(两支同一种形状 `identity`,与订阅本身、推送历史的那一格是同一个类型);
 *   - 计数、场次、峰值、粉丝与 B 站走同一套聚合,只是按订阅 id 从仓里取;
 *   - 「那天有没有记录」各算各的(决策 9):拓展行只认它自己的「在记」,第一条之前没有 0;
 *     两支互不借覆盖,B 站没登录 / 一条 B 站订阅都没有也照常出数;
 *   - 在播与粉丝这两样内存状态进缓存键。
 *
 * 仓是按订阅 id 查夹具的替身,按 `since` 过滤的规矩与真仓一致 —— 路由拿错键、拿错窗口都读不到。
 */

import type { StatsOverviewResponse, UpStatsRow } from "@bilibili-notify/contract";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { FollowersAt } from "../followers/lookup.js";
import { createStatsRoute } from "../routes/stats.js";
import type { RouteDeps } from "../routes/types.js";
import type { LiveSessionEntry, PostEntry, RecordingEntry } from "../stats/store.js";

const H = 3_600_000;
const DAY = 86_400_000;
/** 固定「现在」:2026-05-16 12:00 UTC。用例一律 tz=0,日轴就是 UTC 日。 */
const NOW = Date.UTC(2026, 4, 16, 12, 0, 0);
const at = (daysAgo: number, hoursAgo = 0) =>
	new Date(NOW - daysAgo * DAY - hoursAgo * H).toISOString();

const EXT = "douyin-source";
/** 订阅 id 是 UUID(schema 钉着);这里只要各不相同、不像 uid。 */
const E1 = "e1000000-0000-4000-8000-000000000001";
const E2 = "e1000000-0000-4000-8000-000000000002";
const B1 = "b1000000-0000-4000-8000-000000000001";

interface Fixture {
	bili?: Array<{ id: string; uid: string; enabled?: boolean }>;
	ext?: Array<{ id: string; externalId?: string; enabled?: boolean }>;
	/** 以下全按**订阅 id** 记。 */
	samples?: Record<string, FollowersAt[]>;
	posts?: Record<string, PostEntry[]>;
	sessions?: Record<string, LiveSessionEntry[]>;
	/**
	 * 「在记」账的夹具写法:这些时刻所在的小时,作品与直播两项在记(拓展:这个小时收到过上报)。
	 * 订阅 id 不在这里、又没有 `recording` 的,账里什么都没有。
	 */
	seen?: Record<string, Array<{ ts: string }>>;
	/** 直接写账的行(优先于 `seen` 与 `recordedBy`)。 */
	recording?: Record<string, RecordingEntry[]>;
	/** 这些订阅的账由它们自己的粉丝样本所在的小时造出(三项都在记),B 站「那天粉丝轮询在跑」的写法。 */
	recordedBySamples?: string[];
	/** 资料缓存里的粉丝数(拓展报资料时更新,决策 8)。 */
	profileFans?: Record<string, number>;
	/** 此刻有一场在播的拓展订阅(场次模块手里有这一场)。 */
	liveExt?: Set<string>;
	/** 粉丝轮询的快照(按订阅 id 记);缺省 = 轮询没起来。 */
	fansEntries?: Array<{ subscriptionId: string; uid?: string; current: number }>;
	/** `false` = 引擎没挂上。 */
	engines?: boolean;
}

function makeDeps(f: Fixture): RouteDeps {
	return {
		runtime: {
			fansStore: {
				listSamplesSince: async (key: string, since: string) =>
					(f.samples?.[key] ?? []).filter((s) => s.sampledAt >= since),
				// 与真仓一致:替身手里这条订阅的样本里,不晚于入参时刻的最近一条;没有就 undefined。
				findNearestBefore: async (key: string, iso: string) =>
					(f.samples?.[key] ?? []).filter((s) => s.sampledAt <= iso).at(-1),
			},
			statsStore: {
				listPosts: async (key: string, since: string) =>
					(f.posts?.[key] ?? []).filter((e) => e.publishedAt >= since),
				listLiveSessions: async (key: string, since: string) =>
					(f.sessions?.[key] ?? []).filter((s) => s.current === true || s.startedAt >= since),
				listRecording: async (key: string, since: string) => {
					const direct = f.recording?.[key];
					if (direct) return direct.filter((r) => r.endedAt > since);
					const hourOf = (ts: string): RecordingEntry => {
						const from = Math.floor(Date.parse(ts) / H) * H;
						return {
							kind: "posts",
							startedAt: new Date(from).toISOString(),
							endedAt: new Date(from + H).toISOString(),
						};
					};
					const rows: RecordingEntry[] = [];
					for (const r of f.seen?.[key] ?? []) {
						rows.push(hourOf(r.ts), { ...hourOf(r.ts), kind: "live" });
					}
					if (f.recordedBySamples?.includes(key)) {
						for (const sample of f.samples?.[key] ?? []) {
							for (const kind of ["posts", "live", "followers"] as const) {
								rows.push({ ...hourOf(sample.sampledAt), kind });
							}
						}
					}
					return rows.filter((r) => r.endedAt > since);
				},
			},
			subRuntimeStore: {
				get: (id: string) =>
					f.profileFans?.[id] === undefined
						? { cachedProfile: { name: "n", avatar: "", sign: "", lastRefreshedAt: at(0) } }
						: {
								cachedProfile: {
									name: "n",
									avatar: "",
									sign: "",
									fans: f.profileFans[id],
									lastRefreshedAt: at(0),
								},
							},
			},
			engines:
				f.engines === false
					? null
					: {
							liveSession: (id: string) =>
								f.liveExt?.has(id)
									? { subscriptionId: id, extensionId: EXT, detectedAt: NOW - H }
									: undefined,
						},
			fansPoller: f.fansEntries ? { getLastEntries: () => f.fansEntries } : null,
		},
		store: {
			getSubscriptions: () => [
				...(f.bili ?? []).map(({ uid, ...s }) => ({
					enabled: true,
					identity: { sourceKey: "bilibili", externalId: uid },
					...s,
				})),
				...(f.ext ?? []).map(({ externalId, ...s }) => ({
					identity: { sourceKey: EXT, externalId: externalId ?? `ext-${s.id.slice(-1)}` },
					enabled: true,
					...s,
				})),
			],
		},
		puppeteer: null,
		wsTicketStore: null,
	} as unknown as RouteDeps;
}

const get = async (deps: RouteDeps, qs = "?days=5&tz=0"): Promise<StatsOverviewResponse> => {
	const res = await createStatsRoute(deps).request(`/overview${qs}`);
	expect(res.status).toBe(200);
	return (await res.json()) as StatsOverviewResponse;
};
const rowOf = (body: StatsOverviewResponse, id: string): UpStatsRow => {
	const row = body.rows.find((r) => r.subscriptionId === id);
	if (!row) throw new Error(`没有订阅 ${id} 那一行`);
	return row;
};
/** 近 n 天每天一条(第 i 天中午)—— 「在记」/ 粉丝样本的夹具。 */
const everyDay = (n: number) => Array.from({ length: n }, (_, i) => at(n - 1 - i));

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});

describe("拓展行:键与身份(决策 1 / 18)", () => {
	it("两支都以订阅 id 为键,身份是同一种形状:B 站来源键是 bilibili、外部 id 是 uid,拓展来源键是拓展 id", async () => {
		const body = await get(
			makeDeps({ bili: [{ id: B1, uid: "42" }], ext: [{ id: E1, externalId: "MS4wLjAB/甲" }] }),
		);
		expect(body.rows.map((r) => r.subscriptionId)).toEqual([B1, E1]);
		const bili = rowOf(body, B1);
		expect(bili.identity).toEqual({ sourceKey: "bilibili", externalId: "42" });
		const ext = rowOf(body, E1);
		expect(ext.identity).toEqual({ sourceKey: EXT, externalId: "MS4wLjAB/甲" });
		// 三格旧键都没了,身份只剩这一格。
		for (const r of [bili, ext]) {
			expect("uid" in r || "extensionId" in r || "externalId" in r).toBe(false);
		}
	});

	it("停用的、拓展没在跑的拓展订阅照样列着 —— 它们仍是订阅(同 B 站停用的照样列)", async () => {
		// 拓展在不在跑,路由压根不问:订阅在就有一行。
		const body = await get(
			makeDeps({
				bili: [{ id: B1, uid: "42", enabled: false }],
				ext: [{ id: E1 }, { id: E2, enabled: false }],
			}),
		);
		expect(body.rows.map((r) => r.subscriptionId)).toEqual([B1, E1, E2]);
	});
});

describe("拓展行:计数、场次、峰值与 B 站同一套聚合", () => {
	it("按订阅 id 从仓里取作品与场次;峰值两格改名 maxViewers / avgViewers", async () => {
		const body = await get(
			makeDeps({
				ext: [{ id: E1 }],
				seen: { [E1]: everyDay(5).map((ts) => ({ ts })) },
				posts: {
					[E1]: [
						{ id: "v1", hasVideo: true, publishedAt: at(3) },
						{ id: "p1", hasVideo: false, publishedAt: at(2) },
						{ id: "p2", hasVideo: false, publishedAt: at(1, 2) },
						// 窗口外的不算。
						{ id: "old", hasVideo: true, publishedAt: at(40) },
					],
				},
				sessions: {
					[E1]: [
						{ startedAt: at(3, 4), endedAt: at(3, 2), peakTotalViewers: 100 },
						{ startedAt: at(2, 5), endedAt: at(2, 2), peakTotalViewers: 300 },
						// 没采到累计观看的一场不进最高与平均。
						{ startedAt: at(1, 6), endedAt: at(1, 5) },
					],
				},
			}),
		);
		const row = rowOf(body, E1);
		expect(row).toMatchObject({
			videoPosts: 1,
			posts: 3,
			liveSessions: 3,
			liveHours: 6,
			liveTimedSessions: 3,
			maxViewers: 300,
			avgViewers: 200,
			lastActivityAt: at(1, 2),
			live: false,
		});
		expect("peakViewers" in row || "avgPeakViewers" in row).toBe(false);
		// 热力图:每天都有「在记」,活动照数(作品一条算一次,场次在开播那天算一次)。
		expect(row.activity).toEqual([0, 2, 2, 2, 0]);
	});
});

describe("拓展行:「那天有记录」看它自己的「在记」(决策 9)", () => {
	it("第一条「在记」之前没有 0;之后没「在记」的那天(BN 没跑)也是无记录 —— 账说了算,盘上有作品也不例外", async () => {
		// 日轴 05-11 .. 05-16。「在记」在 05-13、05-15、05-16 —— 05-13 是开始记录那天,05-14 BN 没跑。
		// 05-11 那条作品发在开始记录之前:那天账里没有,是无记录(计数仍有数,因为窗口里别的日子在记)。
		const body = await get(
			makeDeps({
				ext: [{ id: E1 }],
				seen: { [E1]: [{ ts: at(3) }, { ts: at(1) }, { ts: at(1, -1) }, { ts: at(0) }] },
				posts: {
					[E1]: [
						{ id: "early", hasVideo: false, publishedAt: at(5) },
						{ id: "v", hasVideo: true, publishedAt: at(1, 3) },
					],
				},
			}),
			"?days=6&tz=0",
		);
		const row = rowOf(body, E1);
		expect(row.activity).toEqual([null, null, 0, null, 1, 0]);
		expect(row.videoPosts).toBe(1);
		expect(row.posts).toBe(2);
	});

	it("一条「在记」都没有 → 热力图全是无记录、计数是 null,哪怕 B 站那几位天天在采", async () => {
		// B 站的粉丝采样只证明 B 站那头在看着,证明不了我们在记这一位拓展订阅。
		const body = await get(
			makeDeps({
				bili: [{ id: B1, uid: "42" }],
				samples: { [B1]: everyDay(5).map((sampledAt, i) => ({ sampledAt, followers: 1000 + i })) },
				recordedBySamples: [B1],
				ext: [{ id: E1 }],
			}),
		);
		const row = rowOf(body, E1);
		expect(row.activity).toEqual([null, null, null, null, null]);
		expect(row.videoPosts).toBeNull();
		expect(row.posts).toBeNull();
		expect(row.liveSessions).toBeNull();
		expect(row.liveHours).toBeNull();
		expect(row.liveTimedSessions).toBeNull();
		expect(row.followers).toBeNull();
		// B 站那一行照旧是 0,不受牵连。
		expect(rowOf(body, B1).activity).toEqual([0, 0, 0, 0, 0]);
	});

	it("不借 B 站的覆盖:B 站天天在记,拓展行账里没有就全是无记录(盘上有作品也不算)", async () => {
		const body = await get(
			makeDeps({
				bili: [{ id: B1, uid: "42" }],
				samples: { [B1]: everyDay(5).map((sampledAt, i) => ({ sampledAt, followers: 1000 + i })) },
				recordedBySamples: [B1],
				ext: [{ id: E1 }],
				posts: { [E1]: [{ id: "p", hasVideo: false, publishedAt: at(2) }] },
			}),
		);
		const row = rowOf(body, E1);
		expect(row.activity).toEqual([null, null, null, null, null]);
		expect(row.posts).toBeNull();
		expect(row.videoPosts).toBeNull();
	});

	it("B 站也不借拓展的:拓展的「在记」与粉丝样本不让 B 站行那天算有记录", async () => {
		// B 站没登录、账里没有这一位 → 全是无记录。
		const body = await get(
			makeDeps({
				bili: [{ id: B1, uid: "42" }],
				posts: { [B1]: [{ id: "d", hasVideo: false, publishedAt: at(0) }] },
				ext: [{ id: E1 }],
				seen: { [E1]: everyDay(5).map((ts) => ({ ts })) },
				samples: { [E1]: everyDay(5).map((sampledAt, i) => ({ sampledAt, followers: 10 + i })) },
			}),
		);
		expect(rowOf(body, B1).activity).toEqual([null, null, null, null, null]);
	});

	it("一条 B 站订阅都没有、粉丝轮询没起来 —— 拓展行照常出数", async () => {
		const body = await get(
			makeDeps({
				ext: [{ id: E1 }],
				seen: { [E1]: everyDay(3).map((ts) => ({ ts })) },
				samples: {
					[E1]: everyDay(3).map((sampledAt, i) => ({ sampledAt, followers: 500 + 10 * i })),
				},
				posts: { [E1]: [{ id: "v", hasVideo: true, publishedAt: at(1) }] },
			}),
		);
		const row = rowOf(body, E1);
		expect(row.activity).toEqual([null, null, 0, 1, 0]);
		expect(row.videoPosts).toBe(1);
		expect(row.followers).toBe(520);
		expect(row.netWindow).toBe(20);
	});
});

describe("拓展行:粉丝(决策 8)", () => {
	it("平台不报粉丝数 → 粉丝那几格全是 null,其余照常", async () => {
		const body = await get(
			makeDeps({
				ext: [{ id: E1 }],
				seen: { [E1]: everyDay(5).map((ts) => ({ ts })) },
			}),
		);
		const row = rowOf(body, E1);
		expect(row.followers).toBeNull();
		expect(row.net1d).toBeNull();
		expect(row.net7d).toBeNull();
		expect(row.netWindow).toBeNull();
		expect(row.series).toEqual([null, null, null, null, null]);
		expect(row.cumulative).toEqual([null, null, null, null, null]);
		expect(row.activity).toEqual([0, 0, 0, 0, 0]);
	});

	it("当前粉丝取资料缓存(比样本新);停用的退回样本末值 —— 同 B 站的快照不含停用的", async () => {
		const samples = everyDay(5).map((sampledAt, i) => ({ sampledAt, followers: 1000 + 100 * i }));
		const body = await get(
			makeDeps({
				ext: [{ id: E1 }, { id: E2, enabled: false }],
				seen: { [E1]: everyDay(5).map((ts) => ({ ts })) },
				samples: { [E1]: samples, [E2]: samples },
				profileFans: { [E1]: 2000, [E2]: 2000 },
			}),
		);
		const on = rowOf(body, E1);
		expect(on.followers).toBe(2000);
		// 曲线与净增只来自样本。
		expect(on.cumulative).toEqual([1000, 1100, 1200, 1300, 1400]);
		expect(on.netWindow).toBe(400);
		expect(rowOf(body, E2).followers).toBe(1400);
	});
});

describe("拓展行:在播(决策 6)", () => {
	it("场次模块手里有这一场 → live=true,这一场的时长算到现在;没有的那条同样的帧不计时长", async () => {
		// 盘上两条一模一样的敞着的场次:一条真在播,一条是崩溃遗留(下播帧没写成)。
		const open: LiveSessionEntry[] = [{ startedAt: at(0, 2), current: true }];
		const body = await get(
			makeDeps({
				ext: [{ id: E1 }, { id: E2 }],
				seen: { [E1]: [{ ts: at(0) }], [E2]: [{ ts: at(0) }] },
				sessions: { [E1]: open, [E2]: open },
				liveExt: new Set([E1]),
			}),
		);
		expect(rowOf(body, E1)).toMatchObject({
			live: true,
			liveSessions: 1,
			liveHours: 2,
			liveTimedSessions: 1,
		});
		expect(rowOf(body, E2)).toMatchObject({
			live: false,
			liveSessions: 1,
			liveHours: 0,
			liveTimedSessions: 0,
		});
	});

	it("引擎没挂上 → 拓展行一律不在播,不报错", async () => {
		const body = await get(makeDeps({ ext: [{ id: E1 }], engines: false, liveExt: new Set([E1]) }));
		expect(rowOf(body, E1).live).toBe(false);
	});
});

describe("拓展行:缓存键", () => {
	/** 缓存挂在路由实例上,所以复用同一个 route。 */
	const call = async (route: ReturnType<typeof createStatsRoute>) =>
		(await (await route.request("/overview?days=5&tz=0")).json()) as StatsOverviewResponse;

	it("拓展开播了 / 报了新的粉丝数,不吃 30 秒内的旧缓存", async () => {
		// 两样都是内存状态、不经 jsonl,与 B 站的在播 / 粉丝快照同理必须进键。
		const f: Fixture = {
			ext: [{ id: E1 }],
			seen: { [E1]: [{ ts: at(0) }] },
			profileFans: { [E1]: 100 },
			liveExt: new Set(),
		};
		const route = createStatsRoute(makeDeps(f));
		expect(rowOf(await call(route), E1)).toMatchObject({ live: false, followers: 100 });
		f.liveExt?.add(E1);
		expect(rowOf(await call(route), E1).live).toBe(true);
		f.profileFans = { [E1]: 150 };
		expect(rowOf(await call(route), E1).followers).toBe(150);
	});

	it("什么都没变时照常命中缓存", async () => {
		let reads = 0;
		const deps = makeDeps({ ext: [{ id: E1 }], seen: { [E1]: [{ ts: at(0) }] } });
		const inner = deps.runtime.statsStore.listRecording;
		deps.runtime.statsStore.listRecording = async (key: string, since: string) => {
			reads++;
			return inner(key, since);
		};
		const route = createStatsRoute(deps);
		await call(route);
		const after = reads;
		expect(after).toBeGreaterThan(0);
		await call(route);
		expect(reads).toBe(after);
	});
});

describe("整份响应逐字段钉住(一条 B 站订阅 + 一条拓展订阅,每一格都有非平凡的值)", () => {
	// 验红:把 routes/stats.ts 成行处的 `posts: hasCoverage ? counts.posts : null` 改成取 counts.videoPosts,本条红。
	it("GET /overview 的完整返回", async () => {
		const body = await get(
			makeDeps({
				bili: [{ id: B1, uid: "42" }],
				recordedBySamples: [B1],
				ext: [{ id: E1, externalId: "MS4wLjAB/甲" }],
				fansEntries: [{ subscriptionId: B1, uid: "42", current: 1060 }],
				profileFans: { [E1]: 540 },
				liveExt: new Set([E1]),
				samples: {
					// 05-13 有两个样本,取日末值 1010;05-14 没有样本。窗口之前的样本不在夹具里 → 首日没有基线。
					[B1]: [
						{ sampledAt: at(4), followers: 1000 },
						{ sampledAt: at(3, 3), followers: 1005 },
						{ sampledAt: at(3), followers: 1010 },
						{ sampledAt: at(1), followers: 1030 },
						{ sampledAt: at(0, 2), followers: 1050 },
					],
					[E1]: [
						{ sampledAt: at(3), followers: 500 },
						{ sampledAt: at(2), followers: 520 },
						{ sampledAt: at(0, 2), followers: 530 },
					],
				},
				posts: {
					[B1]: [
						{ id: "v1", hasVideo: true, publishedAt: at(3) },
						{ id: "p1", hasVideo: false, publishedAt: at(2) },
						{ id: "p2", hasVideo: false, publishedAt: at(1, 2) },
					],
					[E1]: [
						{ id: "ev", hasVideo: true, publishedAt: at(4) },
						{ id: "ep", hasVideo: false, publishedAt: at(0, 5) },
					],
				},
				sessions: {
					[B1]: [
						{ startedAt: at(3, 4), endedAt: at(3, 2), peakTotalViewers: 1200 },
						{ startedAt: at(1, 8), endedAt: at(1, 5), peakTotalViewers: 800 },
					],
					[E1]: [
						{ startedAt: at(2, 6), endedAt: at(2, 4), peakTotalViewers: 500 },
						// 仍在进行的一场:时长按开播到现在(1 小时)算,没有累计观看。
						{ startedAt: at(0, 1), current: true },
					],
				},
				seen: { [E1]: [{ ts: at(4) }, { ts: at(2) }, { ts: at(0, 3) }] },
			}),
		);
		expect(body).toStrictEqual({
			days: 5,
			rows: [
				{
					subscriptionId: B1,
					identity: { sourceKey: "bilibili", externalId: "42" },
					followers: 1060,
					net1d: 20,
					net7d: null,
					netWindow: 50,
					series: [null, 10, null, 20, 20],
					cumulative: [1000, 1010, null, 1030, 1050],
					activity: [0, 2, null, 2, 0],
					recording: {
						posts: [true, true, false, true, true],
						live: [true, true, false, true, true],
						followers: [true, true, false, true, true],
					},
					videoPosts: 1,
					posts: 3,
					liveSessions: 2,
					liveHours: 5,
					liveTimedSessions: 2,
					maxViewers: 1200,
					avgViewers: 1000,
					// 最晚的一条作品(p2);开播公告不再记,它不再顶着「最后活动」。
					lastActivityAt: at(1, 2),
					live: false,
				},
				{
					subscriptionId: E1,
					identity: { sourceKey: EXT, externalId: "MS4wLjAB/甲" },
					followers: 540,
					net1d: 10,
					net7d: null,
					netWindow: 30,
					series: [null, null, 20, null, 10],
					cumulative: [null, 500, 520, null, 530],
					activity: [1, null, 1, null, 2],
					recording: {
						posts: [true, false, true, false, true],
						live: [true, false, true, false, true],
						followers: [false, false, false, false, false],
					},
					videoPosts: 1,
					posts: 2,
					liveSessions: 2,
					liveHours: 3,
					liveTimedSessions: 2,
					maxViewers: 500,
					avgViewers: 500,
					lastActivityAt: at(0, 1),
					live: true,
				},
			],
		});
	});
});
