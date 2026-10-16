/**
 * 单元测试 — `attachReadOnlyTools`(独立端把订阅查询能力接给女仆的唯一入口)。
 *
 * 「只读」如今是**结构性**的 —— 工具表里根本没有会改订阅的工具了(见
 * `packages/ai/src/__tests__/read-only-tools-gate.test.ts` 那道闸)。所以这里
 * 不再需要盯着「有没有多传一个 subMgmt」,只钉两件事:接线接上了,而且
 * 订阅视图是每次现取的。
 *
 * 顺带钉住投影本身:AI 看到的订阅列表得是**人看得懂的名字**和**真实的**
 * 动态/直播开关,不然它答出来的每句话都在描述另一个后台。
 *
 * 视图每条订阅是同一种形状 `{ creator, name, platform, post, live, liveNow? }`(ADR-0030 决策 1):
 * `creator` 是「来源键:外部 id」,平台名由宿主递进来的函数取(它问来源登记表),B 站和别的来源不分叉。
 */

import {
	FEATURE_KEYS,
	type Subscription,
	type SubscriptionRouting,
} from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { aiSubscriptionViews, attachReadOnlyTools } from "../read-only-tools.js";

/** 全特性键都填空数组的 routing,再叠上本例关心的那几条。 */
function routing(over: Partial<SubscriptionRouting> = {}): SubscriptionRouting {
	const base = Object.fromEntries(
		FEATURE_KEYS.map((k) => [k, [] as string[]]),
	) as unknown as SubscriptionRouting;
	return { ...base, ...over };
}

/** B 站来源的订阅:夹具里写 `uid` 图省事,落成订阅的 `identity`。 */
function makeSubscription(
	over: Partial<Omit<Subscription, "identity">> & { uid: string },
): Subscription {
	const { uid, ...rest } = over;
	return {
		id: `id-${uid}`,
		identity: { sourceKey: "bilibili", externalId: uid },
		enabled: true,
		tagIds: [],
		routing: routing(),
		extraTargets: { atAllPost: {}, atAllLiveStart: {}, wordcloud: {}, liveSummary: {} },
		overrides: {},
		specialUsers: [],
		...rest,
	} as Subscription;
}

/** 来源登记表里各键的描述符(给外部 id 的格式核)。 */
type Descriptors = Record<string, { label: string; externalIdRegex?: string }>;

function makeStores(
	subscriptions: Subscription[],
	names: Record<string, string> = {},
	platformLabels: Record<string, string> = { bilibili: "B 站", douyin: "抖音" },
	descriptors: Descriptors = {},
) {
	return {
		subscriptionStore: { list: () => subscriptions },
		subRuntimeStore: {
			get: (id: string) => (names[id] ? { cachedProfile: { name: names[id] } } : undefined),
		},
		platformLabel: (sourceKey: string) => platformLabels[sourceKey] ?? sourceKey,
		sources: {
			get: (sourceKey: string) =>
				descriptors[sourceKey] === undefined ? undefined : { descriptor: descriptors[sourceKey] },
		},
	};
}

function view(s: ReturnType<typeof makeStores>) {
	return aiSubscriptionViews(s.subscriptionStore, s.subRuntimeStore, s.platformLabel);
}

const EXT_ID = "e0000000-0000-4000-8000-000000000001";

describe("attachReadOnlyTools — 查询接线", () => {
	it("接上了 —— 不接的话女仆会一口咬定「当前没有订阅」", () => {
		const setCreatorReader = vi.fn();
		attachReadOnlyTools({ setCreatorReader }, makeStores([]));
		expect(setCreatorReader).toHaveBeenCalledTimes(1);
		expect(typeof setCreatorReader.mock.calls[0]?.[0].subscriptions).toBe("function");
	});

	it("订阅视图是每次现取的,不是接线那一刻的快照", () => {
		const setCreatorReader = vi.fn();
		const subscriptions: Subscription[] = [];
		attachReadOnlyTools({ setCreatorReader }, makeStores(subscriptions));
		const reader = setCreatorReader.mock.calls[0]?.[0] as { subscriptions(): unknown[] };

		expect(reader.subscriptions()).toEqual([]);
		subscriptions.push(makeSubscription({ uid: "1" }));
		// 接线发生在启动时,而订阅是运行期随时增删的。取快照的话,主人加完订阅
		// 立刻去问女仆,她会一口咬定「当前没有订阅」。
		expect(reader.subscriptions()).toHaveLength(1);
	});
});

