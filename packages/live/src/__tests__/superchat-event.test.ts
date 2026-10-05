/**
 * B 站 `superchat` 事件 → 中立的醒目留言事件(㉓b,纯新增、还没有调用方;接线在 ㉓c)。
 * 期望值都是手写的字面量。事件字段取 `packages/blive` 解析器今天产出的形状:价格是元,`durationSec` 是消息自带的秒数
 * (解析器早就读出来了,原来没往下传)。醒目留言「按价格算档」从出图器搬到这里,六档的线与 ㉓a 钉在出图器里的那六档
 * 同一组(<50 / 50–99 / 100–499 / 500–999 / 1000–1999 / ≥2000 元),只是 rank 从 1 起。
 */

import type { LiveEvent } from "@bilibili-notify/blive";
import { describe, expect, it } from "vite-plus/test";
import { superchatEventFromLiveEvent } from "../superchat-event";

type SuperChat = Extract<LiveEvent, { kind: "superchat" }>;

function superchat(over: Partial<SuperChat> = {}): SuperChat {
	return {
		kind: "superchat",
		content: "主播加油！",
		price: 30,
		user: { uid: 2002, uname: "示例观众" },
		...over,
	};
}

describe("superchatEventFromLiveEvent —— B 站醒目留言 → 中立事件", () => {
	it("金额是事件的价格(元)、币种 CNY,正文、观众(id 是字符串的 uid)、订阅 id 原样带上", () => {
		expect(superchatEventFromLiveEvent(superchat(), "sub-1")).toStrictEqual({
			subscriptionId: "sub-1",
			viewer: { id: "2002", name: "示例观众" },
			text: "主播加油！",
			amount: 30,
			currency: "CNY",
			tier: { rank: 1 },
		});
	});

	// 五条线两侧各一个价:49 | 50、99 | 100、499 | 500、999 | 1000、1999 | 2000。
	it.each([
		[1, 1],
		[30, 1],
		[49, 1],
		[50, 2],
		[99, 2],
		[100, 3],
		[499, 3],
		[500, 4],
		[999, 4],
		[1000, 5],
		[1999, 5],
		[2000, 6],
		[5000, 6],
	] as const)("%s 元 → rank %s(六档,从 1 起)", (price, rank) => {
		expect(superchatEventFromLiveEvent(superchat({ price }), "s").tier?.rank).toBe(rank);
	});

	it("留言时长取事件自带的秒数(不再按档位反推)", () => {
		expect(
			superchatEventFromLiveEvent(superchat({ price: 30, durationSec: 60 }), "s").tier,
		).toStrictEqual({ rank: 1, durationSec: 60 });
		// 消息自带的秒数照给,不拿档位去反推(价位与挂多久不保证一一对得上)。
		expect(
			superchatEventFromLiveEvent(superchat({ price: 500, durationSec: 1800 }), "s").tier,
		).toStrictEqual({ rank: 4, durationSec: 1800 });
	});

	it("事件没带时长 → tier 里没有 durationSec 这一格(不编成 0)", () => {
		const tier = superchatEventFromLiveEvent(superchat({ price: 100 }), "s").tier;
		expect(tier).toStrictEqual({ rank: 3 });
		expect(Object.keys(tier ?? {})).not.toContain("durationSec");
	});
});
