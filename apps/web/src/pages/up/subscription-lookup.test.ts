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
