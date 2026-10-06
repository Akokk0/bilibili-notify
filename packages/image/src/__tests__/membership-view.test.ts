/**
 * 会员卡的**中立输入 → 视图**(`buildMembershipCardView`,㉓c)。视图里每一格怎么来:宣告语经 `interpolate` 填好、
 * 档色是一个值、徽章与头像的图库引用换成可画的地址、没有 rank 的档是 0。期望值都是手写的字面量。
 */

import type { ImageRef } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { buildMembershipCardView } from "../membership-view";
import type { MembershipCardInput } from "../templates/membership-card";

function input(over: Partial<MembershipCardInput> = {}): MembershipCardInput {
	return {
		viewer: { name: "观众" },
		creator: { name: "主播" },
		tier: { name: "银牌", rank: 2 },
		...over,
	};
}

describe("buildMembershipCardView", () => {
	it("名字、档名、rank 原样", () => {
		const view = buildMembershipCardView(input());
		expect(view.viewerName).toBe("观众");
		expect(view.creatorName).toBe("主播");
		expect(view.tierName).toBe("银牌");
		expect(view.rank).toBe(2);
	});

	// 验红:把 `rank` 的缺省 0 改成 1,这条红 —— 没有 rank 的档不能冒充第 1 档。
	it("没有 rank 的档(或 rank 不是有限的数)→ 0", () => {
		expect(buildMembershipCardView(input({ tier: { name: "自定义档" } })).rank).toBe(0);
		expect(buildMembershipCardView(input({ tier: { name: "x", rank: Number.NaN } })).rank).toBe(0);
	});

	// 验红:把 `interpolate` 的任一个键(viewer / name / tier)改名,这条红。
	it("宣告语:{viewer} 观众名、{name} 主播名、{tier} 档名填进去;没声明就是空串", () => {
		const view = buildMembershipCardView(
			input({ tier: { name: "银牌", announcement: '"{viewer}"加入"{name}"的{tier}' } }),
		);
		expect(view.announcement).toBe('"观众"加入"主播"的银牌');
		expect(buildMembershipCardView(input()).announcement).toBe("");
		expect(
			buildMembershipCardView(input({ tier: { name: "x", announcement: "" } })).announcement,
		).toBe("");
	});

	// 验红:把 `[value, value]` 改成 `[value, "#000000"]`,这条红;把回落改成默认配色表第 2 色,第二行红。
	// 验红:把止色改成恒取起色,这条红。
	it("声明了止色 → bgColor 是 [起色, 止色];只有止色没有起色 → 整个回落默认色", () => {
		expect(
			buildMembershipCardView(input({ tier: { name: "x", color: "#123456", colorEnd: "#abcdef" } }))
				.bgColor,
		).toEqual(["#123456", "#abcdef"]);
		expect(
			buildMembershipCardView(input({ tier: { name: "x", colorEnd: "#abcdef" } })).bgColor,
		).toEqual(["#a8e6cf", "#a8e6cf"]);
	});

	it("没声明止色:bgColor 起止同值;没有 color → 默认配色表第 1 色的起色", () => {
		expect(
			buildMembershipCardView(input({ tier: { name: "x", color: "#123456" } })).bgColor,
		).toEqual(["#123456", "#123456"]);
		expect(buildMembershipCardView(input()).bgColor).toEqual(["#a8e6cf", "#a8e6cf"]);
		expect(buildMembershipCardView(input({ tier: { name: "x", color: "" } })).bgColor).toEqual([
			"#a8e6cf",
			"#a8e6cf",
		]);
	});

	describe("徽章与头像:引用经解析口换成可画的地址,url 照用,解析不到就没有", () => {
		const ICON = `${"c".repeat(63)}3.png` as ImageRef;
		const VIEWER = `${"a".repeat(63)}1.png` as ImageRef;
		const MASTER = `${"b".repeat(63)}2.png` as ImageRef;
		const imageUrl = (ref: ImageRef) =>
			({ [ICON]: "data:icon", [VIEWER]: "data:viewer", [MASTER]: "data:master" })[ref];

		it("徽章:带 url 照用;带 ref 走解析口;解析不到或都没有是空串", () => {
			expect(
				buildMembershipCardView(input({ tier: { name: "x", icon: { url: "data:u" } } })).iconUrl,
			).toBe("data:u");
			expect(
				buildMembershipCardView(input({ tier: { name: "x", icon: { ref: ICON } } }), { imageUrl })
					.iconUrl,
			).toBe("data:icon");
			// `ref` 与 `url` 都有时认 `ref`;引用解析不到就是没有,不退回 `url`(引用说的是图库里那张)。
			const both = input({ tier: { name: "x", icon: { ref: ICON, url: "data:u" } } });
			expect(buildMembershipCardView(both, { imageUrl }).iconUrl).toBe("data:icon");
			expect(buildMembershipCardView(both, { imageUrl: () => undefined }).iconUrl).toBe("");
			expect(buildMembershipCardView(input()).iconUrl).toBe("");
		});

		it("头像:解析到了是地址,没给 / 解析不到都是空串", () => {
			const view = buildMembershipCardView(
				input({
					viewer: { name: "观众", avatar: VIEWER },
					creator: { name: "主播", avatar: MASTER },
				}),
				{ imageUrl },
			);
			expect(view.viewerAvatarUrl).toBe("data:viewer");
			expect(view.creatorAvatarUrl).toBe("data:master");
			const lost = buildMembershipCardView(
				input({
					viewer: { name: "观众", avatar: VIEWER },
					creator: { name: "主播", avatar: MASTER },
				}),
			);
			expect(lost.viewerAvatarUrl).toBe("");
			expect(lost.creatorAvatarUrl).toBe("");
		});
	});
});
