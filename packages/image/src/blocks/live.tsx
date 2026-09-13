/** @jsxImportSource vue */

/**
 * 直播卡的块库。
 *
 * 复合块(cover / header / title / data / desc / divider)是从 `templates/live-card.tsx`
 * **原样搬**进来的那几段 JSX —— class、inline style、文案一个字都没动;原子块
 * (avatar / name / time)是**新抠**的:从 header 里取出头像 img / 名字 span / 时间 span,
 * 保持它们在复合块里的 class 与 style,让皮肤能把三件分开摆。
 *
 * 键名对齐 `CARD_SKIN_BUILTIN_BLOCKS.live`,一个不多一个不少(`__tests__/card-blocks.test.ts`
 * 对表钉着)。
 */

import { DIVIDER_TYPE } from "@bilibili-notify/internal";
import { htmlToPlain } from "../html-to-plain";
import type { LiveCardProps } from "../templates/live-card";
import type { BlockRenderer } from "./types";

function statusLabel(p: LiveCardProps): { text: string; bg: string } {
	if (p.liveStatus === 1) return { text: "直播中", bg: "#FF6699" };
	if (p.liveStatus === 2) return { text: "已下播", bg: "#aaa" };
	return { text: "未开播", bg: "#aaa" };
}

function statsLeft(p: LiveCardProps): string {
	if (p.liveStatus === 3) return `点赞：${p.likedNum}`;
	return `人气：${p.onlineNum}`;
}

function followerText(p: LiveCardProps): string {
	if (p.liveStatus === 1) return p.fansNum ? `当前粉丝数：${p.fansNum}` : "";
	if (p.liveStatus === 2) return p.watchedNum !== "API" ? `累计观看人数：${p.watchedNum}` : "";
	if (p.liveStatus === 3) return p.fansChanged ? `粉丝数变化：${p.fansChanged}` : "";
	return "";
}

/** 头像(原子块):header 复合块里的那个 img。 */
const avatar: BlockRenderer<LiveCardProps> = (p) => (
	<img class="w-11 h-11 rounded-full object-cover shrink-0" src={p.userface} alt="主播头像" />
);

/** 主播名(原子块):header 复合块里的那个 span。 */
const name: BlockRenderer<LiveCardProps> = (p) => (
	<span class="text-[16px] font-bold leading-none" style="color: #18191C;">
		{p.username}
	</span>
);

/** 开播时间(原子块):header 复合块里的那个 span。 */
const time: BlockRenderer<LiveCardProps> = (p) => (
	<span class="text-[12px]" style="color: #999;">
		{p.liveTime}
	</span>
);

/**
 * live 卡的块表。每块返回内层 VNode(无 `data-block` —— 由 `renderBlocks` 的 wrapper
 * 统一加),无数据时返回 null 自动收起。divider 是可重复的分割线块。
 */
export const LIVE_BLOCKS: Record<string, BlockRenderer<LiveCardProps>> = {
	[DIVIDER_TYPE]: () => <div style="height: 1px; background: rgba(0,0,0,0.06); margin: 0 16px;" />,

	cover: (p) => {
		const status = statusLabel(p);
		return (
			<div class="px-4">
				<div class="relative w-full">
					<img
						class="block w-full rounded-lg"
						src={p.coverOverride || (p.cover ? p.data.user_cover : p.data.keyframe)}
						alt="封面"
					/>
					{/* 直播状态角标，叠在封面右上角 */}
					<div
						class="absolute top-3 right-3 inline-flex items-center px-2.5 rounded-xl text-white text-[12px] font-bold"
						style={{
							backgroundColor: status.bg,
							height: "24px",
							lineHeight: "1",
							paddingTop: "1px",
						}}
					>
						{status.text}
					</div>
				</div>
			</div>
		);
	},

	header: (p) => (
		<div class="flex items-center gap-2.5 px-4">
			<img class="w-11 h-11 rounded-full object-cover shrink-0" src={p.userface} alt="主播头像" />
			<div class="flex flex-col gap-0.5 min-w-0">
				<span class="text-[16px] font-bold leading-none" style="color: #18191C;">
					{p.username}
				</span>
				<span class="text-[12px]" style="color: #999;">
					{p.liveTime}
				</span>
			</div>
		</div>
	),

	title: (p) => (
		<div class="px-4 text-[17px] font-bold leading-snug" style="color: #18191C;">
			{p.data.title}
		</div>
	),

	// 数据区(原 stats + follower 合并):人气·点赞 / 分区 / 粉丝数据,各由 show* 开关控制。
	// 三项全关或全无数据 → 返回 null,块自动收起。
	data: (p) => {
		const fans = p.showFans ? followerText(p) : "";
		const hasTopRow = p.showPopularity || p.showArea;
		if (!hasTopRow && !fans) return null;
		return (
			<div class="px-4 flex flex-col gap-1 text-[13px]" style="color: #666;">
				{hasTopRow ? (
					<div class="flex justify-between">
						<span>{p.showPopularity ? statsLeft(p) : ""}</span>
						<span>{p.showArea ? `分区：${p.data.area_name}` : ""}</span>
					</div>
				) : null}
				{fans ? <div>{fans}</div> : null}
			</div>
		);
	},

	// 简介:显隐由版式 desc 块的 visible 控制(renderBlocks 跳过不可见块),此处只管渲染。
	// B 站 `room_info.description` 是富文本(可能含 <p>/<br> 等标签,或 entity-encoded
	// 形式);简介区域只展示纯文本,这里统一剥成 plain text。
	desc: (p) => (
		<div class="px-4 text-[13px] leading-normal" style="color: #999;">
			{htmlToPlain(p.data.description) || "这个主播很懒，什么简介都没写"}
		</div>
	),

	avatar,
	name,
	time,
};
