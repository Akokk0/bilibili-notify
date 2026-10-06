/**
 * 醒目留言卡的**中立输入 → 视图**(`buildSuperchatCardView`,㉓c)。块与皮肤契约吃的是视图,这里钉视图里每一格怎么来:
 * 金额与时长排成字、档位夹进 1–6 并取默认配色、头像引用换成可画的地址。期望值都是手写的字面量。
 */

import type { ImageRef } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { buildSuperchatCardView } from "../superchat-view";
import type { SuperchatCardInput } from "../templates/superchat-card";

function input(over: Partial<SuperchatCardInput> = {}): SuperchatCardInput {
	return {
		viewer: { name: "观众" },
		creator: { name: "主播" },
		text: "加油",
		amount: 30,
		currency: "CNY",
		...over,
	};
}

describe("buildSuperchatCardView", () => {
	it("名字、留言原样;金额排成字(formatAmount)、数字另给", () => {
		const view = buildSuperchatCardView(input({ amount: 30.5, currency: "USD" }));
		expect(view.viewerName).toBe("观众");
		expect(view.creatorName).toBe("主播");
		expect(view.text).toBe("加油");
		expect(view.amount).toBe("US$30.5");
		expect(view.amountValue).toBe(30.5);
	});

	it("金额不是有限的数 → 金额文字空串、数字 0(契约里的数字永不是 NaN)", () => {
		const view = buildSuperchatCardView(input({ amount: Number.NaN }));
		expect(view.amount).toBe("");
		expect(view.amountValue).toBe(0);
	});

	// 验红:去掉 `effectiveTierRank` 里的 `Math.max(1, …)`,rank 0 / 负数那几行红(视图里 rank 会是 0 / 负数)。
	it("rank 是夹进 1–6 的有效档位(与取色用的是同一个值):没有 tier 是 1、超出 6 是 6、小数向下取整", () => {
		const rankOf = (tier?: { rank: number }) =>
			buildSuperchatCardView(input(tier ? { tier } : {})).rank;
		expect(rankOf()).toBe(1);
		expect(rankOf({ rank: 1 })).toBe(1);
		expect(rankOf({ rank: 6 })).toBe(6);
		expect(rankOf({ rank: 7 })).toBe(6);
		expect(rankOf({ rank: 3.9 })).toBe(3);
		expect(rankOf({ rank: 0 })).toBe(1);
		expect(rankOf({ rank: -4 })).toBe(1);
		expect(rankOf({ rank: Number.NaN })).toBe(1);
	});

	it("bgColor 是默认配色表里 rank 那一对(起色、止色)", () => {
		expect(buildSuperchatCardView(input({ tier: { rank: 1 } })).bgColor).toEqual([
			"#a8e6cf",
			"#88d8b0",
		]);
		expect(buildSuperchatCardView(input({ tier: { rank: 4 } })).bgColor).toEqual([
			"#fd79a8",
			"#e84393",
		]);
		expect(buildSuperchatCardView(input({ tier: { rank: 6 } })).bgColor).toEqual([
			"#ff7675",
			"#d63031",
		]);
		expect(buildSuperchatCardView(input({ tier: { rank: 99 } })).bgColor).toEqual([
			"#ff7675",
			"#d63031",
		]);
	});

	// 验红:把 `superchat-view.ts` 的 `durationText` 里 `durationSec <= 0` 的守卫去掉,「0 / 负数」那两行红。
	it("留言时长走 formatDuration;没给、0、负数、不是有限的数都是空串(时长块收起)", () => {
		const durationOf = (durationSec?: number) =>
			buildSuperchatCardView(input({ tier: { rank: 2, durationSec } })).duration;
		expect(durationOf(60)).toBe("1分");
		expect(durationOf(7200)).toBe("2小时");
		expect(durationOf(90)).toBe("1分30秒");
		expect(durationOf()).toBe("");
		expect(durationOf(0)).toBe("");
		expect(durationOf(-1)).toBe("");
		expect(durationOf(Number.POSITIVE_INFINITY)).toBe("");
		expect(buildSuperchatCardView(input()).duration).toBe("");
	});

	describe("头像:引用经解析口换成可画的地址,解析不到就没有", () => {
		const VIEWER = `${"a".repeat(63)}1.png` as ImageRef;
		const MASTER = `${"b".repeat(63)}2.png` as ImageRef;
		const imageUrl = (ref: ImageRef) =>
			ref === VIEWER ? "data:viewer" : ref === MASTER ? "data:master" : undefined;

		it("解析到了 → 地址", () => {
			const view = buildSuperchatCardView(
				input({
					viewer: { name: "观众", avatar: VIEWER },
					creator: { name: "主播", avatar: MASTER },
				}),
				{ imageUrl },
			);
			expect(view.viewerAvatarUrl).toBe("data:viewer");
			expect(view.creatorAvatarUrl).toBe("data:master");
		});

		// 验红:把 `viewerAvatarUrl` 那一句的 `|| ""` 去掉,观众头像「没给」那一行红(是 undefined 不是空串)。
		it("没给头像、没给解析口、解析不到 → 观众头像是空串、主播头像不给(undefined)", () => {
			for (const opts of [undefined, { imageUrl: () => undefined }]) {
				const view = buildSuperchatCardView(
					input({
						viewer: { name: "观众", avatar: VIEWER },
						creator: { name: "主播", avatar: MASTER },
					}),
					opts,
				);
				expect(view.viewerAvatarUrl).toBe("");
				expect(view.creatorAvatarUrl).toBeUndefined();
			}
			const bare = buildSuperchatCardView(input());
			expect(bare.viewerAvatarUrl).toBe("");
			expect(bare.creatorAvatarUrl).toBeUndefined();
		});
	});
});