describe("aiSubscriptionViews — 投影", () => {
	it("有 target 才算订了该特性 —— 路由是空的就等于没订", () => {
		const s = makeStores([makeSubscription({ uid: "1", routing: routing({ post: ["t1"] }) })]);
		expect(view(s)).toEqual([
			{ creator: "bilibili:1", name: "1", platform: "B 站", post: true, live: false },
		]);
	});

	// 「直播 ✓」是直播类推送有没有目标:开播(liveStart)与周期「正在直播」(liveStreaming)任一有就算 ——
	// ⑬d 拆键之前只有 liveStart 一把,只给周期配了目标的订阅会被女仆说成「没订直播」。
	it.each([
		["只给开播配了目标", { liveStart: ["t1"] }, true],
		["只给周期「正在直播」配了目标", { liveStreaming: ["t1"] }, true],
		["两把都配了", { liveStart: ["t1"], liveStreaming: ["t2"] }, true],
		["都没配(下播不算)", { liveEnd: ["t1"] }, false],
	])("直播 ✓:%s → %s", (_name, targets, expected) => {
		const s = makeStores([makeSubscription({ uid: "1", routing: routing(targets) })]);
		expect(view(s)[0]?.live).toBe(expected);
	});

	it("名字优先用平台资料缓存,没有就回落外部 id(B 站和别的来源同一条,不再写「UID xxx」)", () => {
		const s = makeStores(
			[makeSubscription({ uid: "1" }), makeSubscription({ uid: "2" }), makeExtensionSubscription()],
			{
				"id-1": "晨风UP主",
			},
		);
		expect(view(s).map((v) => v.name)).toEqual(["晨风UP主", "2", "sec-uid-1"]);
	});

	it("停用的订阅不进视图 —— 关掉的 UP 不该出现在女仆的答案里", () => {
		const s = makeStores([
			makeSubscription({ uid: "1", enabled: false }),
			makeSubscription({ uid: "2" }),
		]);
		expect(view(s).map((v) => v.creator)).toEqual(["bilibili:2"]);
	});

	it("每条带 creator(来源键:外部 id);平台名问宿主递进来的函数,不按 B 站分叉", () => {
		const ext = makeExtensionSubscription({ routing: routing({ liveStart: ["t1"] }) });
		const s = makeStores([makeSubscription({ uid: "1" }), ext], { [EXT_ID]: "抖音甲" });
		expect(view(s)).toEqual([
			{ creator: "bilibili:1", name: "1", platform: "B 站", post: false, live: false },
			{ creator: "douyin:sec-uid-1", name: "抖音甲", platform: "抖音", post: false, live: true },
		]);
	});

	it("平台名函数给不出名字就是它自己的退路(键名)—— 视图原样用,不再自己兜", () => {
		const s = makeStores([makeExtensionSubscription()], {}, {});
		expect(view(s)[0]).toMatchObject({ platform: "douyin", creator: "douyin:sec-uid-1" });
	});
});

describe("attachReadOnlyTools — 外部 id 的格式", () => {
	const fits = (descriptors: Descriptors, sourceKey: string, externalId: string) => {
		const setCreatorReader = vi.fn();
		attachReadOnlyTools({ setCreatorReader }, makeStores([], {}, {}, descriptors));
		const reader = setCreatorReader.mock.calls[0]?.[0] as {
			externalIdFits(sourceKey: string, externalId: string): boolean;
		};
		return reader.externalIdFits(sourceKey, externalId);
	};

	it("来源在描述符里声明了外部 id 的格式 → 整串匹配才算合格", () => {
		const d = { bilibili: { label: "B 站", externalIdRegex: "[0-9]+" } };
		expect(fits(d, "bilibili", "123")).toBe(true);
		expect(fits(d, "bilibili", "abc")).toBe(false);
		expect(fits(d, "bilibili", "12a")).toBe(false);
	});

	it("没声明格式 / 认不出这个来源 → 不替它做主,算合格", () => {
		expect(fits({ bilibili: { label: "B 站" } }, "bilibili", "abc")).toBe(true);
		expect(fits({}, "bilibili", "abc")).toBe(true);
	});
});

