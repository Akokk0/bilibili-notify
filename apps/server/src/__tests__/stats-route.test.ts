/**
 * 路由测试 — `GET /api/stats/overview`。
 *
 * 重点守护三件事:窗口 clamp、`null` 语义(无记录 ≠ 0)、以及 30s 缓存不会把
 * 「切换时间范围」也缓存串味。
 */

import type { StatsOverviewResponse } from "@bilibili-notify/contract";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createStatsRoute, MAX_CACHE_ENTRIES } from "../routes/stats.js";
import type { RouteDeps } from "../routes/types.js";
import type { RecordingEntry, RecordingKind } from "../stats/store.js";

const DAY = 86_400_000;
/** 固定"现在",让每日分桶可预期。 */
const NOW = Date.UTC(2026, 4, 16, 12, 0, 0);

interface Fixture {
	subs?: Array<{ uid: string; enabled?: boolean }>;
	samples?: Record<string, Array<{ sampledAt: string; followers: number }>>;
	posts?: Record<string, Array<{ id: string; hasVideo: boolean; publishedAt: string }>>;
	sessions?: Record<
		string,
		Array<{ startedAt: string; endedAt?: string; peakTotalViewers?: number }>
	>;
	liveSubscriptions?: string[];
	/** 资料缓存里的当前粉丝数,按 uid 写(好读)。 */
	profileFans?: Record<string, number>;
	/**
	 * 「在记」账,按 uid 写。缺省(整个字段不写)= 每位订阅三项都从很早以前一直在记;写 `{}` = 谁都没在记;
	 * 某位不在表里 = 这位什么都没记。
	 */
	recording?: Record<string, RecordingEntry[]>;
}

/**
 * 夹具按 uid 写(好读),两个仓却按**订阅 id** 分文件(ADR-0020 决策 2 的 🔗)。订阅 id 取
 * `id-<uid>`,mock 的仓按它查回夹具 —— 路由拿 uid 去读的话一样都读不到。
 */
const subId = (uid: string) => `id-${uid}`;

/** 一项在某段时间里一直在记。 */
const span = (kind: RecordingKind, fromMs: number, toMs: number): RecordingEntry => ({
	kind,
	startedAt: new Date(fromMs).toISOString(),
	endedAt: new Date(toMs).toISOString(),
});
const ALWAYS: RecordingEntry[] = (["posts", "live", "followers"] as const).map((kind) =>
	span(kind, NOW - 400 * 86_400_000, NOW + 86_400_000),
);
const uidOf = (key: string) => (key.startsWith("id-") ? key.slice(3) : `(不是订阅 id:${key})`);

function makeDeps(f: Fixture): RouteDeps {
	return {
		runtime: {
			fansStore: {
				listSamplesSince: async (key: string) => f.samples?.[uidOf(key)] ?? [],
				// 与真仓一致:替身手里这条订阅的样本里,不晚于入参时刻的最近一条;没有就 undefined。
				findNearestBefore: async (key: string, iso: string) =>
					(f.samples?.[uidOf(key)] ?? []).filter((s) => s.sampledAt <= iso).at(-1),
			},
			statsStore: {
				listPosts: async (key: string) => f.posts?.[uidOf(key)] ?? [],
				listLiveSessions: async (key: string) => f.sessions?.[uidOf(key)] ?? [],
				listRecording: async (key: string) =>
					f.recording?.[uidOf(key)] ?? (f.recording ? [] : ALWAYS),
			},
			engines: f.liveSubscriptions
				? {
						liveSession: (id: string) =>
							f.liveSubscriptions?.includes(id) ? { subscriptionId: id } : undefined,
					}
				: null,
			subRuntimeStore: {
				get: (id: string) => {
					const fans = f.profileFans?.[uidOf(id)];
					return fans === undefined ? undefined : { cachedProfile: { fans } };
				},
			},
		},
		store: {
			getSubscriptions: () =>
				(f.subs ?? []).map(({ uid, ...s }) => ({
					id: subId(uid),
					identity: { sourceKey: "bilibili", externalId: uid },
					enabled: true,
					...s,
				})),
		},
		puppeteer: null,
		wsTicketStore: null,
	} as unknown as RouteDeps;
}

