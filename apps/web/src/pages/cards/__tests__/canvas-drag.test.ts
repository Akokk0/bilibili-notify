/**
 * 画布上拖块的**几何与落位算法**(ADR-0014「仍未决」里主人要进账的那条:拖动改行列 /
 * 拉边改跨列)。
 *
 * 单独抽成纯函数不是为了好看:jsdom 没有布局引擎,`getBoundingClientRect()` 一律回 0,
 * 所以「指针落在第几列」这件事在组件测试里根本算不出来。把它和 DOM 分开之后,算法这半
 * 能逐条钉死,组件那半只剩一条细线(指针事件 → 调用这些函数 → 交回 patch),另有守卫。
 */

import { CARD_SKIN_LIMITS, rowMapOf } from "@bilibili-notify/internal/constants";
import { describe, expect, it } from "vite-plus/test";
import {
	createVelocityTracker,
	MAX_SOLID_STACK,
	movedGrid,
	project,
	realGridPatch,
	realRowOf,
	resizedGrid,
	resizedRows,
	rowAt,
	solidStackDepth,
	trackAt,
} from "../canvas-drag";

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

/**
 * **动量投射** —— 一甩手,块该停在哪儿。
 *
 * 这是 Apple 在 *Designing Fluid Interfaces* 里给的那条公式(指数衰减),**不是**教科书的
 * `v²/(2a)`。两条曲线都"物理正确",但只有前者是 iOS 那个手感,而手感正是这件事的全部。
 *
 * 用途:落点不按**松手的位置**算,按**甩出去会停到的位置**算 —— 轻轻放下就落在原地,
 * 用力一甩就多走几格。「拿一个小输入,换一个大输出」。
 */
describe("动量投射", () => {
	it("不动就是不动", () => {
		expect(project(0)).toBe(0);
	});

	it("越快投得越远", () => {
		expect(project(2000)).toBeGreaterThan(project(500));
	});

	it("方向跟着速度走", () => {
		expect(project(-1000)).toBe(-project(1000));
	});

	it("1000px/s 大致投出半个屏 —— 这是那条曲线的定标点", () => {
		// (1000/1000) * 0.998 / (1 - 0.998) = 499
		expect(Math.round(project(1000))).toBe(499);
	});

	it("减速率越大滑得越远(0.99 比 0.998 收得快)", () => {
		expect(project(1000, 0.99)).toBeLessThan(project(1000, 0.998));
	});
});

/**
 * **松手速度**。
 *
 * 只看最后两个点是不行的:手指停在终点上那一小会儿,最后两帧的位移是 0,算出来的速度也是
 * 0 —— 明明是甩出去的,却一点惯性都没有。所以取**最近一小段时间窗**里的位移 / 时间。
 */
describe("松手速度", () => {
	it("匀速拖 → 速度就是那个速度", () => {
		const t = createVelocityTracker();
		t.add(0, 0, 0);
		t.add(50, 0, 50);
		t.add(100, 0, 100);
		expect(Math.round(t.velocity(100).x)).toBe(1000);
	});

	it("**停在终点上不算停** —— 窗口外的老点不参与,窗口内的位移说了算", () => {
		const t = createVelocityTracker(100);
		t.add(0, 0, 0);
		t.add(300, 0, 60); // 甩过来
		t.add(300, 0, 100); // 手指停住 40ms
		// 最后两点位移为 0,但窗口里确实走了 300px/100ms = 3000px/s 的量级
		expect(t.velocity(100).x).toBeGreaterThan(1000);
	});

	it("停够久 → 真的归零(窗口里只剩不动的点)", () => {
		const t = createVelocityTracker(100);
		t.add(0, 0, 0);
		t.add(300, 0, 60);
		t.add(300, 0, 300);
		expect(t.velocity(300).x).toBe(0);
	});

	it("**速度封顶** —— 两帧相隔一毫秒挪两百像素不该算成二十万 px/s,那会把块投射出网格", () => {
		const t = createVelocityTracker();
		t.add(0, 0, 0);
		t.add(200, -200, 1);
		const v = t.velocity(1);
		expect(v.x).toBe(3000);
		expect(v.y).toBe(-3000);
	});

	it("x 与 y 各算各的 —— 合成一个 2D 速度会在两轴快慢不同时失真", () => {
		const t = createVelocityTracker();
		t.add(0, 0, 0);
		t.add(100, 20, 100);
		const v = t.velocity(100);
		expect(Math.round(v.x)).toBe(1000);
		expect(Math.round(v.y)).toBe(200);
	});

	it("一个点都没有 / 只有一个点 → 零速度,别吐 NaN", () => {
		const t = createVelocityTracker();
		expect(t.velocity(0)).toEqual({ x: 0, y: 0 });
		t.add(5, 5, 0);
		expect(t.velocity(0)).toEqual({ x: 0, y: 0 });
	});
});

