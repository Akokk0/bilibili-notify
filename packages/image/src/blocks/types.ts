/**
 * 块库的公共类型与小工具。
 *
 * 「块」是 ADR-0014 卡片皮肤的装配单位:一个块 = 一段可独立摆放的 JSX。块库(`blocks/`)
 * 里每种卡一张表,键名对齐 `CARD_SKIN_BUILTIN_BLOCKS` 的内置块目录 —— 复合块是从
 * `templates/` 原样搬进来的那几段,原子块是从复合块里新抠出来的单件。
 */

import type { VNode } from "vue";

/** 一个块的渲染器:吃该卡种的 props,画出块的**内层** VNode;没数据时回 `null`(块自动收起)。 */
export type BlockRenderer<P> = (props: P) => VNode | null;

/**
 * 把一张块表绑到一份 props 上,得到 `renderBlocks` 要的 `builders`(按块名取的无参函数)。
 * 表里的原子块也一并绑上 —— 默认版式不引用它们,但皮肤可以。
 */
export function bindBlocks<P>(
	blocks: Record<string, BlockRenderer<P>>,
	props: P,
): Record<string, () => VNode | null> {
	const builders: Record<string, () => VNode | null> = {};
	for (const [name, render] of Object.entries(blocks)) {
		builders[name] = () => render(props);
	}
	return builders;
}
