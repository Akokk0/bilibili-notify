/**
 * 画布上拖块的**几何与落位算法**(ADR-0014「仍未决」里主人 2026-09-14 要进账的那条:
 * 拖动改行列、拉边改跨列)。
 *
 * **与 DOM 分开**是硬要求,不是洁癖:jsdom 没有布局引擎,`getBoundingClientRect()` 一律
 * 回 0,这里的算法要是写在组件里就一条也钉不住 —— 而「拖到第几列」恰恰是全部难点所在。
 * 组件那半只负责量出轨道、把指针坐标递进来,薄到一眼能看完。
 *
 * 两条刻意的规矩:
 * - **移动就只是移动**:块顶到边就停住,跨度一个不改。顺手帮人缩一列,他下一次拖回来
 *   会发现块变窄了,而这一下他根本没打算改宽度。
 * - **按抓住的位置平移**,不是把块的左边贴到指针上 —— 抓着块的右半边拖,块会整个往左
 *   跳一截,那是所有人第一次拖就会骂的那种手感。
 */

import { CARD_SKIN_LIMITS } from "@bilibili-notify/internal/constants";

/** 一条网格轨道在屏幕上的范围(px);列用横向、行用纵向,同一套算法。 */
export interface Track {
	readonly start: number;
	readonly end: number;
}

/** 块在网格里的位置 —— 这里只关心这三个数(`rowSpan` 拖不着,留给检查器)。 */
export interface GridPos {
	readonly row: number;
	readonly column: number;
	readonly span: number;
}

/**
 * 指针落在的那条轨道(1 起)。轨道按**半开区间 `[start, end)`** 算 —— 两条轨道贴着时
 * 边界那一像素归后一条,不然它会同时属于两条,而「同时属于两条」在这儿只会表现成
 * 「拖到列边界上时块偶尔往回跳一格」。落在缝里或出界取最近的一条。
 */
export function trackAt(tracks: readonly Track[], pos: number): number {
	if (tracks.length === 0) return 1;
	for (const [i, t] of tracks.entries()) {
		if (pos >= t.start && pos < t.end) return i + 1;
	}
	// 缝里或出界:取边缘离得最近的那条。画布的列之间真有 gap,指针一定会落在缝里。
	let best = 1;
	let bestGap = Number.POSITIVE_INFINITY;
	for (const [i, t] of tracks.entries()) {
		const gap = pos < t.start ? t.start - pos : pos - t.end;
		if (gap < bestGap) {
			bestGap = gap;
			best = i + 1;
		}
	}
	return best;
}

function clamp(v: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, v));
}

/**
 * 拖块身:落到指针那一格,**按抓住的位置平移**(`grabOffset` = 按下时指针在块内的第几格,
 * 0 起)。块顶到第 1 / 第 12 列就停住,跨度不动。
 */
export function movedGrid(
	grid: GridPos,
	at: { column: number; row: number },
	grabOffset: number,
): { row: number; column: number } {
	const cols = CARD_SKIN_LIMITS.columns;
	return {
		row: clamp(at.row, 1, CARD_SKIN_LIMITS.maxRows),
		column: clamp(at.column - grabOffset, 1, cols - grid.span + 1),
	};
}

/**
 * 拉边:右边跟着指针走(`column` 不动),左边跟着指针走而**右边钉住**。两头都至少留 1 列。
 */
export function resizedGrid(
	grid: GridPos,
	edge: "left" | "right",
	column: number,
): { column: number; span: number } {
	const cols = CARD_SKIN_LIMITS.columns;
	if (edge === "right") {
		return {
			column: grid.column,
			span: clamp(column - grid.column + 1, 1, cols - grid.column + 1),
		};
	}
	// 右边界钉住:它是「最后一列的下一列」,所以新跨度 = 右边界 - 新起点。
	const rightEdge = grid.column + grid.span;
	const start = clamp(column, 1, rightEdge - 1);
	return { column: start, span: rightEdge - start };
}
