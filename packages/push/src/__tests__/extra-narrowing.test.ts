/**
 * 单元测试 —— 附加项的**按目标收窄**(ADR-0016 决策 5 / 7)。
 *
 * 主特性的目标列表选出来之后,附加项再按自己那张三态表筛一道:`extras.<键>[目标]`
 * 显式 true / false 覆写,没这个 key 就跟随折叠后的默认(全局 + per-UP)。
 *
 * 这个文件专门钉**新行为**,与 `push-routing.test.ts` 里那批 @全体 用例
 * 互补 —— @全体 走的是推送层内部那条自己的分支(单独一条消息 + 平台能力),
 * 词云 / 总结走的是这条通用的收窄(附加项锚点带 `extra` 键)。
 *
 * 最要紧的一条是「收窄成空 ≠ 无目标」:本体那一行明明已经送达了,附加项只是
 * 谁都没订,落一行「无目标」等于把配置意图报成故障。
 */

import {
	type DeliveryResult,
	FEATURE_KEYS,
	type GlobalDefaults,
	makeDefaultGlobalConfig,
	makeEmptySubscription,
	type NotificationPayload,
	type PushTarget,
	type Subscription,
	sameIdentity,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import { describe, expect, it } from "vite-plus/test";
import { PushRouter, type PushSendResult } from "../push-router";
import {
	type FakeDispatcher,
	pushExtra,
	pushMain,
	setExtraDefault,
	silentLogger,
	trackedPushBase,
} from "./helpers";

function makeDispatcher(): { dispatcher: FakeDispatcher; calls: string[] } {
	const calls: string[] = [];
	const dispatcher: FakeDispatcher = {
		isAvailable: () => true,
		supportsAtAll: () => true,
		isEnabled: () => true,
		send: async (targetId) => {
			calls.push(targetId);
			return { ok: true, latencyMs: 1 } as DeliveryResult;
		},
		resolve: (id) =>
			({
				id,
				name: id,
				connectionId: "a",
				platform: "test",
				scope: "group",
				enabled: true,
			}) as unknown as PushTarget,
	};
	return { dispatcher, calls };
}

function makeStore(subs: Subscription[]): SubscriptionStore {
	return {
		list: () => [...subs],
		findByIdentity: (identity) =>
			subs.find((s) => sameIdentity(subscriptionIdentityOf(s), identity)),
		findById: (id) => subs.find((s) => s.id === id),
		upsert: () => {},
		removeById: () => undefined,
		replaceAll: () => {},
	};
}

function loopbackDefaults(): GlobalDefaults {
	const g = makeDefaultGlobalConfig();
	for (const k of FEATURE_KEYS) g.defaults.features[k] = true;
	g.defaults.schedule.quietHours = [];
	return g.defaults;
}

/** 三个目标都收下播本体的订阅;附加项的三态表由各用例自己填。 */
function subWithThreeLiveEndTargets(): Subscription {
	const sub = makeEmptySubscription({
		id: "s1",
		identity: { sourceKey: "bilibili", externalId: "u1" },
	});
	sub.routing.liveEnd = ["t1", "t2", "t3"];
	return sub;
}

function makePush(sub: Subscription, seen?: PushSendResult[]) {
	const { dispatcher, calls } = makeDispatcher();
	const defaults = loopbackDefaults();
	const { base, settled } = trackedPushBase();
	const push = new PushRouter({
		...base,
		defaults: () => defaults,
		dispatcher,
		store: makeStore([sub]),
		logger: silentLogger,
		onSend: seen ? (info) => seen.push(info) : undefined,
	});
	push.start();
	return { push, calls, settled };
}

const WORDCLOUD: NotificationPayload = { kind: "text", text: "词云" };

describe("附加项按目标收窄", () => {
	it("默认开着、某个目标显式关 → 那个目标收不到这条附加项,别人照收", async () => {
		const sub = subWithThreeLiveEndTargets();
		setExtraDefault(sub, "wordcloud", true);
		sub.extraTargets.wordcloud = { t1: false };
		const { push, calls, settled } = makePush(sub);
		await pushExtra(push, "s1", "liveEnd", WORDCLOUD, "wordcloud");
		await settled();
		expect(calls).toEqual(["t2", "t3"]);
	});

	it("默认关着、某个目标显式开 → 只有那个目标收得到(三态不是只能收窄)", async () => {
		const sub = subWithThreeLiveEndTargets();
		setExtraDefault(sub, "wordcloud", false);
		sub.extraTargets.wordcloud = { t2: true };
		const { push, calls, settled } = makePush(sub);
		await pushExtra(push, "s1", "liveEnd", WORDCLOUD, "wordcloud");
		await settled();
		expect(calls).toEqual(["t2"]);
	});

	it("两把键各走各的:关掉词云不影响 AI 总结", async () => {
		const sub = subWithThreeLiveEndTargets();
		setExtraDefault(sub, "wordcloud", true);
		setExtraDefault(sub, "liveSummary", true);
		sub.extraTargets.wordcloud = { t1: false, t2: false };
		const { push, calls, settled } = makePush(sub);
		await pushExtra(push, "s1", "liveEnd", WORDCLOUD, "wordcloud");
		await pushExtra(push, "s1", "liveEnd", WORDCLOUD, "liveSummary");
		await settled();
		expect(calls).toEqual(["t3", "t1", "t2", "t3"]);
	});

	it("收窄成空 → 一条都不发,而且**不落「无目标」那一行**", async () => {
		// 本体那一行本来就在、而且是「已送达」;附加项只是谁都没订,是配置意图不是故障。
		const sub = subWithThreeLiveEndTargets();
		setExtraDefault(sub, "wordcloud", true);
		sub.extraTargets.wordcloud = { t1: false, t2: false, t3: false };
		const seen: PushSendResult[] = [];
		const { push, calls, settled } = makePush(sub, seen);
		await pushExtra(push, "s1", "liveEnd", WORDCLOUD, "wordcloud");
		await settled();
		expect(calls).toEqual([]);
		expect(seen).toEqual([]);
	});

	it("主特性本来就没目标 → 仍照旧落「无目标」那一行(与收窄成空区分开)", async () => {
		const sub = makeEmptySubscription({
			id: "s1",
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		sub.routing.liveEnd = [];
		const seen: PushSendResult[] = [];
		const { push, calls, settled } = makePush(sub, seen);
		await pushExtra(push, "s1", "liveEnd", WORDCLOUD, "wordcloud");
		await settled();
		expect(calls).toEqual([]);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.target).toBeNull();
	});

	it("附加项锚点发出去的消息在历史里记成附加项", async () => {
		const sub = subWithThreeLiveEndTargets();
		sub.routing.liveEnd = ["t1"];
		setExtraDefault(sub, "wordcloud", true);
		const seen: PushSendResult[] = [];
		const { push, settled } = makePush(sub, seen);
		await pushExtra(push, "s1", "liveEnd", WORDCLOUD, "wordcloud");
		await settled();
		expect(seen[0]?.messages.map((m) => m.role)).toEqual(["extra"]);
	});

	it("本体不受三态表影响(本体不会被附加项的设置收窄)", async () => {
		const sub = subWithThreeLiveEndTargets();
		setExtraDefault(sub, "wordcloud", true);
		sub.extraTargets.wordcloud = { t1: false, t2: false, t3: false };
		const { push, calls } = makePush(sub);
		await pushMain(push, "s1", "liveEnd", { kind: "text", text: "下播卡" });
		expect(calls).toEqual(["t1", "t2", "t3"]);
	});

	it("行模型:本体发给两个目标、附加项只收窄到其中一个 → 那一个的行多一条消息", async () => {
		const sub = makeEmptySubscription({
			id: "s1",
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		sub.routing.liveEnd = ["t1", "t2"];
		setExtraDefault(sub, "wordcloud", true);
		sub.extraTargets.wordcloud = { t1: false };
		const seen: PushSendResult[] = [];
		const { push, settled } = makePush(sub, seen);
		await push.push({
			subscriptionId: "s1",
			feature: "liveEnd",
			anchors: [
				{ role: "main", messages: [{ kind: "text", text: "下播卡" }] },
				{ role: "extra", extra: "wordcloud", messages: [WORDCLOUD] },
			],
		});
		await settled();
		// 同一个 pushId 下:t1 只有本体那一条,t2 本体 + 附加项两条。
		const byTarget = new Map<string, string[]>();
		for (const info of seen) {
			const id = info.target?.id ?? "(null)";
			byTarget.set(id, [...(byTarget.get(id) ?? []), ...info.messages.map((m) => m.role)]);
		}
		expect(byTarget.get("t1")).toEqual(["main"]);
		expect(byTarget.get("t2")).toEqual(["main", "extra"]);
		expect(new Set(seen.map((i) => i.pushId)).size).toBe(1);
	});
});
