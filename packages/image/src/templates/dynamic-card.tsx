/** @jsxImportSource vue */
import { type CardBlock, DEFAULT_CARD_LAYOUT } from "@bilibili-notify/internal";
import type { VNode } from "vue";
import { SVG_COMMENT, SVG_FORWARD, SVG_LIKE, SVG_TOPIC } from "../icons";

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
	 * dynamic 版式描述符(块的顺序 + 显隐)。缺省 = `DEFAULT_CARD_LAYOUT.dynamic`,复刻现状。
	 * 块按数组顺序渲染、`visible=false` 的跳过;无话题数据时 topic 块自动收起。
	 */
	layout?: CardBlock[];
};

const HAIRLINE = "height: 1px; background: rgba(0,0,0,0.06); margin: 0 16px;";

// ── 组件 ──────────────────────────────────────────────────────────────────────

export function DynamicCard(p: DynamicCardProps) {
	// 各块构建器:返回带 `data-block` 标记的 VNode,无数据时返回 null 自动收起。
	// header 自带下分隔线、stats 自带上分隔线 —— 默认顺序下视觉与原版一致。
	const blocks: Record<string, () => VNode | null> = {
		header: () => (
			<div data-block="header">
				<div class="flex items-center gap-[12px] px-[16px] pt-[14px] pb-[12px]">
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
				<div style={HAIRLINE} />
			</div>
		),

		topic: () =>
			p.topic ? (
				<div
					data-block="topic"
					class="flex items-center gap-[5px] px-[16px] pt-[12px] text-[13px] font-bold"
					style="color: #00AEEC;"
				>
					{SVG_TOPIC}
					{p.topic}
				</div>
			) : null,

		content: () => (
			<div data-block="content" class="px-[16px] py-[12px]">
				{p.mainContent}
			</div>
		),

		stats: () => (
			<div data-block="stats">
				<div style={HAIRLINE} />
				<div class="flex justify-around px-[16px] py-[12px]" style="color: #999;">
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
			</div>
		),
	};

	const order = (p.layout ?? DEFAULT_CARD_LAYOUT.dynamic).filter((b) => b.visible).map((b) => b.id);

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
				{order.map((id) => blocks[id]?.())}
			</div>
		</div>
	);
}
