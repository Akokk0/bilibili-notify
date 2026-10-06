/**
 * B 站的大航海档位表(㉓b)。`guard_level` 与 rank 的倒序换算全仓只许住在 `bilibili-guard.ts` 这一个文件里,
 * 期望值都是手写的字面量(来自 ㉓a 钉住的现状:出图器的宣告语、`GUARD_LEVEL_IMG`、`BG_COLORS`),不照着实现再算一遍。
 */

import { describe, expect, it } from "vite-plus/test";
import {
	BILIBILI_GUARD_PROGRAM,
	GUARD_PROGRAM_ID,
	guardTierByKey,
	guardTierOf,
} from "../bilibili-guard";
import { interpolate } from "../util/interpolate";

describe("guardTierOf —— B 站 guard_level → 档(倒序换算只在这一个文件)", () => {
	it("1 = 总督、2 = 提督、3 = 舰长,rank 与 guard_level 反着来(舰长最低)", () => {
		expect(guardTierOf(1)).toMatchObject({ key: "governor", name: "总督", rank: 3 });
		expect(guardTierOf(2)).toMatchObject({ key: "commander", name: "提督", rank: 2 });
		expect(guardTierOf(3)).toMatchObject({ key: "captain", name: "舰长", rank: 1 });
	});

	it("认不出的一律 undefined:0、比 3 大的、负数、小数、NaN", () => {
		for (const level of [0, 4, 99, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(guardTierOf(level), `guard_level ${level}`).toBeUndefined();
		}
	});

	it("回的就是体系里那一档本身(同一份数据,不另造)", () => {
		const tiers = BILIBILI_GUARD_PROGRAM.tiers;
		if (tiers === "custom") throw new Error("B 站的大航海是固定三档");
		expect(guardTierOf(3)).toBe(tiers.find((t) => t.key === "captain"));
		expect(guardTierOf(1)).toBe(tiers.find((t) => t.key === "governor"));
	});
});

describe("guardTierByKey —— 按档的 key 找档(㉓e,预览请求体带的是 key)", () => {
	it("三个 key 各找到自己那一档,与 guardTierOf 找到的是同一个对象", () => {
		expect(guardTierByKey("captain")).toBe(guardTierOf(3));
		expect(guardTierByKey("commander")).toBe(guardTierOf(2));
		expect(guardTierByKey("governor")).toBe(guardTierOf(1));
	});

	it("认不出的 key 回 undefined,原型上的名字也不算", () => {
		for (const key of ["", "captain ", "Captain", "constructor", "toString", "1"]) {
			expect(guardTierByKey(key), key).toBeUndefined();
		}
	});
});

describe("BILIBILI_GUARD_PROGRAM —— 体系与档", () => {
	it("体系 id 是 guard(设置里 templates.membership / membership.minRank 的键就是它),体系本身用的也是这一个常量", () => {
		expect(GUARD_PROGRAM_ID).toBe("guard");
		expect(BILIBILI_GUARD_PROGRAM.id).toBe(GUARD_PROGRAM_ID);
	});

	it("体系 id 是 guard、叫「大航海」,三档按 rank 升序:舰长 1、提督 2、总督 3", () => {
		expect(BILIBILI_GUARD_PROGRAM.id).toBe("guard");
		expect(BILIBILI_GUARD_PROGRAM.name).toBe("大航海");
		expect(BILIBILI_GUARD_PROGRAM.tiers).toMatchObject([
			{ key: "captain", name: "舰长", rank: 1 },
			{ key: "commander", name: "提督", rank: 2 },
			{ key: "governor", name: "总督", rank: 3 },
		]);
	});
});

describe("BILIBILI_GUARD_PROGRAM —— 档色(留卡片那一套)", () => {
	it("舰长 #4ebcec、提督 #d8a0e6、总督 #f2a053", () => {
		expect(guardTierOf(3)?.color).toBe("#4ebcec");
		expect(guardTierOf(2)?.color).toBe("#d8a0e6");
		expect(guardTierOf(1)?.color).toBe("#f2a053");
		// 止色:卡的背景从档色渐变到它(0.x 的会员卡就是这三对)。
		expect(guardTierOf(3)?.colorEnd).toBe("#b494e5");
		expect(guardTierOf(2)?.colorEnd).toBe("#b494e5");
		expect(guardTierOf(1)?.colorEnd).toBe("#ef5f5f");
	});
});

describe("BILIBILI_GUARD_PROGRAM —— 徽章(今天那三条官方图链,逐字)", () => {
	it("每档的 icon 是只带 url 的图(图到 3a 才存进图库,没有 ref)", () => {
		expect(guardTierOf(3)?.icon).toEqual({
			url: "https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/captain-Bjw5Byb5.png",
		});
		expect(guardTierOf(2)?.icon).toEqual({
			url: "https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/supervisor-u43ElIjU.png",
		});
		expect(guardTierOf(1)?.icon).toEqual({
			url: "https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/governor-DpDXKEdA.png",
		});
	});
});

describe("BILIBILI_GUARD_PROGRAM —— 宣告语", () => {
	// 期望值是 ㉓a 钉在出图器里的那三句(`blocks/membership.tsx` 的 `GUARD_DESC`)的字面值:引号是半角双引号,
	// 换行是真换行,只有舰长那句带「号」。拿它们比,才能证明搬到档位表以后一个字没变。
	it.each([
		[3, '"示例观众号"加入\n"示例主播"大航海舰队！'],
		[2, '"示例观众"就任\n"示例主播"大航海舰队提督！'],
		[1, '"示例观众"上任\n"示例主播"大航海舰队总督！'],
	] as const)(
		"guard_level=%s 的宣告语,用 `interpolate` 填上观众名与主播名后与出图器今天那句逐字相同",
		(level, expected) => {
			const tier = guardTierOf(level);
			expect(tier?.announcement).toBeDefined();
			expect(
				interpolate(tier?.announcement ?? "", {
					viewer: "示例观众",
					name: "示例主播",
					tier: tier?.name ?? "",
				}),
			).toBe(expected);
		},
	);
});