const get = async (deps: RouteDeps, qs = ""): Promise<StatsOverviewResponse> => {
	const res = await createStatsRoute(deps).request(`/overview${qs}`);
	expect(res.status).toBe(200);
	return (await res.json()) as StatsOverviewResponse;
};

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});

describe("GET /api/stats/overview — 窗口参数", () => {
	it("缺省 30 天", async () => {
		const body = await get(makeDeps({}));
		expect(body.days).toBe(30);
	});

	it("days 被 clamp 到 1..90", async () => {
		expect((await get(makeDeps({}), "?days=999")).days).toBe(90);
		expect((await get(makeDeps({}), "?days=0")).days).toBe(1);
		expect((await get(makeDeps({}), "?days=abc")).days).toBe(30);
	});

	it("series 长度恒等于 days", async () => {
		const body = await get(makeDeps({ subs: [{ uid: "1" }] }), "?days=7");
		expect(body.rows[0]?.series).toHaveLength(7);
	});
});

describe("GET /api/stats/overview — null 语义", () => {
	it("从未采样的 UP:fans 与各窗口净增全为 null,不是 0", async () => {
		const body = await get(makeDeps({ subs: [{ uid: "1" }] }));
		const row = body.rows[0];
		expect(row?.followers).toBeNull();
		expect(row?.net1d).toBeNull();
		expect(row?.net7d).toBeNull();
		expect(row?.netWindow).toBeNull();
	});

	it("动态比开播更晚时取动态 —— 缺这个方向,整段三元换成 `lastLive ?? lastDynamic` 也全绿", async () => {
		// 原有四条用例:两者皆空 / 开播更晚 / 只有动态 / 只有开播 —— 唯独没有
		// 「两者都有且动态更晚」。今天刚发动态、上次开播在三天前的 UP,退化实现会
		// 把 lastActivityAt 读成三天前,正好误判进鸽子榜,而那正是这个字段的唯一用途。
		const body = await get(
			makeDeps({
				subs: [{ uid: "1" }],
				posts: {
					"1": [{ id: "d", hasVideo: true, publishedAt: new Date(NOW - 3600_000).toISOString() }],
				},
				sessions: { "1": [{ startedAt: new Date(NOW - 3 * DAY).toISOString() }] },
			}),
		);
		expect(body.rows[0]?.lastActivityAt).toBe(new Date(NOW - 3600_000).toISOString());
	});

	it("没有任何活动 → lastActivityAt 为 null(鸽子榜要的信号)", async () => {
		const body = await get(makeDeps({ subs: [{ uid: "1" }] }));
		expect(body.rows[0]?.lastActivityAt).toBeNull();
	});

	it("窗口内毫无采集覆盖 → 计数是 null 而不是 0", async () => {
		// 「0」是我们在记、他确实没发;「null」是我们没在记。用 0 顶替会让老库升级后
		// 的近 90 日视图把一位高产 UP 显示成「投稿 0 个」,而同一行热力图正画着
		// 一片「无记录」——两个数在同一屏里互相打脸。
		const body = await get(makeDeps({ subs: [{ uid: "1" }], recording: {} }));
		expect(body.rows[0]?.videoPosts).toBeNull();
		expect(body.rows[0]?.posts).toBeNull();
		expect(body.rows[0]?.liveSessions).toBeNull();
		expect(body.rows[0]?.liveHours).toBeNull();
		expect(body.rows[0]?.liveTimedSessions).toBeNull();
	});

	it("有采集覆盖但那几天真没发 → 计数是 0,不是 null", async () => {
		// 这条是上一条的对偶,缺了它「一律返回 null」也能全绿。
		const body = await get(
			makeDeps({
				subs: [{ uid: "1" }],
				samples: { "1": [{ sampledAt: new Date(NOW).toISOString(), followers: 100 }] },
			}),
		);
		expect(body.rows[0]?.videoPosts).toBe(0);
		expect(body.rows[0]?.posts).toBe(0);
		expect(body.rows[0]?.liveSessions).toBe(0);
	});
});