/**
 * **叠放层数的闸**(2026-09-18 主人:「三重及以上也删了,场景太少,表达很难」,推翻 09-16
 * 那次的「三重都还好」)。
 *
 * 只拦画布拖拽这一口 —— 检查器的数字框是精确编辑、皮肤包 schema 照旧放行,都由主人拍板。
 * 数的是「**一定同时出现**的块」:写了 `showIf` 的不算,它们出图时可能互斥地占同一格,
 * 而那是 ADR 明写的正当用法(有视频画视频卡、有图廊画图廊)。
 */
describe("拖拽的叠放层数闸", () => {
	const solid = (row: number, column: number, span: number) => ({
		grid: { row, column, span },
		solid: true,
	});
	const at = { row: 1, column: 1, span: 12 };

	it("上限就是二 —— 别在两处各写一个数", () => {
		expect(MAX_SOLID_STACK).toBe(2);
	});

	it("数的是同一片格子上一定出现的块,含自己", () => {
		expect(solidStackDepth(at, true, [])).toBe(1);
		expect(solidStackDepth(at, true, [solid(1, 1, 12)])).toBe(2);
		expect(solidStackDepth(at, true, [solid(1, 1, 12), solid(1, 1, 12)])).toBe(3);
		expect(solidStackDepth(at, true, [solid(1, 1, 12), solid(1, 1, 12), solid(1, 1, 12)])).toBe(4);
	});

	it("同行不同列不算叠 —— 那是分栏,与 overlappingBlocks 同一条判据", () => {
		expect(solidStackDepth({ row: 1, column: 1, span: 4 }, true, [solid(1, 5, 8)])).toBe(1);
	});

	it("跨行块占到的每一行都算 —— 只看起点会漏掉被它盖住的那几行", () => {
		const cover = { grid: { row: 1, column: 1, span: 12, rowSpan: 3 }, solid: true };
		expect(solidStackDepth({ row: 2, column: 1, span: 12 }, true, [cover])).toBe(2);
	});

	it("写了 showIf 的一个都不数 —— 四种形态各摆一个块照旧摆得下", () => {
		const cond = (row: number) => ({ grid: { row, column: 1, span: 12 }, solid: false });
		expect(solidStackDepth(at, false, [cond(1), cond(1), cond(1)])).toBe(0);
		// 自己是实心的,底下三个都带 showIf —— 只数自己这一个
		expect(solidStackDepth(at, true, [cond(1), cond(1), cond(1)])).toBe(1);
	});
});

/**
 * **拉高**(主人 2026-09-18:「每个块只能调节宽度无法直接拖动调节高度」)。与拉宽同一条
 * 形状,换成行:下边跟着指针走、上边跟着指针走而下边钉住。
 */
