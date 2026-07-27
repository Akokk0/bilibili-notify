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

	it("imageGroup 判定保持不变", () => {
		const sub = subWith({ imageGroup: { enable: true, forward: false } });
		expect(isSectionCustomized(sub, "imageGroup")).toBe(true);
		expect(isSectionCustomized(sub, "filter")).toBe(false);
	});
});

/**
 * AI 那一格判的是「**挑中的人格真实存在**」,而不是 `overrides.ai` 这个键在不在。
 *
 * 盘上有三种指不着人格的老值(当年那档「继承全局」/「完全自定义」、以及指向一份
 * 后来被删掉的人格),它们在 `resolveAI` 眼里都是完整继承全局,`AiOverrideBox` 也
 * 照实显示成「关」。侧栏小点若只看键在不在,就会在一个明明写着「继承」的分类旁边
 * 亮起来 —— 两处口径打架,而这个文件存在的理由就是不让它们打架。
 */
describe("isSectionCustomized — AI 人格", () => {
	const PRESETS = [{ id: "gentle-maid" }, { id: "tsundere" }];

	it("挑中一份真实存在的人格 → 小点亮", () => {
		expect(isSectionCustomized(subWith({ ai: { preset: "tsundere" } }), "ai", PRESETS)).toBe(true);
	});

	for (const stale of ["inherit", "custom", "deleted-preset-id"]) {
		it(`指不着人格的老值 '${stale}' → 小点不亮(那一格显示的正是「继承」)`, () => {
			expect(isSectionCustomized(subWith({ ai: { preset: stale } }), "ai", PRESETS)).toBe(false);
		});
	}

	it("压根没有 ai 覆盖 → 小点不亮", () => {
		expect(isSectionCustomized(subWith({}), "ai", PRESETS)).toBe(false);
	});
});
