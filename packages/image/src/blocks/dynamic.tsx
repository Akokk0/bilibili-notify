/** @jsxImportSource vue */

/**
 * 动态卡的块库。
 *
 * 复合块(header / content / additional / stats / divider)是从 `templates/dynamic-card.tsx`
 * **原样搬**进来的那几段 JSX —— class、inline style、文案一个字都没动;原子块
 * (avatar / name / time)是**新抠**的:从 header 里取出头像 img / 名字 span / 时间 span,
 * 保持它们在复合块里的 class 与 style,让皮肤能把三件分开摆。
 *
 * 键名对齐 `CARD_SKIN_BUILTIN_BLOCKS.dynamic`,一个不多一个不少(`__tests__/card-blocks.test.ts`
 * 对表钉着)。
 */

import { type CardBlock, DIVIDER_TYPE } from "@bilibili-notify/internal";
import type { VNode } from "vue";
import { SVG_COMMENT, SVG_FORWARD, SVG_LIKE, SVG_TOPIC } from "../icons";
import { renderBlocks } from "../templates/block-layout";
import type { DynamicNode } from "../templates/dynamic-content";
import { type BlockRenderer, bindBlocks } from "./types";

/**
 * 动态块吃的 props:一个 DynamicNode + 整卡版式。版式要跟着进来,是因为 content 块内嵌
 * 转发原动态时用**同一份 layout** 递归装配 —— 内部动态因此完全跟随用户的块顺序 / 显隐 / 边距。
 */
export type DynamicBlockProps = {
	node: DynamicNode;
	layout: CardBlock[];
};

/** 头像(原子块):header 复合块里的那个 img。 */
const avatar: BlockRenderer<DynamicBlockProps> = ({ node }) => (
	<img
		class="w-[52px] h-[52px] shrink-0 rounded-full object-cover"
		src={node.avatarUrl}
		alt="头像"
	/>
);

/** UP 主名(原子块):header 复合块里的那个 span(含类型标签后缀与大会员粉名)。 */
const name: BlockRenderer<DynamicBlockProps> = ({ node }) => (
	<span
		class="text-[17px] font-bold leading-none"
		style={{ color: node.upIsVip ? "#FB7299" : "#18191C" }}
	>
		{node.upName}
		{node.headerLabel ? ` ${node.headerLabel}` : ""}
	</span>
);

/** 发布时间(原子块):header 复合块里的那个 span。 */
const time: BlockRenderer<DynamicBlockProps> = ({ node }) => (
	<span class="text-[12px]" style="color: #999;">
		{node.pubTime}
	</span>
);

/**
 * dynamic 卡的块表。每块返回内层 VNode(无 `data-block` —— 由 `renderBlocks` 的 wrapper
 * 统一加),无数据时返回 null 自动收起。
 */
export const DYNAMIC_BLOCKS: Record<string, BlockRenderer<DynamicBlockProps>> = {
	[DIVIDER_TYPE]: () => <div style="height: 1px; background: rgba(0,0,0,0.06); margin: 0 16px;" />,

	header: ({ node }) => (
		<div class="flex items-center gap-[12px] px-[16px]">
			<img
				class="w-[52px] h-[52px] shrink-0 rounded-full object-cover"
				src={node.avatarUrl}
				alt="头像"
			/>
			<div class="flex flex-col gap-[3px]">
				<span
					class="text-[17px] font-bold leading-none"
					style={{ color: node.upIsVip ? "#FB7299" : "#18191C" }}
				>
					{node.upName}
					{node.headerLabel ? ` ${node.headerLabel}` : ""}
				</span>
				<span class="text-[12px]" style="color: #999;">
					{node.pubTime}
				</span>
			</div>
		</div>
	),

	content: ({ node, layout }) => (
		<div class="px-[16px]">
			{node.topic ? (
				<div
					class="flex items-center gap-[5px] mb-[8px] text-[13px] font-bold"
					style="color: #00AEEC;"
				>
					{SVG_TOPIC}
					{node.topic}
				</div>
			) : null}
			{node.body}
			{node.forward ? (
				// 转发 inset 是内部动态的「框架」:像外层卡片容器一样提供固定的上下内边距,
				// 这样 renderBlocks 跳过内部首块上边距后,内容不会顶着 inset 顶部。
				// zoom 把内部子树整体等比缩小(Chromium 原生支持、会正常重排) —— 内层走同一套
				// 写死 px 的 builder,只有 zoom 能统一缩小头像 / 视频卡 / 文字,一眼认出是转发。
				<div
					class="rounded-[8px] mt-2 pt-[12px] pb-[12px]"
					style="background: rgba(0,0,0,0.04); border-left: 5px solid #00AEEC; zoom: 0.85;"
				>
					{renderBlocks(layout, dynamicNodeBuilders(node.forward, layout))}
				</div>
			) : null}
		</div>
	),

	additional: ({ node }) =>
		node.additional ? <div class="px-[16px]">{node.additional}</div> : null,

	stats: ({ node }) =>
		node.stats ? (
			<div class="flex justify-around px-[16px]" style="color: #999;">
				<div class="flex items-center gap-[6px] text-[13px]">
					{SVG_FORWARD}
					<span>{node.stats.forward}</span>
				</div>
				<div class="flex items-center gap-[6px] text-[13px]">
					{SVG_COMMENT}
					<span>{node.stats.comment}</span>
				</div>
				<div class="flex items-center gap-[6px] text-[13px]">
					{SVG_LIKE}
					<span>{node.stats.like}</span>
				</div>
			</div>
		) : null,

	avatar,
	name,
	time,
};

/**
 * 由一个 DynamicNode + 版式生成各块构建器(按块名)。content 块内嵌转发原动态时回头调它,
 * 就是那条递归 —— 所以它必须在 `DYNAMIC_BLOCKS` 之后用 `function` 声明(提升)。
 */
export function dynamicNodeBuilders(
	node: DynamicNode,
	layout: CardBlock[],
): Record<string, () => VNode | null> {
	return bindBlocks(DYNAMIC_BLOCKS, { node, layout });
}