describe("resizedRows —— 拉高", () => {
	const at = { row: 2, column: 1, span: 12, rowSpan: 3 };

	it("拉下边:起点不动,跨度跟着走", () => {
		expect(resizedRows(at, "bottom", 6)).toEqual({ row: 2, rowSpan: 5 });
	});

	it("拉下边收到起点以上也至少留一行", () => {
		expect(resizedRows(at, "bottom", 1)).toEqual({ row: 2, rowSpan: 1 });
	});

	it("拉上边:下边界钉住(第 5 行的下沿),起点跟着走", () => {
		expect(resizedRows(at, "top", 3)).toEqual({ row: 3, rowSpan: 2 });
		expect(resizedRows(at, "top", 1)).toEqual({ row: 1, rowSpan: 4 });
	});

	it("拉上边越过下边界也至少留一行", () => {
		expect(resizedRows(at, "top", 99)).toEqual({ row: 4, rowSpan: 1 });
	});

	it("跨度不越过总行数", () => {
		expect(resizedRows(at, "bottom", 9999).rowSpan).toBe(CARD_SKIN_LIMITS.maxRows - 1);
	});
});

/**
 * **越过最后一条轨道之后接着往下数。** 不推的话拉高一次只能加一行 —— 画布只在最后多画
 * 一条备用行,`trackAt` 越界后只会一直回那条最后的(把外推删掉,下面那两条当场红)。
 */
describe("rowAt —— 出了画布底下还认得出第几行", () => {
	// 三行,每行 56 高、行距 8 → 节距 64。
	const rows = [
		{ start: 0, end: 56 },
		{ start: 64, end: 120 },
		{ start: 128, end: 184 },
	];

	it("在轨道里就是 trackAt 那一套", () => {
		for (const y of [10, 70, 150]) expect(rowAt(rows, y)).toBe(trackAt(rows, y));
	});

	it("越过最后一条:按节距从最后一行的中线往下数", () => {
		expect(rowAt(rows, 184)).toBe(3); // 刚出下沿,还算第 3 行
		expect(rowAt(rows, 220)).toBe(4); // 第 4 行的中段
		expect(rowAt(rows, 284)).toBe(5);
	});

	it("一条都没有 / 只有一条也不炸", () => {
		expect(rowAt([], 500)).toBe(1);
		expect(rowAt([{ start: 0, end: 56 }], 500)).toBeGreaterThan(1);
	});
});

/**
 * **画布压掉了整行为空的行,拖出来的行号是压后的**(ADR-0014 决策 10 的 2026-09-19 🔗)。
 * 存之前不换回真行号的话,「把互动数从真第 7 行往下挪一格」会被存成第 5 行 —— 界面上
 * 看着落对了,再切一场回来它跑到了别的块身上。
 */
describe("压行换算 —— 画布行号 ↔ 真行号", () => {
	// 真行 1、2–3(跨两行)、7 有块;4–6 整行空着,画布压掉 → 画布上是 1、2–3、4。
	const map = () => rowMapOf([{ row: 1 }, { row: 2, rowSpan: 2 }, { row: 7 }]);

	it("表里有的照查:画布第 4 行就是真第 7 行", () => {
		expect(realRowOf(map(), 1)).toBe(1);
		expect(realRowOf(map(), 3)).toBe(3);
		expect(realRowOf(map(), 4)).toBe(7);
	});

	it("表外的按节距接着数:最后一块底下那条备用行是真第 8 行", () => {
		expect(realRowOf(map(), 5)).toBe(8);
		expect(realRowOf(map(), 7)).toBe(10);
	});

	it("这一场一块都没有 → 两套行号是一回事", () => {
		expect(realRowOf(new Map(), 3)).toBe(3);
	});

	it("只挪位置:只换 row,跨行数原样 —— 块占的真行恒是连着的一段", () => {
		expect(realGridPatch(map(), { row: 4, column: 2 })).toEqual({ row: 7, column: 2 });
		expect(realGridPatch(map(), { column: 2, span: 3 })).toEqual({ column: 2, span: 3 });
	});

	it("拉上下两条边:顶与底各换各的,中间被压掉的空行归它", () => {
		// 画布上从第 2 行拉到第 4 行(跨 3),真的是 2 到 7:跨 6。
		expect(realGridPatch(map(), { row: 2, rowSpan: 3 })).toEqual({ row: 2, rowSpan: 6 });
		// 没跨过压掉的行时数不变。
		expect(realGridPatch(map(), { row: 2, rowSpan: 2 })).toEqual({ row: 2, rowSpan: 2 });
	});
});
