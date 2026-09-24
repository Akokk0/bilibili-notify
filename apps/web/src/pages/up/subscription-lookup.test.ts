/**
 * 订阅查表(ADR-0019 决策 50):面板上「这一行 / 这个房间是哪条订阅」。
 *
 * - 按订阅自己的 id 查;
 * - 历史行先认 `subscriptionId`,不在了(删了又重加的 UP)再找第一个 uid 相同的 **B 站**订阅 ——
 *   与服务端重推的 `currentSubscriptionOf` 同一条规矩,同 uid 两条时**先出现的**说了算;
 * - 拓展订阅的外部 id 恰好等于那串 uid 不算:那是另一个平台上的另一个人。
 */

import { describe, expect, it } from "vite-plus/test";
import {
	makeEmptyExtensionSubscription,
	makeEmptySubscription,
	type Subscription,
} from "../../types/domain";
import { createSubscriptionLookup } from "./subscription-lookup";

function bili(id: string, uid: string): Subscription {
	return { ...makeEmptySubscription(uid), id };
}

const FIRST = bili("s-first", "u1");
const SECOND = bili("s-second", "u1");
const EXT = { ...makeEmptyExtensionSubscription("douyin", "u9"), id: "s-ext" };

describe("createSubscriptionLookup", () => {
	const lookup = createSubscriptionLookup([FIRST, SECOND, EXT]);

	it("byId:按订阅自己的 id 查,拓展订阅也查得到;没有就是 undefined", () => {
		expect(lookup.byId("s-second")).toBe(SECOND);
		expect(lookup.byId("s-ext")).toBe(EXT);
		expect(lookup.byId("s-gone")).toBeUndefined();
	});

	it("forRow:id 还在 → 就是它,哪怕同 uid 还有一条排在前面", () => {
		expect(lookup.forRow({ subscriptionId: "s-second", uid: "u1" })).toBe(SECOND);
	});

	it("forRow:id 不在了 → 回落到 uid 相同的 B 站订阅,两条时先出现的那条", () => {
		expect(lookup.forRow({ subscriptionId: "s-gone", uid: "u1" })).toBe(FIRST);
	});

	it("forRow:拓展订阅的外部 id 恰好等于那串 uid → 不算", () => {
		expect(lookup.forRow({ subscriptionId: "s-gone", uid: "u9" })).toBeUndefined();
	});

	it("forRow:id 与 uid 都对不上 → undefined", () => {
		expect(lookup.forRow({ subscriptionId: "s-gone", uid: "u404" })).toBeUndefined();
	});
});

/**
 * 拓展行(ADR-0019 决策 73):先认 `subscriptionId`,不在了按「同一个拓展 + 同一个外部 id」找第一条
 * **拓展**订阅;绝不跨支 —— 与服务端重推的 `currentSubscriptionOf` 同一条规矩。
 */
describe("createSubscriptionLookup — 拓展行", () => {
	const OTHER_EXT = { ...makeEmptyExtensionSubscription("kuaishou", "sec-1"), id: "s-kuaishou" };
	const EXT_A = { ...makeEmptyExtensionSubscription("douyin", "sec-1"), id: "s-ext-a" };
	const EXT_B = { ...makeEmptyExtensionSubscription("douyin", "sec-1"), id: "s-ext-b" };
	const BILI = bili("s-bili", "123");
	const lookup = createSubscriptionLookup([BILI, OTHER_EXT, EXT_A, EXT_B]);
	const extRow = (subscriptionId: string, externalId = "sec-1") => ({
		subscriptionId,
		extensionId: "douyin",
		externalId,
	});

	it("forRow:id 还在 → 就是它,哪怕同一个人还有一条排在前面", () => {
		expect(lookup.forRow(extRow("s-ext-b"))).toBe(EXT_B);
	});

	it("forRow:id 不在了 → 同一个拓展 + 同一个外部 id 的拓展订阅,两条时先出现的那条", () => {
		expect(lookup.forRow(extRow("s-gone"))).toBe(EXT_A);
	});

	it("forRow:外部 id 相同、拓展不同 → 不算", () => {
		expect(
			lookup.forRow({ subscriptionId: "s-gone", extensionId: "weibo", externalId: "sec-1" }),
		).toBeUndefined();
	});

	it("forRow:跨支不认 —— 外部 id 恰好等于某个 B 站 uid,不认成那条 B 站订阅", () => {
		expect(lookup.forRow(extRow("s-gone", "123"))).toBeUndefined();
	});

	it("forRow:跨支不认 —— B 站行的 uid 恰好等于某个拓展订阅的外部 id,不认成那条拓展订阅", () => {
		expect(lookup.forRow({ subscriptionId: "s-gone", uid: "sec-1" })).toBeUndefined();
	});
});
