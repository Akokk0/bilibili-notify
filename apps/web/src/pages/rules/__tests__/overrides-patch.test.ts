import { describe, expect, it } from "vite-plus/test";
import type { OverridesShape } from "../../../types/domain";
import { buildOverridesPatch } from "../overrides-patch";

/**
 * 回归:关闭某 per-UP 覆盖框后保存不生效。setSlice 把整段 slice 从草稿删除,
 * 但若 PATCH body 只是「缺这个键」,store deepMerge 当「不改」→ 旧 slice 残留,
 * 灵动岛 diff 永不归零(刚报「已保存」又立刻跳「有改动」)。buildOverridesPatch
 * 必须对「baseline 有、draft 已删」的 slice 回填显式 null(SY1 清除哨兵)。
 */
describe("buildOverridesPatch", () => {
	it("回填 null 清除被关闭的覆盖 slice(imageGroup)", () => {
		const base: OverridesShape = { imageGroup: { enable: false, forward: false } };
		const draft: OverridesShape = {}; // 用户关闭覆盖框 → slice 已删
		const patch = buildOverridesPatch(draft, base);
		expect(patch.imageGroup).toBeNull();
		// JSON 线格式确实带上 null(不会被 JSON.stringify 丢弃)。
		expect(JSON.parse(JSON.stringify(patch))).toEqual({ imageGroup: null });
	});

	it("仍存在的 slice 原样保留、不被 null 化", () => {
		const base: OverridesShape = { imageGroup: { enable: true, forward: false } };
		const draft: OverridesShape = { imageGroup: { enable: false, forward: false } };
		const patch = buildOverridesPatch(draft, base);
		expect(patch.imageGroup).toEqual({ enable: false, forward: false });
	});

	it("baseline 没有的 slice 被关闭 → 不下发 null(无需清除)", () => {
		const patch = buildOverridesPatch({}, {});
		expect("imageGroup" in patch).toBe(false);
		expect(patch).toEqual({});
	});

	it("新开启的 slice 原样下发", () => {
		const patch = buildOverridesPatch({ filters: { minScPrice: 30 } }, {});
		expect(patch.filters).toEqual({ minScPrice: 30 });
	});

	it("清空全部覆盖(draft={}):每个现存 slice 都置 null", () => {
		// 「移除该 UP 个性化配置」走此路径 —— 发空对象不删任何键,须逐 slice null。
		const base: OverridesShape = {
			filters: { minScPrice: 30 },
			imageGroup: { enable: true, forward: true },
			templates: { liveSummary: "x" },
		};
		const patch = buildOverridesPatch({}, base);
		expect(patch).toEqual({ filters: null, imageGroup: null, templates: null });
	});

	it("多 slice:一个保留、一个清除", () => {
		const base: OverridesShape = {
			filters: { minScPrice: 30 },
			imageGroup: { enable: true, forward: true },
		};
		const draft: OverridesShape = { filters: { minScPrice: 50 } };
		const patch = buildOverridesPatch(draft, base);
		expect(patch.filters).toEqual({ minScPrice: 50 });
		expect(patch.imageGroup).toBeNull();
	});

	/**
	 * 回归:同一个 slice 被两个 section 分域共写(filters = 动态过滤域字段 +
	 * 直播阈值域字段)。只清掉自己域内的字段、slice 本身仍非空时,旧写法把
	 * draft.filters 整个原样下发 —— 被删的字段"不提"而非显式 null,服务端
	 * deepMerge 当"不改"→旧值残留,关闭的开关保存后又"复活"。
	 */
	it("slice 内单个字段被删、其余字段仍在 → 该字段回填 null,其余字段原样保留", () => {
		const base: OverridesShape = {
			filters: { blockKeywords: ["广告"], minScPrice: 30 },
		};
		const draft: OverridesShape = {
			filters: { minScPrice: 30 }, // blockKeywords 被关闭过滤域覆盖后删除
		};
		const patch = buildOverridesPatch(draft, base);
		expect(patch.filters).toEqual({ blockKeywords: null, minScPrice: 30 });
	});

	it("嵌套对象内单个字段被删(templates.guardBuy 与 templates.liveStart 共享 templates)", () => {
		const guard = { imageUrl: "", template: "" };
		const base: OverridesShape = {
			templates: {
				liveStart: "开播啦",
				guardBuy: { enable: true, captain: guard, commander: guard, governor: guard },
			},
		};
		const draft: OverridesShape = {
			templates: { liveStart: "开播啦" }, // guardBuy 覆盖被关闭
		};
		const patch = buildOverridesPatch(draft, base);
		expect(patch.templates).toEqual({ liveStart: "开播啦", guardBuy: null });
	});
});
