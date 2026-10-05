/**
 * B 站 `guard-buy` 事件 → 中立的会员事件(㉓b,纯新增、还没有调用方;接线在 ㉓c)。
 * 期望值都是手写的字面量。事件字段取 `packages/blive` 解析器今天产出的形状:价格是金瓜子(÷1000 为人民币),
 * 没有头像、没有房管标记;开通还是续费、谁送的,上舰消息里没有,所以不填。
 */

import type { LiveEvent } from "@bilibili-notify/blive";
import { describe, expect, it } from "vite-plus/test";
import { membershipEventFromLiveEvent } from "../membership-event";

type GuardBuy = Extract<LiveEvent, { kind: "guard-buy" }>;

function guardBuy(over: Partial<GuardBuy> = {}): GuardBuy {
	return {
		kind: "guard-buy",
		guardLevel: 3,
		giftName: "舰长",
		user: { uid: 1001, uname: "示例观众" },
		...over,
	};
}

describe("membershipEventFromLiveEvent —— B 站上舰 → 会员事件", () => {
	it("舰长:体系 guard、档 captain / 舰长 / rank 1,观众 id 是字符串的 uid,订阅 id 原样带上", () => {
		expect(membershipEventFromLiveEvent(guardBuy(), "sub-1")).toStrictEqual({
			subscriptionId: "sub-1",
			viewer: { id: "1001", name: "示例观众" },
			program: "guard",
			tier: { key: "captain", name: "舰长", rank: 1 },
		});
	});

	it("提督 rank 2、总督 rank 3(guard_level 与 rank 反着来)", () => {
		expect(membershipEventFromLiveEvent(guardBuy({ guardLevel: 2 }), "s")?.tier).toStrictEqual({
			key: "commander",
			name: "提督",
			rank: 2,
		});
		expect(membershipEventFromLiveEvent(guardBuy({ guardLevel: 1 }), "s")?.tier).toStrictEqual({
			key: "governor",
			name: "总督",
			rank: 3,
		});
	});

	it("事件带月数就填 months,带价格就填金额(金瓜子 ÷ 1000 = 人民币)与币种 CNY", () => {
		expect(
			membershipEventFromLiveEvent(guardBuy({ num: 3, price: 198000 }), "sub-1"),
		).toStrictEqual({
			subscriptionId: "sub-1",
			viewer: { id: "1001", name: "示例观众" },
			program: "guard",
			tier: { key: "captain", name: "舰长", rank: 1 },
			months: 3,
			amount: 198,
			currency: "CNY",
		});
		expect(membershipEventFromLiveEvent(guardBuy({ price: 138000 }), "s")).toMatchObject({
			amount: 138,
			currency: "CNY",
		});
	});

	it("事件没带月数 / 价格 → 这几格缺键(不编成 0);金额与币种成对出现、不会只来一个", () => {
		const only = membershipEventFromLiveEvent(guardBuy({ num: 1 }), "s");
		expect(only).toStrictEqual({
			subscriptionId: "s",
			viewer: { id: "1001", name: "示例观众" },
			program: "guard",
			tier: { key: "captain", name: "舰长", rank: 1 },
			months: 1,
		});
		const none = membershipEventFromLiveEvent(guardBuy(), "s");
		expect(Object.keys(none ?? {})).not.toContain("months");
		expect(Object.keys(none ?? {})).not.toContain("amount");
		expect(Object.keys(none ?? {})).not.toContain("currency");
	});

	it("不填头像、开通还是续费、谁送的、时长等级(上舰消息里没有)", () => {
		const e = membershipEventFromLiveEvent(
			guardBuy({ num: 1, price: 198000, giftId: 10003, startTime: 1, endTime: 2 }),
			"s",
		);
		expect(e?.viewer).toStrictEqual({ id: "1001", name: "示例观众" });
		for (const key of ["action", "gift", "tenure"]) {
			expect(Object.keys(e ?? {}), key).not.toContain(key);
		}
	});

	it("认不出的档位(guard_level 不是 1 / 2 / 3)→ undefined,由调用方丢弃并记警告", () => {
		for (const level of [0, 4, -1]) {
			expect(
				membershipEventFromLiveEvent(guardBuy({ guardLevel: level }), "s"),
				`guard_level ${level}`,
			).toBeUndefined();
		}
	});
});
