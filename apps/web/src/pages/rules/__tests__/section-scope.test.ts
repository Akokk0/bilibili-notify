import { describe, expect, it } from "vite-plus/test";
import { makeEmptySubscription, type Subscription } from "../../../types/domain";
import { isSectionCustomized } from "../section-scope";

/**
 * 回归:「动态过滤」与「直播阈值」两个 section 共享同一个 overrides.filters 切片
 * (block* 属过滤域,minScPrice/minGuardLevel 属阈值域)。侧栏「已覆盖」小红点
 * 若只判 `overrides.filters !== undefined`,开其中一个域就会让另一个 section 的
 * 小点也亮起来 —— 必须按各自域内的字段判定。
 */

function subWith(overrides: Subscription["overrides"]): Subscription {
	return { ...makeEmptySubscription("123456"), overrides };
}

describe("isSectionCustomized filter / live 分域", () => {
	it("只有过滤域覆盖(blockKeywords)→ filter 小点亮、live 小点不亮", () => {
		const sub = subWith({ filters: { blockKeywords: ["广告"] } });
		expect(isSectionCustomized(sub, "filter")).toBe(true);
		expect(isSectionCustomized(sub, "live")).toBe(false);
	});

	it("只有阈值域覆盖(minScPrice)→ live 小点亮、filter 小点不亮", () => {
		const sub = subWith({ filters: { minScPrice: 30 } });
		expect(isSectionCustomized(sub, "live")).toBe(true);
		expect(isSectionCustomized(sub, "filter")).toBe(false);
	});

	it("只有阈值域覆盖(minGuardLevel)→ live 小点亮、filter 小点不亮", () => {
		const sub = subWith({ filters: { minGuardLevel: 2 } });
		expect(isSectionCustomized(sub, "live")).toBe(true);
		expect(isSectionCustomized(sub, "filter")).toBe(false);
	});

	it("只有 schedule 覆盖 → live 小点亮、filter 小点不亮", () => {
		const sub = subWith({ schedule: { pushTime: 3 } });
		expect(isSectionCustomized(sub, "live")).toBe(true);
		expect(isSectionCustomized(sub, "filter")).toBe(false);
	});

	it("两域都覆盖 → 两个小点都亮", () => {
		const sub = subWith({ filters: { blockKeywords: ["广告"], minScPrice: 30 } });
		expect(isSectionCustomized(sub, "filter")).toBe(true);
		expect(isSectionCustomized(sub, "live")).toBe(true);
	});

	it("无任何覆盖 → 两个小点都不亮", () => {
		const sub = subWith({});
		expect(isSectionCustomized(sub, "filter")).toBe(false);
		expect(isSectionCustomized(sub, "live")).toBe(false);
	});

	it("其余 section 判定保持不变(imageGroup / ai)", () => {
		const sub = subWith({
			imageGroup: { enable: true, forward: false },
			ai: { preset: "inherit" },
		});
		expect(isSectionCustomized(sub, "imageGroup")).toBe(true);
		expect(isSectionCustomized(sub, "ai")).toBe(true);
		expect(isSectionCustomized(sub, "filter")).toBe(false);
	});
});
