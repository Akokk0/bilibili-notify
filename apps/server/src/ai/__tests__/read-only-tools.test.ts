/**
 * 单元测试 — `attachReadOnlyTools`(独立端把工具能力接给女仆的唯一入口)。
 *
 * 这个模块存在的理由只有一条:**主人选的是只读档。**`CommentaryGenerator`
 * 的工具表里既有 list_subscriptions 这种查询,也有 subscribe_user /
 * unsubscribe_user / update_subscription 这种真会改订阅的;后者只在
 * `setSubManagement` 收到 `subMgmt` 时才可用。所以「只读」不是一句注释,
 * 而是「调用时不带 subMgmt」这一个具体动作 —— 由下面的测试钉住。
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

describe("attachReadOnlyTools — 只读档", () => {
	it("绝不把 subMgmt 交出去 —— 交了 AI 就能真的加减订阅", () => {
		const setSubManagement = vi.fn();
		const stores = makeStores([]);
		attachReadOnlyTools({ setSubManagement }, stores);

		expect(setSubManagement).toHaveBeenCalledTimes(1);
		const arg = setSubManagement.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(arg).toHaveProperty("getSubs");
		// `undefined` 也不行:引擎读的是 `opts.subMgmt ?? null`,给 undefined 与
		// 不给等价 —— 但显式写出这条断言,是为了让任何一次「顺手补上 subMgmt」
		// 的改动都撞红,而不是悄悄放开写权限。
		expect(arg.subMgmt).toBeUndefined();
	});

	it("getSubs 是每次现取的,不是接线那一刻的快照", () => {
		const setSubManagement = vi.fn();
		const subs: Subscription[] = [];
		attachReadOnlyTools({ setSubManagement }, makeStores(subs));
		const getSubs = (setSubManagement.mock.calls[0]?.[0] as { getSubs: () => unknown }).getSubs;

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
