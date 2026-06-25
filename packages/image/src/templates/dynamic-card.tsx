/** @jsxImportSource vue */
import { type CardBlock, DEFAULT_CARD_LAYOUT, DIVIDER_TYPE } from "@bilibili-notify/internal";
import type { VNode } from "vue";
import { SVG_COMMENT, SVG_FORWARD, SVG_LIKE, SVG_TOPIC } from "../icons";
import { renderBlocks } from "./block-layout";

export type DynamicCardProps = {
	cardColorStart: string;
	cardColorEnd: string;
	decorateColor: string;
	avatarUrl: string;
	upName: string;
	upIsVip: boolean;
	pubTime: string;
	decorateCardUrl?: string;
	decorateCardId?: string;
	topic?: string;
	mainContent: VNode;
	forwardCount: string;
	commentCount: string;
	likeCount: string;
	/**
	 * dynamic 版式描述符(块的顺序 + 显隐 + 边距 + 分割线)。缺省 = `DEFAULT_CARD_LAYOUT.dynamic`,
	 * 复刻现状。块按 type 渲染、`visible=false` 跳过;无话题数据时 topic 块自动收起。
	 */
	layout?: CardBlock[];
};

export function DynamicCard(p: DynamicCardProps) {
	// 各块构建器(按 type):返回内层 VNode(无 data-block —— renderBlocks wrapper 统一加),
	// 无数据时返回 null。divider 是可重复分割线块(原 header 下 / stats 上的 hairline 迁出来)。
	const builders: Record<string, () => VNode | null> = {
		[DIVIDER_TYPE]: () => (
			<div style="height: 1px; background: rgba(0,0,0,0.06); margin: 0 16px;" />
		),
		header: () => (
			<div class="flex items-center gap-[12px] px-[16px]">
				<img
					class="w-[52px] h-[52px] shrink-0 rounded-full object-cover"
					src={p.avatarUrl}
					alt="头像"
				/>
				<div class="flex flex-col gap-[3px]">
					<span
						class="text-[17px] font-bold leading-none"
						style={{ color: p.upIsVip ? "#FB7299" : "#18191C" }}
					>
						{p.upName}
					</span>
					<span class="text-[12px]" style="color: #999;">
						{p.pubTime}
					</span>
				</div>
			</div>
		),

		topic: () =>
			p.topic ? (
				<div
					class="flex items-center gap-[5px] px-[16px] text-[13px] font-bold"
					style="color: #00AEEC;"
				>
					{SVG_TOPIC}
					{p.topic}
				</div>
			) : null,

		content: () => <div class="px-[16px]">{p.mainContent}</div>,

		stats: () => (
			<div class="flex justify-around px-[16px]" style="color: #999;">
				<div class="flex items-center gap-[6px] text-[13px]">
					{SVG_FORWARD}
					<span>{p.forwardCount}</span>
				</div>
				<div class="flex items-center gap-[6px] text-[13px]">
					{SVG_COMMENT}
					<span>{p.commentCount}</span>
				</div>
				<div class="flex items-center gap-[6px] text-[13px]">
					{SVG_LIKE}
					<span>{p.likeCount}</span>
				</div>
			</div>
		),
	};

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
				style="background: rgba(255,255,255,0.82); backdrop-filter: blur(10px); box-shadow: 0 4px 16px rgba(0,0,0,0.12);"
			>
				{renderBlocks(p.layout ?? DEFAULT_CARD_LAYOUT.dynamic, builders)}
			</div>
		</div>
	);
}
