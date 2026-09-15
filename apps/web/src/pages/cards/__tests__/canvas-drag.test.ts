/**
 * 画布上拖块的**几何与落位算法**(ADR-0014「仍未决」里主人要进账的那条:拖动改行列 /
 * 拉边改跨列)。
 *
 * 单独抽成纯函数不是为了好看:jsdom 没有布局引擎,`getBoundingClientRect()` 一律回 0,
 * 所以「指针落在第几列」这件事在组件测试里根本算不出来。把它和 DOM 分开之后,算法这半
 * 能逐条钉死,组件那半只剩一条细线(指针事件 → 调用这些函数 → 交回 patch),另有守卫。
 */

import { describe, expect, it } from "vite-plus/test";
import { movedGrid, resizedGrid, trackAt } from "../canvas-drag";

/** 12 条等宽轨道,每条 40px,从 x=100 起;中间不留缝(画布真有 gap,但算法不该依赖它)。 */
const TRACKS = Array.from({ length: 12 }, (_, i) => ({
	start: 100 + i * 40,
	end: 100 + i * 40 + 40,
}));

describe("指针落在第几条轨道上", () => {
	it("轨道里 → 那一条(1 起)", () => {
		expect(trackAt(TRACKS, 100)).toBe(1);
		expect(trackAt(TRACKS, 139)).toBe(1);
		expect(trackAt(TRACKS, 140)).toBe(2);
		expect(trackAt(TRACKS, 579)).toBe(12);
	});

	it("出界 → 最近的一条,不是报错也不是 0", () => {
		expect(trackAt(TRACKS, -9999)).toBe(1);
		expect(trackAt(TRACKS, 9999)).toBe(12);
	});

	it("缝里 → 靠得近的那条(画布列之间真有 gap,指针会落在缝里)", () => {
		const gapped = [
			{ start: 0, end: 40 },
			{ start: 48, end: 88 },
		];
		expect(trackAt(gapped, 42)).toBe(1);
		expect(trackAt(gapped, 46)).toBe(2);
	});

	it("一条轨道都没有 → 回 1(画布还没量到,别把 NaN 传下去)", () => {
		expect(trackAt([], 123)).toBe(1);
	});
});

describe("拖块身 —— 改行与列", () => {
	const grid = { row: 2, column: 3, span: 4 };

	it("按抓住的位置平移,不是把块的左边贴到指针上", () => {
		// 从块的第 2 格抓起(offset 1),拖到第 8 列 → 左边落在 7。
		expect(movedGrid(grid, { column: 8, row: 5 }, 1)).toEqual({ row: 5, column: 7 });
	});

	it("跨度不变 —— 移动就只是移动", () => {
		const out = movedGrid(grid, { column: 1, row: 1 }, 0);
		expect(out).toEqual({ row: 1, column: 1 });
	});

	it("右边顶到第 12 列就停住,**不缩跨度**", () => {
		// 跨 4 列的块最多起在第 9 列。
		expect(movedGrid(grid, { column: 12, row: 2 }, 0).column).toBe(9);
	});

	it("左边顶到第 1 列也停住", () => {
		expect(movedGrid(grid, { column: 1, row: 2 }, 2).column).toBe(1);
	});

	it("行不小于 1", () => {
		expect(movedGrid(grid, { column: 3, row: -3 }, 0).row).toBe(1);
	});
});

describe("拉边 —— 改跨列", () => {
	const grid = { row: 1, column: 3, span: 4 }; // 占 3–6

	it("拉右边:跨到指针那一列为止", () => {
		expect(resizedGrid(grid, "right", 9)).toEqual({ column: 3, span: 7 });
	});

	it("拉右边最少留 1 列 —— 拖过了头不会翻成负数", () => {
		expect(resizedGrid(grid, "right", 1)).toEqual({ column: 3, span: 1 });
	});

	it("拉左边:起点跟着走,**右边不动**", () => {
		// 原来占 3–6;左边拉到 1 → 占 1–6。
		expect(resizedGrid(grid, "left", 1)).toEqual({ column: 1, span: 6 });
	});

	it("拉左边越过右边时停在最后一列", () => {
		expect(resizedGrid(grid, "left", 11)).toEqual({ column: 6, span: 1 });
	});

	it("拉右边越过第 12 列就停住", () => {
		expect(resizedGrid(grid, "right", 99)).toEqual({ column: 3, span: 10 });
	});
});