describe("GET /api/stats/overview — 窗口净增口径", () => {
	/** 连续 n+1 天每天一条采样,每天恰好 +100。 */
	const rising = (n: number) =>
		Array.from({ length: n + 1 }, (_, i) => ({
			sampledAt: new Date(NOW - (n - i) * DAY).toISOString(),
			followers: 1000 + i * 100,
		}));

	it("netWindow 覆盖整个请求窗口 —— 旧的 net30d 无论选 7/30/90 都只加 30 天", async () => {
		const deps = makeDeps({ subs: [{ uid: "1" }], samples: { "1": rising(40) } });
		expect((await get(deps, "?days=7")).rows[0]?.netWindow).toBe(700);
		expect((await get(deps, "?days=90")).rows[0]?.netWindow).toBe(4000);
	});

	it("net7d 恒为 7 天口径,不随窗口变", async () => {
		const deps = makeDeps({ subs: [{ uid: "1" }], samples: { "1": rising(40) } });
		expect((await get(deps, "?days=30")).rows[0]?.net7d).toBe(700);
		expect((await get(deps, "?days=90")).rows[0]?.net7d).toBe(700);
	});

	it("窗口比 7 天还短时 net7d 为 null —— 窗口里根本没有 7 天数据可加", async () => {
		const deps = makeDeps({ subs: [{ uid: "1" }], samples: { "1": rising(40) } });
		expect((await get(deps, "?days=1")).rows[0]?.net7d).toBeNull();
		expect((await get(deps, "?days=1")).rows[0]?.netWindow).toBe(100);
	});
});

describe("GET /api/stats/overview — 数据投影", () => {
	it("fans 优先取资料缓存(比 jsonl 末行新)", async () => {
		const deps = makeDeps({
			subs: [{ uid: "1" }],
			samples: { "1": [{ sampledAt: new Date(NOW - DAY).toISOString(), followers: 100 }] },
			profileFans: { "1": 175 },
		});
		expect((await get(deps)).rows[0]?.followers).toBe(175);
	});

	it("poller 未就绪时回退到采样末值", async () => {
		const deps = makeDeps({
			subs: [{ uid: "1" }],
			samples: { "1": [{ sampledAt: new Date(NOW - DAY).toISOString(), followers: 100 }] },
		});
		expect((await get(deps)).rows[0]?.followers).toBe(100);
	});

	it("投稿与动态按有没有视频分栏", async () => {
		const ts = new Date(NOW - DAY).toISOString();
		const deps = makeDeps({
			subs: [{ uid: "1" }],
			posts: {
				"1": [
					{ id: "a", hasVideo: true, publishedAt: ts },
					{ id: "b", hasVideo: false, publishedAt: ts },
				],
			},
		});
		const row = (await get(deps)).rows[0];
		expect(row?.videoPosts).toBe(1);
		expect(row?.posts).toBe(2);
	});

	it("posts 是全部作品、videoPosts 是其中带视频的:3 条带视频 + 5 条不带 → videoPosts 3、posts 8", async () => {
		// 口径从「投稿 / 动态各算各的」改成「全部 / 其中带视频」:动态不再单独回,面板用 posts − videoPosts 算。
		const ts = new Date(NOW - DAY).toISOString();
		const post = (id: string, hasVideo: boolean) => ({ id, hasVideo, publishedAt: ts });
		const deps = makeDeps({
			subs: [{ uid: "1" }],
			posts: {
				"1": [
					...["v1", "v2", "v3"].map((id) => post(id, true)),
					...["p1", "p2", "p3", "p4", "p5"].map((id) => post(id, false)),
				],
			},
		});
		const row = (await get(deps)).rows[0];
		expect(row?.videoPosts).toBe(3);
		expect(row?.posts).toBe(8);
	});

	it("直播中的 UP 标记 live=true", async () => {
		const deps = makeDeps({
			subs: [{ uid: "1" }, { uid: "2" }],
			liveSubscriptions: ["id-1"],
		});
		const body = await get(deps);
		expect(body.rows.find((r) => r.identity.externalId === "1")?.live).toBe(true);
		expect(body.rows.find((r) => r.identity.externalId === "2")?.live).toBe(false);
	});

	it("lastActivityAt 取动态与开播里更晚的那个", async () => {
		const early = new Date(NOW - 3 * DAY).toISOString();
		const late = new Date(NOW - DAY).toISOString();
		const deps = makeDeps({
			subs: [{ uid: "1" }],
			posts: { "1": [{ id: "a", hasVideo: false, publishedAt: early }] },
			sessions: { "1": [{ startedAt: late, endedAt: late }] },
		});
		expect((await get(deps)).rows[0]?.lastActivityAt).toBe(late);
	});

	it("动态落盘顺序与发布时间不一致时,lastActivityAt 仍取最晚的一条", async () => {
		// listPosts 的契约是「按落盘顺序」= 检测顺序,而 B 站动态流按惯例
		// 最新在前 —— 一轮检测到多条时,最后落盘的反而是这批里最旧的那条。
		// 取末元素会读出错的时间,必须按 ts 比较。
		const older = new Date(NOW - 3 * DAY).toISOString();
		const newer = new Date(NOW - DAY).toISOString();
		const deps = makeDeps({
			subs: [{ uid: "1" }],
			posts: {
				"1": [
					{ id: "new", hasVideo: false, publishedAt: newer },
					{ id: "old", hasVideo: false, publishedAt: older },
				],
			},
		});
		expect((await get(deps)).rows[0]?.lastActivityAt).toBe(newer);
	});

	it("直播场次顺序不单调时,lastActivityAt 同样取最晚的一场", async () => {
		// `listLiveSessions` 的实现按「首次出现顺序」返回,而场次是按 startedAt
		// 认的 —— 被重新打开的早场次未必排在末尾。动态那侧早就按 ts 比较了,
		// 直播这侧曾取末元素,顺序一歪就会把刚播完的 UP 算进「鸽子榜」。
		const older = new Date(NOW - 3 * DAY).toISOString();
		const newer = new Date(NOW - DAY).toISOString();
		const deps = makeDeps({
			subs: [{ uid: "1" }],
			sessions: { "1": [{ startedAt: newer, endedAt: newer }, { startedAt: older }] },
		});
		expect((await get(deps)).rows[0]?.lastActivityAt).toBe(newer);
	});
});

