/** @jsxImportSource vue */

import { type CardBlock, DIVIDER_TYPE } from "@bilibili-notify/internal";
import type { VNode } from "vue";

/**
 * 把块的**上方**间距折成 wrapper 的 `paddingTop`(undefined 不写)。块间间距 = 下方块的
 * marginTop;用 padding 而非 margin 以免相邻 margin 塌缩。首个产出块的上边距由卡片框架
 * (容器固定内边距)统一提供,这里跳过 —— 即「第一个模块固定上边距」;末块下边距同理走容器。
 */
function spacingStyle(b: CardBlock, isFirst: boolean): Record<string, string> {
	if (isFirst || b.marginTop === undefined) return {};
	return { paddingTop: `${b.marginTop}px` };
}

/**
 * 按 layout 渲染块序列:`visible=false` 跳过;按 `type` 找 builder(divider 也是
 * 一个 builder,可重复;内容块返回 null 时自动收起)。每块套一层带 `data-block`
 * (= type,供版式契约测试与识别)+ 可选上方间距(首块除外)的 wrapper。
 *
 * `wrapperClass` 给居中栈(sc)传 "w-full",保证 wrapper 撑满、内层 text-center /
 * items-center 仍居中;垂直栈(live/dynamic)与 guard 内容列留空即可。
 */
export function renderBlocks(
	layout: CardBlock[],
	builders: Record<string, () => VNode | null>,
	wrapperClass?: string,
): VNode[] {
	const out: VNode[] = [];
	// 分割线抑制:只在「前一个产出块是内容块」时才保留 divider —— 自动收起开头的
	// divider、内容块隐藏/无数据造成的悬空 divider、以及相邻重叠的 divider;末尾的
	// divider 在循环后弹出。避免「关掉某块后两条分割线贴在一起」的脏边。
	let lastWasContent = false;
	let lastWasDivider = false;
	for (const b of layout) {
		if (!b.visible) continue;
		const inner = builders[b.type]?.();
		if (inner == null) continue;
		if (b.type === DIVIDER_TYPE) {
			if (!lastWasContent) continue;
			lastWasContent = false;
			lastWasDivider = true;
		} else {
			lastWasContent = true;
			lastWasDivider = false;
		}
		out.push(
			<div data-block={b.type} class={wrapperClass} style={spacingStyle(b, out.length === 0)}>
				{inner}
			</div>,
		);
	}
	if (lastWasDivider) out.pop();
	return out;
}
