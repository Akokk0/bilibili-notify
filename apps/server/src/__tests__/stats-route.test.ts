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

const DAY = 86_400_000;
/** 固定"现在",让每日分桶可预期。 */
const NOW = Date.UTC(2026, 4, 16, 12, 0, 0);

interface Fixture {
	subs?: Array<{ uid: string }>;
	samples?: Record<string, Array<{ ts: string; value: number }>>;
	dynamics?: Record<string, Array<{ id: string; type: string; ts: string }>>;
	sessions?: Record<string, Array<{ startedAt: string; endedAt?: string; peakViewers?: string }>>;
	liveRooms?: Array<{ uid: string; isLive: boolean }>;
	fansEntries?: Array<{ uid: string; current: number }>;
	/** 活动采集的起始时刻。缺省取足够早的值,等于「一直在采」。 */
	recordingSince?: string;
}

function makeDeps(f: Fixture): RouteDeps {
	return {
		runtime: {
			fansStore: {
				listSamplesSince: async (uid: string) => f.samples?.[uid] ?? [],
			},
			statsStore: {
				listDynamics: async (uid: string) => f.dynamics?.[uid] ?? [],
				listLiveSessions: async (uid: string) => f.sessions?.[uid] ?? [],
				recordingSince: async () => f.recordingSince ?? "1970-01-01T00:00:00.000Z",
			},
			engines: f.liveRooms ? { listLiveRooms: () => f.liveRooms } : null,
			fansPoller: f.fansEntries ? { getLastEntries: () => f.fansEntries } : null,
		},
		store: { getSubscriptions: () => f.subs ?? [] },
		puppeteer: null,
		wsTicketStore: null,
		qqSessionRegistry: null,
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
		expect(row?.fans).toBeNull();
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
				dynamics: {
					"1": [{ id: "d", type: "DYNAMIC_TYPE_AV", ts: new Date(NOW - 3600_000).toISOString() }],
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
		const body = await get(makeDeps({ subs: [{ uid: "1" }] }));
		expect(body.rows[0]?.archives).toBeNull();
		expect(body.rows[0]?.dynamics).toBeNull();
		expect(body.rows[0]?.liveSessions).toBeNull();
		expect(body.rows[0]?.liveHours).toBeNull();
		expect(body.rows[0]?.liveTimedSessions).toBeNull();
	});

	it("有采集覆盖但那几天真没发 → 计数是 0,不是 null", async () => {
		// 这条是上一条的对偶,缺了它「一律返回 null」也能全绿。
		const body = await get(
			makeDeps({
				subs: [{ uid: "1" }],
				samples: { "1": [{ ts: new Date(NOW).toISOString(), value: 100 }] },
			}),
		);
		expect(body.rows[0]?.archives).toBe(0);
		expect(body.rows[0]?.dynamics).toBe(0);
		expect(body.rows[0]?.liveSessions).toBe(0);
	});
});

