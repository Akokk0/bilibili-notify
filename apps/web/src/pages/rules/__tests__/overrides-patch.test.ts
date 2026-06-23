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
});