describe("GET /api/stats/overview — 「在记」账", () => {
	const HOUR = 3_600_000;
	/** 北京时间(UTC+8)2026-05-16 的零点 = UTC 15 日 16:00。 */
	const CN_MIDNIGHT = Date.UTC(2026, 4, 15, 16, 0, 0);

	it("账里什么都没有 → 整行「无记录」:热力图全 null、计数全 null、recording 全 false", async () => {
		const deps = makeDeps({
			subs: [{ uid: "1" }],
			samples: { "1": [{ sampledAt: new Date(NOW).toISOString(), followers: 1 }] },
			posts: { "1": [{ id: "a", hasVideo: true, publishedAt: new Date(NOW).toISOString() }] },
			recording: {},
		});
		const row = (await get(deps, "?days=3")).rows[0];
		expect(row?.activity).toEqual([null, null, null]);
		expect(row?.recording).toEqual({
			posts: [false, false, false],
			live: [false, false, false],
			followers: [false, false, false],
		});
		expect(row?.videoPosts).toBeNull();
		expect(row?.liveSessions).toBeNull();
		expect(row?.maxViewers).toBeNull();
	});

	it("作品开着直播关着:作品那几格有数、直播那几格 null,recording 三个数组逐天对", async () => {
		const deps = makeDeps({
			subs: [{ uid: "1" }],
			posts: {
				"1": [{ id: "a", hasVideo: true, publishedAt: new Date(NOW - DAY).toISOString() }],
			},
			sessions: {
				"1": [
					{
						startedAt: new Date(NOW - DAY).toISOString(),
						endedAt: new Date(NOW - DAY + HOUR).toISOString(),
						peakTotalViewers: 500,
					},
				],
			},
			recording: {
				// 作品:前天起在记;粉丝:只有今天;直播:没有。
				"1": [span("posts", NOW - 2 * DAY, NOW + DAY), span("followers", NOW - HOUR, NOW)],
			},
		});
		const row = (await get(deps, "?days=4")).rows[0];
		expect(row?.recording).toEqual({
			posts: [false, true, true, true],
			live: [false, false, false, false],
			followers: [false, false, false, true],
		});
		expect(row?.videoPosts).toBe(1);
		expect(row?.posts).toBe(1);
		// 直播没在记:场次与观看都是 null(盘上有场次也不算)。
		expect(row?.liveSessions).toBeNull();
		expect(row?.liveHours).toBeNull();
		expect(row?.liveTimedSessions).toBeNull();
		expect(row?.maxViewers).toBeNull();
		expect(row?.avgViewers).toBeNull();
		// 活动:只数在记的那几项 —— 昨天作品在记(1 条),直播不在记所以那场不加;没在记的头一天是 null。
		expect(row?.activity).toEqual([null, 0, 1, 0]);
	});

	it("某天作品与直播各有一项在记:活动是在记的那几项的计数之和", async () => {
		const deps = makeDeps({
			subs: [{ uid: "1" }],
			posts: {
				"1": [
					{ id: "a", hasVideo: false, publishedAt: new Date(NOW - DAY).toISOString() },
					{ id: "b", hasVideo: false, publishedAt: new Date(NOW - DAY + HOUR).toISOString() },
				],
			},
			sessions: { "1": [{ startedAt: new Date(NOW - DAY).toISOString() }] },
		});
		// 缺省三项都在记:2 条作品 + 1 场开播。
		expect((await get(deps, "?days=3")).rows[0]?.activity).toEqual([0, 3, 0]);
		const postsOnly = makeDeps({
			subs: [{ uid: "1" }],
			posts: {
				"1": [{ id: "a", hasVideo: false, publishedAt: new Date(NOW - DAY).toISOString() }],
			},
			sessions: { "1": [{ startedAt: new Date(NOW - DAY).toISOString() }] },
			recording: { "1": [span("posts", NOW - 5 * DAY, NOW + DAY)] },
		});
		expect((await get(postsOnly, "?days=3")).rows[0]?.activity).toEqual([0, 1, 0]);
	});

	it("那天没在记就是 null,哪怕盘上那天有作品 —— 账说了算,不再拿作品当铁证", async () => {
		const deps = makeDeps({
			subs: [{ uid: "1" }],
			posts: {
				"1": [{ id: "a", hasVideo: false, publishedAt: new Date(NOW - 3 * DAY).toISOString() }],
			},
			recording: { "1": [span("posts", NOW - DAY, NOW + DAY)] },
		});
		const row = (await get(deps, "?days=5")).rows[0];
		expect(row?.activity).toEqual([null, null, null, 0, 0]);
	});

	it("日界跟着请求的时区走:账里一个跨 UTC 零点的小时,在两个时区下落到不同的天", async () => {
		// 账只有一行:UTC 5 月 15 日 23:00 - 5 月 16 日 01:00(两个小时,跨 UTC 零点)。
		const entry = span("posts", Date.UTC(2026, 4, 15, 23, 0, 0), Date.UTC(2026, 4, 16, 1, 0, 0));
		const mk = () => makeDeps({ subs: [{ uid: "1" }], recording: { "1": [entry] } });
		// UTC:两个小时分属 15 日与 16 日 → 窗口最后两天都在记(今天是 16 日)。
		expect((await get(mk(), "?days=3&tz=0")).rows[0]?.recording.posts).toEqual([false, true, true]);
		// UTC+8:这段在本地是 5 月 16 日 07:00 - 09:00,只落在 16 日一天。
		expect((await get(mk(), "?days=3&tz=-480")).rows[0]?.recording.posts).toEqual([
			false,
			false,
			true,
		]);
		// UTC-5(tz=300):本地 15 日 18:00 - 20:00,落在 15 日一天,今天(16 日)没有。
		expect((await get(mk(), "?days=3&tz=300")).rows[0]?.recording.posts).toEqual([
			false,
			true,
			false,
		]);
	});

	it("读得了任意长度的区间、重复行与重叠行", async () => {
		const deps = makeDeps({
			subs: [{ uid: "1" }],
			recording: {
				"1": [
					span("posts", CN_MIDNIGHT - 10 * DAY, CN_MIDNIGHT - 8 * DAY), // 一段长区间
					span("posts", CN_MIDNIGHT - 10 * DAY, CN_MIDNIGHT - 8 * DAY), // 重复
					span("posts", CN_MIDNIGHT - 9 * DAY, CN_MIDNIGHT - 8 * DAY + HOUR), // 重叠
					span("posts", NOW - HOUR, NOW), // 一个整点小时
					span("posts", NOW - HOUR, NOW), // 重复
				],
			},
		});
		const row = (await get(deps, "?days=11&tz=-480")).rows[0];
		// 本地 6 日 - 8 日(长区间 + 重叠的那段延到 8 日 01:00)在记,9 日 - 15 日空着,今天有那个整点小时。
		expect(row?.recording.posts).toEqual([
			true,
			true,
			true,
			false,
			false,
			false,
			false,
			false,
			false,
			false,
			true,
		]);
	});
});