/**
 * 女仆查直播状态对拓展订阅接上在播表(ADR-0019 决策 64 的 09-24 🔗):视图里带上 BN 手里这条订阅此刻在不在播,
 * `get_live_status` 照它答。拓展没在跑时 BN 手里没有它的在播状态(决策 61)—— 说「不知道」,不说「未开播」。
 */
describe("aiSubscriptionViews — 拓展订阅的在播", () => {
	const STARTED = Date.UTC(2026, 8, 24, 4, 0, 0);
	const withLive = (
		row: { title?: string; startedAt?: number; totalViewers?: number } | undefined,
		running: boolean,
	) => {
		const s = makeStores([makeExtensionSubscription()]);
		return aiSubscriptionViews(s.subscriptionStore, s.subRuntimeStore, s.platformLabel, {
			row: (id) => (id === EXT_ID ? row : undefined),
			running: (extensionId) => running && extensionId === "douyin",
		})[0];
	};

	it("在播表里有它 → 在播,带标题、开播时刻、累计观看", () => {
		expect(
			withLive({ title: "晚饭直播", startedAt: STARTED, totalViewers: 99 }, true),
		).toMatchObject({
			liveNow: { state: "live", title: "晚饭直播", startedAt: STARTED, totalViewers: 99 },
		});
	});

	it("拓展在跑、表里没有它 → 未开播", () => {
		expect(withLive(undefined, true)).toMatchObject({ liveNow: { state: "idle" } });
	});

	it("拓展没在跑 → 不知道", () => {
		expect(withLive(undefined, false)).toMatchObject({ liveNow: { state: "unknown" } });
	});

	it("接上了在播来源才有这一格;没接 B 站的在播来源时 B 站条目没有", () => {
		const s = makeStores([makeSubscription({ uid: "1" }), makeExtensionSubscription()]);
		expect(view(s)[1]).not.toHaveProperty("liveNow");
		const v = aiSubscriptionViews(s.subscriptionStore, s.subRuntimeStore, s.platformLabel, {
			row: () => undefined,
			running: () => true,
		});
		expect(v[0]).not.toHaveProperty("liveNow");
	});
});

/**
 * B 站订阅的在播也从 BN 手里的状态答(`get_live_status` 不再问 B 站):读直播引擎列出来的在播房间
 * (只列在播的),按订阅 id 对。房间快照里的 `uid` / `roomId` 视图不要。
 */
describe("aiSubscriptionViews — B 站订阅的在播", () => {
	const withRooms = (
		rooms: Array<{ subscriptionId: string; title?: string; startedAt?: string }>,
	) => {
		const s = makeStores([makeSubscription({ uid: "1" }), makeSubscription({ uid: "2" })]);
		return aiSubscriptionViews(
			s.subscriptionStore,
			s.subRuntimeStore,
			s.platformLabel,
			undefined,
			() => rooms.map((r) => ({ ...r, uid: "9", roomId: "88" })),
		);
	};

	it("在播房间里有它 → 在播,带标题与开播时刻(毫秒);不在 → 未开播", () => {
		const v = withRooms([
			{ subscriptionId: "id-1", title: "晚间杂谈", startedAt: "2026-09-24T04:00:00.000Z" },
		]);
		expect(v[0]?.liveNow).toEqual({
			state: "live",
			title: "晚间杂谈",
			startedAt: Date.UTC(2026, 8, 24, 4, 0, 0),
		});
		expect(v[1]?.liveNow).toEqual({ state: "idle" });
	});

	it("开播时刻解析不出来 → 不带这一格,不写成 NaN", () => {
		const v = withRooms([{ subscriptionId: "id-1", startedAt: "不是时间" }]);
		expect(v[0]?.liveNow).toEqual({ state: "live", title: undefined, startedAt: undefined });
	});

	it("没接 B 站的在播来源 → 没有这一格(工具按「查不到」答)", () => {
		const s = makeStores([makeSubscription({ uid: "1" })]);
		expect(view(s)[0]).not.toHaveProperty("liveNow");
	});
});
