/**
 * 卡片版式编辑器的纯变换助手。全部返回新数组、不改输入(配合 React 不可变状态)。
 * 拖拽 UI / 显隐开关只调这些函数,逻辑可单测、UI 外观靠人眼。
 */

import type { CardBlockFull } from "../../types/domain";

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
