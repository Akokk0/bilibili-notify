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
	type CreatorCandidate,
	FEATURE_KEYS,
	fail,
	ok,
	type Result,
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
		specialViewers: [],
		...rest,
	} as Subscription;
}

/** 来源登记表里各键的描述符(给外部 id 的格式核)。 */
type Descriptors = Record<
	string,
	{ label: string; externalIdNoun?: string; externalIdRegex?: string }
>;

const DEFAULT_DESCRIPTORS: Descriptors = {
	bilibili: { label: "B 站", externalIdNoun: "UID" },
	douyin: { label: "抖音" },
};

function makeStores(
	subscriptions: Subscription[],
	names: Record<string, string> = {},
	platformLabels: Record<string, string> = { bilibili: "B 站", douyin: "抖音" },
	descriptors: Descriptors = DEFAULT_DESCRIPTORS,
) {
	return {
		timezone: () => "Asia/Shanghai",
		subscriptionStore: { list: () => subscriptions },
		subscriptionStateStore: {
			get: (id: string) => (names[id] ? { cachedProfile: { name: names[id] } } : undefined),
		},
		platformLabel: (sourceKey: string) => platformLabels[sourceKey] ?? sourceKey,
		identityLabel: (identity: { sourceKey: string; externalId: string }) => {
			const noun = descriptors[identity.sourceKey]?.externalIdNoun?.trim();
			const platform = platformLabels[identity.sourceKey] ?? identity.sourceKey;
			return noun ? `${noun} ${identity.externalId}` : `${platform} · ${identity.externalId}`;
		},
		searchCreators: async (): Promise<Result<{ candidates: CreatorCandidate[] }>> =>
			ok({ candidates: [] }),
		fetchProfile: async () => fail("not_found", "没有资料"),
		providedTools: () => [],
		sources: {
			get: (sourceKey: string) =>
				descriptors[sourceKey] === undefined ? undefined : { descriptor: descriptors[sourceKey] },
		},
	};
}

function view(s: ReturnType<typeof makeStores>) {
	return aiSubscriptionViews(
		s.subscriptionStore,
		s.subscriptionStateStore,
		s.platformLabel,
		s.identityLabel,
	);
}

const EXT_ID = "e0000000-0000-4000-8000-000000000001";

describe("attachReadOnlyTools — 查询接线", () => {
	it("接上了 —— 不接的话女仆会一口咬定「当前没有订阅」", () => {
		const setCreatorReader = vi.fn();
		attachReadOnlyTools({ setCreatorReader, setProvidedTools: vi.fn() }, makeStores([]));
		expect(setCreatorReader).toHaveBeenCalledTimes(1);
		expect(typeof setCreatorReader.mock.calls[0]?.[0].subscriptions).toBe("function");
	});

	it("把提供方工具的现取口交给生成器", () => {
		const setCreatorReader = vi.fn();
		const setProvidedTools = vi.fn();
		const providedTools = () => [];
		attachReadOnlyTools(
			{ setCreatorReader, setProvidedTools },
			{ ...makeStores([]), providedTools },
		);
		expect(setProvidedTools).toHaveBeenCalledWith(providedTools);
	});

	it("订阅视图是每次现取的,不是接线那一刻的快照", () => {
		const setCreatorReader = vi.fn();
		const subscriptions: Subscription[] = [];
		attachReadOnlyTools({ setCreatorReader, setProvidedTools: vi.fn() }, makeStores(subscriptions));
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
			{ creator: "bilibili:1", name: "UID 1", platform: "B 站", post: true, live: false },
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

	it("没资料名写身份标签，B 站与别的来源同一条、不分叉", () => {
		const s = makeStores(
			[makeSubscription({ uid: "1" }), makeSubscription({ uid: "2" }), makeExtensionSubscription()],
			{
				"id-1": "晨风UP主",
			},
		);
		expect(view(s).map((v) => v.name)).toEqual(["晨风UP主", "UID 2", "抖音 · sec-uid-1"]);
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
			{ creator: "bilibili:1", name: "UID 1", platform: "B 站", post: false, live: false },
			{ creator: "douyin:sec-uid-1", name: "抖音甲", platform: "抖音", post: false, live: true },
		]);
	});

	it("平台名函数给不出名字就是它自己的退路(键名)—— 视图原样用,不再自己兜", () => {
		const s = makeStores([makeExtensionSubscription()], {}, {});
		expect(view(s)[0]).toMatchObject({ platform: "douyin", creator: "douyin:sec-uid-1" });
	});
});

