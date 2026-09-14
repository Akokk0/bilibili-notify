/**
 * 编辑器改草稿的那几个纯函数 —— **不碰 React**,所以行为能单独钉住。
 *
 * 一律「回一份新的,不动原件」:草稿的脏标与预览的重画都靠**引用变了**触发,就地改的话
 * 两边都察觉不到,界面上看着值变了、预览一动不动(正是「拧了没反应」那一类)。
 */

import type { CardSkinKind, CardSkinManifest } from "@bilibili-notify/contract";
import { CARD_SKIN_LIMITS } from "@bilibili-notify/internal/constants";

type Card = NonNullable<CardSkinManifest["cards"][CardSkinKind]>;
type Block = Card["blocks"][number];
type Grid = Block["grid"];

/** 这张卡的块表。皮肤没定义这种卡时是 `undefined`(出图跟着出厂默认)。 */
export function cardOf(manifest: CardSkinManifest | null, kind: CardSkinKind): Card | undefined {
	return manifest?.cards[kind];
}

export function blockOf(card: Card | undefined, id: string): Block | undefined {
	return card?.blocks.find((b) => b.id === id);
}

/**
 * 把一个数夹进取值域并取整。**夹不是拒**:位置那几个框是数字输入,主人边敲边过 —— 敲到
 * 一半的 `1` 在「0–12」里是合法的,拒了他就永远敲不出 `13` 之外的任何两位数。越界的值
 * 夹回边界,比弹一句错更少打断。
 */
export function clampInt(v: number, min: number, max: number): number {
	if (!Number.isFinite(v)) return min;
	return Math.min(max, Math.max(min, Math.round(v)));
}

/** 位置那四个数各自的取值域。`span` 的上限还要减去起始列 —— 跨出第 12 列没有意义。 */
export function gridLimits(grid: Grid): Record<keyof Grid, { min: number; max: number }> {
	const cols = CARD_SKIN_LIMITS.columns;
	return {
		row: { min: 1, max: CARD_SKIN_LIMITS.maxRows },
		column: { min: 1, max: cols },
		span: { min: 1, max: cols - grid.column + 1 },
		rowSpan: { min: 1, max: CARD_SKIN_LIMITS.maxRows },
	};
}

/**
 * 改一个块的位置。`span` 会跟着起始列收 —— 把块往右拖到第 10 列时,原来跨 12 列的
 * `span` 必须缩到 3,否则清洗器那头直接判它越界,主人看到的是一句「保存失败」而不是
 * 「刚才那一下把它挤出去了」。
 */
export function setBlockGrid(
	manifest: CardSkinManifest,
	kind: CardSkinKind,
	blockId: string,
	patch: Partial<Grid>,
): CardSkinManifest {
	const card = manifest.cards[kind];
	if (!card) return manifest;
	const blocks = card.blocks.map((b) => {
		if (b.id !== blockId) return b;
		const merged = { ...b.grid, ...patch };
		const lim = gridLimits(merged);
		const grid: Grid = {
			row: clampInt(merged.row, lim.row.min, lim.row.max),
			column: clampInt(merged.column, lim.column.min, lim.column.max),
			span: clampInt(merged.span, lim.span.min, lim.span.max),
		};
		// `rowSpan` 缺省是 1,而「写一个 1 进去」与「不写」在出图上一样 —— 不写更干净,
		// 也让 diff 里少一行噪音。
		const rowSpan = clampInt(merged.rowSpan ?? 1, lim.rowSpan.min, lim.rowSpan.max);
		if (rowSpan > 1) grid.rowSpan = rowSpan;
		return { ...b, grid };
	});
	return { ...manifest, cards: { ...manifest.cards, [kind]: { ...card, blocks } } };
}