describe("GET /api/stats/overview — 窗口净增口径", () => {
	/** 连续 n+1 天每天一条采样,每天恰好 +100。 */
	const rising = (n: number) =>
		Array.from({ length: n + 1 }, (_, i) => ({
			ts: new Date(NOW - (n - i) * DAY).toISOString(),
			value: 1000 + i * 100,
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
	it("fans 优先取 poller 快照(比 jsonl 末行新)", async () => {
		const deps = makeDeps({
			subs: [{ uid: "1" }],
			samples: { "1": [{ ts: new Date(NOW - DAY).toISOString(), value: 100 }] },
			fansEntries: [{ uid: "1", current: 175 }],
		});
		expect((await get(deps)).rows[0]?.fans).toBe(175);
	});

	it("poller 未就绪时回退到采样末值", async () => {
		const deps = makeDeps({
			subs: [{ uid: "1" }],
			samples: { "1": [{ ts: new Date(NOW - DAY).toISOString(), value: 100 }] },
		});
		expect((await get(deps)).rows[0]?.fans).toBe(100);
	});

	it("投稿与动态按类型分栏,开播伪动态两边都不计", async () => {
		const ts = new Date(NOW - DAY).toISOString();
		const deps = makeDeps({
			subs: [{ uid: "1" }],
			dynamics: {
				"1": [
					{ id: "a", type: "DYNAMIC_TYPE_AV", ts },
					{ id: "b", type: "DYNAMIC_TYPE_DRAW", ts },
					{ id: "c", type: "DYNAMIC_TYPE_LIVE_RCMD", ts },
				],
			},
		});
		const row = (await get(deps)).rows[0];
		expect(row?.archives).toBe(1);
		expect(row?.dynamics).toBe(1);
	});

	it("直播中的 UP 标记 live=true", async () => {
		const deps = makeDeps({
			subs: [{ uid: "1" }, { uid: "2" }],
			liveRooms: [
				{ uid: "1", isLive: true },
				{ uid: "2", isLive: false },
			],
		});
		const body = await get(deps);
		expect(body.rows.find((r) => r.uid === "1")?.live).toBe(true);
		expect(body.rows.find((r) => r.uid === "2")?.live).toBe(false);
	});

	it("lastActivityAt 取动态与开播里更晚的那个", async () => {
		const early = new Date(NOW - 3 * DAY).toISOString();
		const late = new Date(NOW - DAY).toISOString();
		const deps = makeDeps({
			subs: [{ uid: "1" }],
			dynamics: { "1": [{ id: "a", type: "DYNAMIC_TYPE_WORD", ts: early }] },
			sessions: { "1": [{ startedAt: late, endedAt: late }] },
		});
		expect((await get(deps)).rows[0]?.lastActivityAt).toBe(late);
	});

	it("动态落盘顺序与发布时间不一致时,lastActivityAt 仍取最晚的一条", async () => {
		// listDynamics 的契约是「按落盘顺序」= 检测顺序,而 B 站动态流按惯例
		// 最新在前 —— 一轮检测到多条时,最后落盘的反而是这批里最旧的那条。
		// 取末元素会读出错的时间,必须按 ts 比较。
		const older = new Date(NOW - 3 * DAY).toISOString();
		const newer = new Date(NOW - DAY).toISOString();
		const deps = makeDeps({
			subs: [{ uid: "1" }],
			dynamics: {
				"1": [
					{ id: "new", type: "DYNAMIC_TYPE_WORD", ts: newer },
					{ id: "old", type: "DYNAMIC_TYPE_WORD", ts: older },
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

describe("GET /api/stats/overview — 活动热力图的采集水位线", () => {
	/** 近 5 天每天一条粉丝采样 —— 「服务当天在跑」的证据。 */
	const dailySamples = () =>
		Array.from({ length: 5 }, (_, i) => ({
			ts: new Date(NOW - (4 - i) * DAY).toISOString(),
			value: 1000 + i,
		}));

	it("采集开始之前的日子是 null,不是 0 —— 那几天我们根本没在记", async () => {
		// 粉丝采样从 5 天前就有,活动采集昨天才开始。中间那几天既没有活动记录,
		// 也不该声称「记了,是 0」——0 会被读成「这位 UP 那天什么都没发」。
		const deps = makeDeps({
			subs: [{ uid: "1" }],
			samples: { "1": dailySamples() },
			recordingSince: new Date(NOW - DAY).toISOString(),
		});
		const activity = (await get(deps, "?days=5")).rows[0]?.activity;
		// 最后两格(昨天 / 今天)在水位线之后 → 0;更早的三格 → null。
		expect(activity).toEqual([null, null, null, 0, 0]);
	});

	it("水位线之后仍然区分 0 与 null —— 服务那天没跑照旧是 null", async () => {
		// 只有今天一条粉丝采样:今天之前虽在水位线之后,但服务没跑,仍是 null。
		const deps = makeDeps({
			subs: [{ uid: "1" }],
			samples: { "1": [{ ts: new Date(NOW).toISOString(), value: 1000 }] },
			recordingSince: new Date(NOW - 30 * DAY).toISOString(),
		});
		const activity = (await get(deps, "?days=3")).rows[0]?.activity;
		expect(activity).toEqual([null, null, 0]);
	});

	it("某个 UP 的粉丝档案被删过,不该抹掉它的活动热力图", async () => {
		// 回归:「服务当天在跑」曾按**每个 UP 自己**的粉丝采样判断,而禁用订阅会
		// `dropUid` 物理删掉该 UP 的 fans jsonl。于是订阅了三个月的 UP 只要被禁用
		// 再启用,热力图整片变「无记录」—— 尽管它的动态和场次原封不动在盘上。
		//
		// 「服务器那天在不在跑」是**服务器**的属性,不是某个 UP 的属性:只要当天
		// 有任何一位 UP 采到过样本,就足以证明我们在看着。
		const deps = makeDeps({
			subs: [{ uid: "1" }, { uid: "2" }],
			samples: { "1": dailySamples() }, // uid 2 的档案被删了
			dynamics: {
				"2": [{ id: "a", type: "DYNAMIC_TYPE_WORD", ts: new Date(NOW).toISOString() }],
			},
			recordingSince: new Date(NOW - 30 * DAY).toISOString(),
		});
		const rows = (await get(deps, "?days=5")).rows;
		const row2 = rows.find((r) => r.uid === "2");
		expect(row2?.activity).toEqual([0, 0, 0, 0, 1]);
	});

	it("所有 UP 都没有采样 → 仍然全是 null,不凭空断言服务在跑", async () => {
		const deps = makeDeps({
			subs: [{ uid: "1" }],
			dynamics: {
				"1": [{ id: "a", type: "DYNAMIC_TYPE_WORD", ts: new Date(NOW).toISOString() }],
			},
			recordingSince: new Date(NOW - 30 * DAY).toISOString(),
		});
		const activity = (await get(deps, "?days=3")).rows[0]?.activity;
		expect(activity).toEqual([null, null, null]);
	});

	it("水位线当天有活动就照常上色,不被水位线抹掉", async () => {
		const deps = makeDeps({
			subs: [{ uid: "1" }],
			samples: { "1": dailySamples() },
			dynamics: {
				"1": [{ id: "a", type: "DYNAMIC_TYPE_WORD", ts: new Date(NOW).toISOString() }],
			},
			recordingSince: new Date(NOW).toISOString(),
		});
		const activity = (await get(deps, "?days=5")).rows[0]?.activity;
		expect(activity?.at(-1)).toBe(1);
	});
});

describe("GET /api/stats/overview — 缓存", () => {
	it("同参数二次请求走缓存,不重复读盘", async () => {
		const listSamplesSince = vi.fn(async () => []);
		const deps = makeDeps({ subs: [{ uid: "1" }] });
		(deps.runtime as unknown as { fansStore: unknown }).fansStore = { listSamplesSince };
		const app = createStatsRoute(deps);
		await app.request("/overview?days=30");
		await app.request("/overview?days=30");
		expect(listSamplesSince).toHaveBeenCalledTimes(1);
	});

	it("换了 days 就不吃上一份缓存", async () => {
		const listSamplesSince = vi.fn(async () => []);
		const deps = makeDeps({ subs: [{ uid: "1" }] });
		(deps.runtime as unknown as { fansStore: unknown }).fansStore = { listSamplesSince };
		const app = createStatsRoute(deps);
		await app.request("/overview?days=30");
		await app.request("/overview?days=7");
		expect(listSamplesSince).toHaveBeenCalledTimes(2);
	});

	it("TTL 过期后重新读盘", async () => {
		const listSamplesSince = vi.fn(async () => []);
		const deps = makeDeps({ subs: [{ uid: "1" }] });
		(deps.runtime as unknown as { fansStore: unknown }).fansStore = { listSamplesSince };
		const app = createStatsRoute(deps);
		await app.request("/overview?days=30");
		vi.setSystemTime(NOW + 31_000);
		await app.request("/overview?days=30");
		expect(listSamplesSince).toHaveBeenCalledTimes(2);
	});

	it("条目数有上限 —— 换着参数刷不会让缓存无限涨", async () => {
		// days×tz 的组合空间有 15 万种,每份都装着全部 UP 的整段序列。没有上限的话
		// 换着参数刷就能把独立端(Docker 堆上限 384MB)顶爆。
		const listSamplesSince = vi.fn(async () => []);
		const deps = makeDeps({ subs: [{ uid: "1" }] });
		(deps.runtime as unknown as { fansStore: unknown }).fansStore = { listSamplesSince };
		const app = createStatsRoute(deps);

		// 塞满并溢出:tz 各不相同,全都在 TTL 内。
		for (let i = 0; i <= MAX_CACHE_ENTRIES; i++) await app.request(`/overview?days=30&tz=${i}`);
		const afterFill = listSamplesSince.mock.calls.length;

		// 最早那条应已被挤掉 —— 再问一次必须重新读盘。
		await app.request("/overview?days=30&tz=0");
		expect(listSamplesSince.mock.calls.length).toBe(afterFill + 1);
	});
});

describe("POST /api/stats/roast/:uid — 单 UP 锐评", () => {
	/** AI 没启用时的 deps —— 只用来验「路由认不认这个 uid」这一段前置检查。 */
	const withAi = (enabled: boolean, f: Fixture): RouteDeps => {
		const deps = makeDeps(f);
		(deps.runtime as unknown as { engines: unknown }).engines = { api: {} };
		(deps.store as unknown as { getGlobals: unknown }).getGlobals = () => ({
			defaults: { ai: { enabled } },
		});
		(deps.runtime as unknown as { subRuntimeStore: unknown }).subRuntimeStore = {
			get: () => undefined,
		};
		return deps;
	};

	it("未订阅的 uid → 404,而不是拿别人的数据去评", async () => {
		const deps = withAi(true, { subs: [{ uid: "1" }] });
		const res = await createStatsRoute(deps).request("/roast/999", { method: "POST" });
		expect(res.status).toBe(404);
	});

	it("只订阅 1 位也能评 —— 单人锐评不需要对照组", async () => {
		const deps = withAi(false, { subs: [{ uid: "1" }] });
		const res = await createStatsRoute(deps).request("/roast/1", { method: "POST" });
		// AI 没开是 400,但至少已经越过了「至少 2 位」那道只属于榜单的闸门。
		expect(res.status).toBe(400);
		expect(((await res.json()) as { err?: string }).err).toContain("智能女仆");
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
		expect((await call(route)).rows.map((r) => r.uid)).toEqual(["1", "3"]);
	});

	it("订阅没变时照常命中缓存 —— 别把缓存直接废掉", async () => {
		let reads = 0;
		const f: Fixture = { subs: [{ uid: "1" }] };
		const deps = makeDeps(f);
		const inner = deps.runtime.statsStore.listDynamics;
		deps.runtime.statsStore.listDynamics = async (uid: string, since: string) => {
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