describe("GET /api/stats/overview — 缓存", () => {
	it("同参数二次请求走缓存,不重复读盘", async () => {
		const listSamplesSince = vi.fn(async () => []);
		const deps = makeDeps({ subs: [{ uid: "1" }] });
		(deps.runtime as unknown as { fansStore: unknown }).fansStore = {
			listSamplesSince,
			findNearestBefore: async () => undefined,
		};
		const app = createStatsRoute(deps);
		await app.request("/overview?days=30");
		await app.request("/overview?days=30");
		expect(listSamplesSince).toHaveBeenCalledTimes(1);
	});

	it("换了 days 就不吃上一份缓存", async () => {
		const listSamplesSince = vi.fn(async () => []);
		const deps = makeDeps({ subs: [{ uid: "1" }] });
		(deps.runtime as unknown as { fansStore: unknown }).fansStore = {
			listSamplesSince,
			findNearestBefore: async () => undefined,
		};
		const app = createStatsRoute(deps);
		await app.request("/overview?days=30");
		await app.request("/overview?days=7");
		expect(listSamplesSince).toHaveBeenCalledTimes(2);
	});

	it("TTL 过期后重新读盘", async () => {
		const listSamplesSince = vi.fn(async () => []);
		const deps = makeDeps({ subs: [{ uid: "1" }] });
		(deps.runtime as unknown as { fansStore: unknown }).fansStore = {
			listSamplesSince,
			findNearestBefore: async () => undefined,
		};
		const app = createStatsRoute(deps);
		await app.request("/overview?days=30");
		vi.setSystemTime(NOW + 31_000);
		await app.request("/overview?days=30");
		expect(listSamplesSince).toHaveBeenCalledTimes(2);
	});

	it("条目数有上限 —— 换着参数刷不会让缓存无限涨", async () => {
		// days×tz 的组合空间有 15 万种,每份都装着全部 UP 的整段序列。没有上限的话
		// 换着参数刷就能把独立端(Docker 堆上限 512MB)顶爆。
		const listSamplesSince = vi.fn(async () => []);
		const deps = makeDeps({ subs: [{ uid: "1" }] });
		(deps.runtime as unknown as { fansStore: unknown }).fansStore = {
			listSamplesSince,
			findNearestBefore: async () => undefined,
		};
		const app = createStatsRoute(deps);

		// 塞满并溢出:tz 各不相同,全都在 TTL 内。
		for (let i = 0; i <= MAX_CACHE_ENTRIES; i++) await app.request(`/overview?days=30&tz=${i}`);
		const afterFill = listSamplesSince.mock.calls.length;

		// 最早那条应已被挤掉 —— 再问一次必须重新读盘。
		await app.request("/overview?days=30&tz=0");
		expect(listSamplesSince.mock.calls.length).toBe(afterFill + 1);
	});
});

