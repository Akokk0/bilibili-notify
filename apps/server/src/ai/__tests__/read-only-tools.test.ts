/**
 * 单元测试 — `attachReadOnlyTools`(独立端把订阅查询能力接给女仆的唯一入口)。
 *
 * 「只读」如今是**结构性**的 —— 工具表里根本没有会改订阅的工具了(见
 * `packages/ai/src/__tests__/read-only-tools-gate.test.ts` 那道闸)。所以这里
 * 不再需要盯着「有没有多传一个 subMgmt」,只钉两件事:接线接上了,而且
 * `getSubs` 是每次现取的。
 *
 * 顺带钉住投影本身:AI 看到的订阅列表得是**人看得懂的名字**和**真实的**
 * 动态/直播开关,不然它答出来的每句话都在描述另一个后台。
 */

import {
	FEATURE_KEYS,
	type Subscription,
	type SubscriptionRouting,
} from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { attachReadOnlyTools, buildAiSubsView } from "../read-only-tools.js";

/** 全特性键都填空数组的 routing,再叠上本例关心的那几条。 */
function routing(over: Partial<SubscriptionRouting> = {}): SubscriptionRouting {
	const base = Object.fromEntries(
		FEATURE_KEYS.map((k) => [k, [] as string[]]),
	) as unknown as SubscriptionRouting;
	return { ...base, ...over };
}

function makeSub(over: Partial<Subscription> & { uid: string }): Subscription {
	return {
		id: `id-${over.uid}`,
		enabled: true,
		groups: [],
		routing: routing(),
		atAllDefaults: { dynamic: false, live: true },
		atAll: { dynamic: {}, live: {} },
		overrides: {},
		specialUsers: [],
		...over,
	} as Subscription;
}

function makeStores(subs: Subscription[], names: Record<string, string> = {}) {
	return {
		subscriptionStore: { list: () => subs },
		subRuntimeStore: {
			get: (id: string) => (names[id] ? { cachedProfile: { name: names[id] } } : undefined),
		},
	};
}

describe("attachReadOnlyTools — 查询接线", () => {
	it("接上了 —— 不接的话女仆会一口咬定「当前没有订阅」", () => {
		const setSubscriptionsSource = vi.fn();
		attachReadOnlyTools({ setSubscriptionsSource }, makeStores([]));
		expect(setSubscriptionsSource).toHaveBeenCalledTimes(1);
		expect(typeof setSubscriptionsSource.mock.calls[0]?.[0]).toBe("function");
	});

	it("getSubs 是每次现取的,不是接线那一刻的快照", () => {
		const setSubscriptionsSource = vi.fn();
		const subs: Subscription[] = [];
		attachReadOnlyTools({ setSubscriptionsSource }, makeStores(subs));
		const getSubs = setSubscriptionsSource.mock.calls[0]?.[0] as () => unknown;

		expect(getSubs()).toEqual({});
		subs.push(makeSub({ uid: "1", name: "小明" }));
		// 接线发生在启动时,而订阅是运行期随时增删的。取快照的话,主人加完订阅
		// 立刻去问女仆,她会一口咬定「当前没有订阅」。
		expect(Object.keys(getSubs() as object)).toEqual(["1"]);
	});
});

describe("buildAiSubsView — 投影", () => {
	it("有 target 才算订了该特性 —— 路由是空的就等于没订", () => {
		const s = makeStores([makeSub({ uid: "1", routing: routing({ dynamic: ["t1"] }) })]);
		const view = buildAiSubsView(s.subscriptionStore, s.subRuntimeStore);
		expect(view["1"]).toMatchObject({ uid: "1", dynamic: true, live: false });
	});

	it("名字优先用平台资料缓存,没有就回落 UID —— 不让 AI 报一串数字", () => {
		const s = makeStores([makeSub({ uid: "1" }), makeSub({ uid: "2" })], { "id-1": "晨风UP主" });
		const view = buildAiSubsView(s.subscriptionStore, s.subRuntimeStore);
		expect(view["1"]?.uname).toBe("晨风UP主");
		expect(view["2"]?.uname).toBe("UID 2");
	});

	it("停用的订阅不进视图 —— 关掉的 UP 不该出现在女仆的答案里", () => {
		const s = makeStores([makeSub({ uid: "1", enabled: false }), makeSub({ uid: "2" })]);
		expect(Object.keys(buildAiSubsView(s.subscriptionStore, s.subRuntimeStore))).toEqual(["2"]);
	});

	it("用户手填的备注名优先于平台缓存 —— 主人自己起的名字最作数", () => {
		const s = makeStores([makeSub({ uid: "1", name: "老王" })], { "id-1": "平台上的花名" });
		expect(buildAiSubsView(s.subscriptionStore, s.subRuntimeStore)["1"]?.uname).toBe("老王");
	});
});