describe("attachReadOnlyTools — 搜人", () => {
	const readerWith = (
		searchCreators: (
			sourceKey: string,
			query: string,
		) => Promise<Result<{ candidates: CreatorCandidate[] }>>,
	) => {
		const setCreatorReader = vi.fn();
		attachReadOnlyTools(
			{ setCreatorReader, setProvidedTools: vi.fn() },
			{ ...makeStores([]), searchCreators },
		);
		return setCreatorReader.mock.calls[0]?.[0] as {
			searchCreators(
				sourceKey: string,
				query: string,
			): Promise<Result<{ candidates: Array<Record<string, unknown>> }>>;
		};
	};

	// 验红:把 creator 拼成只有外部 id,这条红。
	it("来源的候选翻成工具要的视图:creator = 来源键:外部 id,名字、粉丝、简介原样,头像等不带", async () => {
		const search = vi.fn(async () =>
			ok({
				candidates: [
					{
						externalId: "alice-ext",
						name: "爱丽丝",
						followers: 12,
						bio: "简介",
						fanClubName: "粉丝团",
					},
				],
			}),
		);
		const out = await readerWith(search).searchCreators("acme.inprocess", "爱");
		expect(search).toHaveBeenCalledWith("acme.inprocess", "爱");
		expect(out).toEqual({
			ok: true,
			candidates: [
				{ creator: "acme.inprocess:alice-ext", name: "爱丽丝", followers: 12, bio: "简介" },
			],
		});
	});

	it("来源回的失败原样回", async () => {
		const out = await readerWith(async () => fail("not_found", "没有这个来源")).searchCreators(
			"x",
			"y",
		);
		expect(out).toEqual({ ok: false, code: "not_found", message: "没有这个来源" });
	});
});

describe("attachReadOnlyTools — 没订阅的人回落查资料", () => {
	function profileReader(options: {
		subscriptions?: Subscription[];
		cached?: Record<string, { name?: string; followers?: number; bio?: string }>;
		registered?: boolean;
		fetchProfile: Parameters<typeof attachReadOnlyTools>[1]["fetchProfile"];
	}) {
		const setCreatorReader = vi.fn();
		const write = vi.fn();
		const subscriptionStateStore = {
			get: (id: string) =>
				options.cached?.[id] ? { cachedProfile: options.cached[id] } : undefined,
			set: write,
		};
		attachReadOnlyTools(
			{ setCreatorReader, setProvidedTools: vi.fn() },
			{
				...makeStores(options.subscriptions ?? []),
				subscriptionStateStore,
				fetchProfile: options.fetchProfile,
				sources: {
					get: (sourceKey) =>
						options.registered ? { descriptor: { label: sourceKey } } : undefined,
				},
			},
		);
		const reader = setCreatorReader.mock.calls[0]?.[0] as {
			profile(creator: string): Promise<Result<{ profile: Record<string, unknown> }>>;
		};
		return { reader, write };
	}

	it("没订阅的人在册来源 → 按原身份查一次,交名字、粉丝数、简介,不写缓存", async () => {
		const fetchProfile = vi.fn(async () =>
			ok({ name: "爱丽丝", followers: 12, bio: "简介", fanClubName: "不该喂回模型" }),
		);
		const { reader, write } = profileReader({ registered: true, fetchProfile });
		expect(await reader.profile("acme:alice-ext")).toEqual({
			ok: true,
			profile: { name: "爱丽丝", followers: 12, bio: "简介" },
		});
		expect(fetchProfile).toHaveBeenCalledOnce();
		expect(fetchProfile).toHaveBeenCalledWith({ sourceKey: "acme", externalId: "alice-ext" });
		expect(write).not.toHaveBeenCalled();
	});

	it("订阅着且缓存有名字 → 答缓存,不问来源", async () => {
		const sub = makeSubscription({ uid: "alice-ext" });
		const fetchProfile = vi.fn();
		const { reader } = profileReader({
			subscriptions: [sub],
			cached: { [sub.id]: { name: "缓存里的爱丽丝" } },
			registered: true,
			fetchProfile,
		});
		expect(await reader.profile("bilibili:alice-ext")).toEqual({
			ok: true,
			profile: { name: "缓存里的爱丽丝" },
		});
		expect(fetchProfile).not.toHaveBeenCalled();
	});

	it("来源回的失败码与话原样交给模型", async () => {
		const failure = fail("rate_limited", "平台让稍后再查");
		const { reader } = profileReader({ registered: true, fetchProfile: async () => failure });
		expect(await reader.profile("acme:alice-ext")).toBe(failure);
	});

	it("来源不在登记表 → 照旧查不到,不调回落", async () => {
		const fetchProfile = vi.fn();
		const { reader } = profileReader({ registered: false, fetchProfile });
		expect(await reader.profile("acme:alice-ext")).toMatchObject({
			ok: false,
			code: "not_found",
		});
		expect(fetchProfile).not.toHaveBeenCalled();
	});
});