describe("POST /api/stats/roast/:subscriptionId — 单 UP 锐评", () => {
	/** AI 没启用时的 deps —— 只用来验「路由认不认这条订阅」这一段前置检查。 */
	const withAi = (enabled: boolean, f: Fixture): RouteDeps => {
		const deps = makeDeps(f);
		(deps.runtime as unknown as { engines: unknown }).engines = { api: {} };
		(deps.store as unknown as { getGlobals: unknown }).getGlobals = () => ({
			ai: { enabled },
			stats: { enabled: true },
		});
		(deps.runtime as unknown as { subRuntimeStore: unknown }).subRuntimeStore = {
			get: () => undefined,
		};
		return deps;
	};

	it("对不上任何订阅的 id → 404,而不是拿别人的数据去评", async () => {
		const deps = withAi(true, { subs: [{ uid: "1" }] });
		const res = await createStatsRoute(deps).request("/roast/999", { method: "POST" });
		expect(res.status).toBe(404);
		expect(((await res.json()) as { code?: string }).code).toBe("not_found");
	});

	it("路径参数是订阅 id,不再认 uid(ADR-0020 决策 18):传一位 B 站 UP 的 uid → 404", async () => {
		const deps = withAi(true, { subs: [{ uid: "1" }] });
		const res = await createStatsRoute(deps).request("/roast/1", { method: "POST" });
		expect(res.status).toBe(404);
		expect(((await res.json()) as { message?: string }).message).toContain("不在订阅列表里");
	});

	it("只订阅 1 位也能评 —— 单人锐评不需要对照组", async () => {
		const deps = withAi(false, { subs: [{ uid: "1" }] });
		const res = await createStatsRoute(deps).request(`/roast/${subId("1")}`, { method: "POST" });
		// AI 没开是 409 not_configured(要主人去开,等是等不好的),但至少已经越过了「至少 2 位」那道
		// 只属于榜单的闸门。
		expect(res.status).toBe(409);
		const body = (await res.json()) as { code?: string; message?: string };
		expect(body.code).toBe("not_configured");
		expect(body.message).toContain("智能女仆");
	});
});

