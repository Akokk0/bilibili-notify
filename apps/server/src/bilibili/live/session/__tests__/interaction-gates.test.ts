/**
 * 醒目留言与会员的门槛(㉓d):两条纯函数,直播间会话在推之前各问一次。
 * 期望值都是手写的字面量,不照着实现再算一遍。
 */

import { describe, expect, it } from "vite-plus/test";
import { passesMembershipMinRank, passesSuperchatMinAmount } from "../interaction-gates";

describe("passesSuperchatMinAmount —— 低于门槛才拦,等于放行", () => {
	const cny = (amount: number) => ({ amount, currency: "CNY" });

	it("没配门槛:全放行", () => {
		expect(passesSuperchatMinAmount(cny(1), undefined)).toBe(true);
		expect(passesSuperchatMinAmount(cny(0), undefined)).toBe(true);
	});

	it("等于门槛放行、低于拦、高于放行", () => {
		expect(passesSuperchatMinAmount(cny(30), 30)).toBe(true);
		expect(passesSuperchatMinAmount(cny(29), 30)).toBe(false);
		expect(passesSuperchatMinAmount(cny(31), 30)).toBe(true);
	});

	it("小数门槛、小数金额:按数值比", () => {
		expect(passesSuperchatMinAmount(cny(30.4), 30.5)).toBe(false);
		expect(passesSuperchatMinAmount(cny(30.5), 30.5)).toBe(true);
	});

	it("门槛 0 等于不设门槛(包括金额 0)", () => {
		expect(passesSuperchatMinAmount(cny(0), 0)).toBe(true);
		expect(passesSuperchatMinAmount(cny(5), 0)).toBe(true);
	});

	it("门槛按人民币算:别的币种放行,哪怕数字比门槛小", () => {
		expect(passesSuperchatMinAmount({ amount: 5, currency: "USD" }, 30)).toBe(true);
		expect(passesSuperchatMinAmount({ amount: 1, currency: "JPY" }, 30)).toBe(true);
		expect(passesSuperchatMinAmount({ amount: 1, currency: "cny" }, 30)).toBe(true);
	});
});

describe("passesMembershipMinRank —— rank 低于门槛才拦(1 最低)", () => {
	const tier = (rank: number | undefined) => ({
		tier: { key: "k", name: "n", ...(rank !== undefined ? { rank } : {}) },
	});

	it("没配门槛:三档全放行", () => {
		for (const rank of [1, 2, 3]) expect(passesMembershipMinRank(tier(rank), undefined)).toBe(true);
	});

	it("放行表:门槛 1 = 全推;门槛 2 = 提督以上;门槛 3 = 只推总督(三个门槛 × 三档,九格)", () => {
		const table: Array<[minRank: number, pass: [boolean, boolean, boolean]]> = [
			[1, [true, true, true]],
			[2, [false, true, true]],
			[3, [false, false, true]],
		];
		for (const [minRank, pass] of table) {
			expect([1, 2, 3].map((rank) => passesMembershipMinRank(tier(rank), minRank))).toEqual(pass);
		}
	});

	it("事件没带 rank(档位由主播自定的体系):没有可比的,放行", () => {
		expect(passesMembershipMinRank(tier(undefined), 3)).toBe(true);
	});
});
