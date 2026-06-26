/** @jsxImportSource vue */
import { type CardBlock, DEFAULT_CARD_LAYOUT, DIVIDER_TYPE } from "@bilibili-notify/internal";
import type { VNode } from "vue";
import { SVG_COMMENT, SVG_FORWARD, SVG_LIKE, SVG_TOPIC } from "../icons";
import { renderBlocks } from "./block-layout";
import type { DynamicNode } from "./dynamic-content";

export type { DynamicNode };

export type DynamicCardProps = {
	cardColorStart: string;
	cardColorEnd: string;
	/** 动态内容结构树(含可选的内部转发原动态)。 */
	node: DynamicNode;
	/**
	 * dynamic 版式描述符(块的顺序 + 显隐 + 边距 + 分割线)。缺省 = `DEFAULT_CARD_LAYOUT.dynamic`,
	 * 复刻现状。块按 type 渲染、`visible=false` 跳过;无附加内容时 additional 块自动收起。
	 * 话题标签内联在正文块顶部(无独立块);内部转发的原动态用**同一套版式**递归渲染。
	 */
	layout?: CardBlock[];
};

/**
 * 由一个 DynamicNode + 版式生成各块构建器(按 type)。content 块内嵌转发原动态时,用
 * 同一份 layout 递归调用 renderBlocks —— 内部动态因此完全跟随用户的块顺序 / 显隐 / 边距。
 */
function nodeBuilders(node: DynamicNode, layout: CardBlock[]): Record<string, () => VNode | null> {
	return {
		[DIVIDER_TYPE]: () => (
			<div style="height: 1px; background: rgba(0,0,0,0.06); margin: 0 16px;" />
		),

		header: () => (
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

		content: () => (
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
					<div
						class="rounded-[8px] mt-2 py-[2px]"
						style="background: rgba(0,0,0,0.04); border-left: 3px solid #00AEEC;"
					>
						{renderBlocks(layout, nodeBuilders(node.forward, layout))}
					</div>
				) : null}
			</div>
		),

		additional: () => (node.additional ? <div class="px-[16px]">{node.additional}</div> : null),

		stats: () =>
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
	};
}

export function DynamicCard(p: DynamicCardProps) {
	const layout = p.layout ?? DEFAULT_CARD_LAYOUT.dynamic;
	return (
		<div
			class="h-auto p-[15px]"
			style={{
				background: `linear-gradient(to right bottom, ${p.cardColorStart}, ${p.cardColorEnd})`,
				minWidth: "380px",
			}}
		>
			<div
				class="w-full overflow-hidden rounded-[12px]"
				style="background: rgba(255,255,255,0.82); backdrop-filter: blur(10px); box-shadow: 0 4px 16px rgba(0,0,0,0.12); padding-top: 14px; padding-bottom: 12px;"
			>
				{renderBlocks(layout, nodeBuilders(p.node, layout))}
			</div>
		</div>
	);
}