// ---------------------------------------------------------------------------
// overview 缓存 —— key 必须覆盖所有会改变结果的输入维度
// ---------------------------------------------------------------------------

describe("GET /api/stats/overview — 缓存键", () => {
	/** 缓存挂在路由实例上,所以这组用例必须复用同一个 route,不能走 `get()`。 */
	const call = async (route: ReturnType<typeof createStatsRoute>) =>
		(await (await route.request("/overview")).json()) as StatsOverviewResponse;

	it("订阅集合变了就不吃旧缓存 —— 删掉的 UP 不该在页面上再挂 30 秒", async () => {
		// key 曾经只有 `days:tz`。退订后 recorder 的 `dropUid` 已经把那位 UP 的
		// jsonl 物理删了,前端却还能从缓存里读到他整行数据(且背后的文件已不存在);
		// 反向同理 —— 刚加的订阅在 30 秒内一行都看不到。
		const f: Fixture = { subs: [{ uid: "1" }, { uid: "2" }] };
		const route = createStatsRoute(makeDeps(f));

		expect((await call(route)).rows).toHaveLength(2);
		f.subs?.pop();
		expect((await call(route)).rows).toHaveLength(1);
		f.subs?.push({ uid: "3" });
		expect((await call(route)).rows.map((r) => r.identity.externalId)).toEqual(["1", "3"]);
	});

	it("订阅没变时照常命中缓存 —— 别把缓存直接废掉", async () => {
		let reads = 0;
		const f: Fixture = { subs: [{ uid: "1" }] };
		const deps = makeDeps(f);
		const inner = deps.runtime.statsStore.listPosts;
		deps.runtime.statsStore.listPosts = async (uid: string, since: string) => {
			reads++;
			return inner(uid, since);
		};
		const route = createStatsRoute(deps);

		await call(route);
		const after = reads;
		await call(route);
		expect(reads).toBe(after); // 第二次没有再读盘
	});
});
