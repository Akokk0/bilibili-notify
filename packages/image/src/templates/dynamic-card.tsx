/** @jsxImportSource vue */
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
};

// ── 组件 ──────────────────────────────────────────────────────────────────────

export function DynamicCard(p: DynamicCardProps) {
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
				{/* ── 头部区域 ── */}
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

				{/* 头部 / 内容分隔线 */}
				<div style="height: 1px; background: rgba(0,0,0,0.06); margin: 0 16px;" />

				{/* ── 内容区域 ── */}
				<div class="px-[16px] py-[12px] flex flex-col gap-[10px]">
					{/* 话题标签 */}
					{p.topic && (
						<div class="flex items-center gap-[5px] text-[13px] font-bold" style="color: #00AEEC;">
							{SVG_TOPIC}
							{p.topic}
						</div>
					)}

					{/* 动态正文 */}
					<div>{p.mainContent}</div>
				</div>

				{/* ── 统计数据 ── */}
				<div style="height: 1px; background: rgba(0,0,0,0.06); margin: 0 16px;" />
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
		</div>
	);
}