/**
 * 女仆查直播状态接上在播表:视图里带上 BN 手里这条订阅此刻在不在播,`get_live_status` 照它答。
 * 来源没在跑时 BN 手里没有它的在播状态(决策 61)—— 说「不知道」,不说「未开播」。
 */
describe("aiSubscriptionViews — 在播表", () => {
	const STARTED = Date.UTC(2026, 8, 24, 4, 0, 0);
	const withLive = (
		row: { title?: string; startedAt?: number; totalViewers?: number } | undefined,
		running: boolean,
	) => {
		const s = makeStores([makeExtensionSubscription()]);
		return aiSubscriptionViews(
			s.subscriptionStore,
			s.subscriptionStateStore,
			s.platformLabel,
			s.identityLabel,
			{
				// 在播表的行是 `{ startedAt, details }`(details 是中立的 LiveDetails)。
				row: (id) =>
					id === EXT_ID && row
						? {
								startedAt: row.startedAt,
								details: { title: row.title, totalViewers: row.totalViewers },
							}
						: undefined,
				running: (extensionId) => running && extensionId === "douyin",
			},
		)[0];
	};

	it("在播表里有它 → 在播,带标题、开播时刻、累计观看", () => {
		expect(
			withLive({ title: "晚饭直播", startedAt: STARTED, totalViewers: 99 }, true),
		).toMatchObject({
			liveNow: { state: "live", title: "晚饭直播", startedAt: STARTED, totalViewers: 99 },
		});
	});

	it("来源在跑、表里没有它 → 未开播", () => {
		expect(withLive(undefined, true)).toMatchObject({ liveNow: { state: "idle" } });
	});

	it("来源没在跑 → 不知道", () => {
		expect(withLive(undefined, false)).toMatchObject({ liveNow: { state: "unknown" } });
	});

	it("接上了在播读口才有这一格;所有来源都从同一张表答", () => {
		const s = makeStores([makeSubscription({ uid: "1" }), makeExtensionSubscription()]);
		expect(view(s)[1]).not.toHaveProperty("liveNow");
		const v = aiSubscriptionViews(
			s.subscriptionStore,
			s.subscriptionStateStore,
			s.platformLabel,
			s.identityLabel,
			{
				row: () => undefined,
				running: () => true,
			},
		);
		expect(v[0]).toMatchObject({ liveNow: { state: "idle" } });
	});
});

/**
 * 所有订阅的在播都从 BN 手里的在播表答(`get_live_status` 不再问平台):按订阅 id 对行,
 * 再看来源此刻在不在跑。
 */
describe("aiSubscriptionViews — B 站订阅也读在播表", () => {
	it.each([
		[
			"来源在跑",
			true,
			{ state: "live", title: "晚间杂谈", startedAt: Date.UTC(2026, 8, 24, 4, 0, 0) },
		],
		["来源没在跑", false, { state: "unknown" }],
	])("B 站订阅也按在播表答:%s → %o", (_name, running, expected) => {
		const s = makeStores([makeSubscription({ uid: "1" })]);
		const [entry] = aiSubscriptionViews(
			s.subscriptionStore,
			s.subscriptionStateStore,
			s.platformLabel,
			s.identityLabel,
			{
				row: (id) =>
					id === "id-1"
						? {
								startedAt: Date.UTC(2026, 8, 24, 4, 0, 0),
								details: { title: "晚间杂谈" },
							}
						: undefined,
				running: (sourceKey) => running && sourceKey === "bilibili",
			},
		);
		expect(entry?.liveNow).toEqual(expected);
	});

	it("来源在跑、表里没有它 → 未开播", () => {
		const s = makeStores([makeSubscription({ uid: "1" })]);
		const [entry] = aiSubscriptionViews(
			s.subscriptionStore,
			s.subscriptionStateStore,
			s.platformLabel,
			s.identityLabel,
			{
				row: () => undefined,
				running: () => true,
			},
		);
		expect(entry?.liveNow).toEqual({ state: "idle" });
	});

	it("没接在播读口 → 没有这一格(工具按「查不到」答)", () => {
		const s = makeStores([makeSubscription({ uid: "1" })]);
		expect(view(s)[0]).not.toHaveProperty("liveNow");
	});
});
