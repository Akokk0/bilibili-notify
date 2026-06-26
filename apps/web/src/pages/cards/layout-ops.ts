/**
 * 卡片版式编辑器的纯变换助手。全部返回新数组、不改输入(配合 React 不可变状态)。
 * 拖拽 UI / 显隐开关只调这些函数,逻辑可单测、UI 外观靠人眼。
 */

import type { CardBlockFull } from "../../types/domain";

/** 分割线块的 type(与 packages/internal 的 DIVIDER_TYPE 对齐)。 */
export const DIVIDER_TYPE = "divider";

/** 把 `from` 处的块移到 `to` 处(其余顺延)。from===to 时原样返回新数组。 */
export function moveBlock(blocks: CardBlockFull[], from: number, to: number): CardBlockFull[] {
	const next = blocks.slice();
	const [moved] = next.splice(from, 1);
	if (!moved) return next;
	next.splice(to, 0, moved);
	return next;
}

/** 翻转指定 id 块的 visible,其余不动。 */
export function toggleBlockVisible(blocks: CardBlockFull[], id: string): CardBlockFull[] {
	return blocks.map((b) => (b.id === id ? { ...b, visible: !b.visible } : b));
}

/** 末尾追加一条可见分割线,id 取现有分割线最大序号 + 1(`divider-N`)。 */
export function addDivider(blocks: CardBlockFull[]): CardBlockFull[] {
	const nums = blocks
		.filter((b) => b.type === DIVIDER_TYPE)
		.map((b) => Number.parseInt(b.id.replace("divider-", ""), 10))
		.filter((n) => Number.isFinite(n));
	const next = (nums.length ? Math.max(...nums) : 0) + 1;
	return [...blocks, { id: `divider-${next}`, type: DIVIDER_TYPE, visible: true }];
}

/** 移除指定 id 的块(用于删分割线)。 */
export function removeBlock(blocks: CardBlockFull[], id: string): CardBlockFull[] {
	return blocks.filter((b) => b.id !== id);
}

/** 设置指定 id 块的上方间距(px);value=undefined 清除(回退框架内置间距)。 */
export function setBlockMargin(
	blocks: CardBlockFull[],
	id: string,
	value: number | undefined,
): CardBlockFull[] {
	return blocks.map((b) => (b.id === id ? { ...b, marginTop: value } : b));
}
