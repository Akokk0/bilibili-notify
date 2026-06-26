/** @jsxImportSource vue */

import { type CardBlock, DEFAULT_CARD_LAYOUT, DIVIDER_TYPE } from "@bilibili-notify/internal";
import type { VNode } from "vue";
import { htmlToPlain } from "../html-to-plain";
import { renderBlocks } from "./block-layout";

export type LiveCardProps = {
	hideDesc: boolean;
	/** 隐藏粉丝变化 / 累计观看数(对齐 hideDesc 命名;隐藏=true)。 */
	hideFollower: boolean;
	cardColorStart: string;
	cardColorEnd: string;
	// biome-ignore lint/suspicious/noExplicitAny: Bilibili 直播 API 返回类型
	data: any;
	username: string;
	userface: string;
	titleStatus: string;
	liveTime: string;
	liveStatus: number;
	cover: boolean;
	onlineNum: string;
	likedNum: string;
	watchedNum: string;
	fansNum: string;
	fansChanged: string;
	/**
	 * live 版式描述符(块的顺序 + 显隐 + 边距 + 分割线)。缺省 = `DEFAULT_CARD_LAYOUT.live`,
	 * 复刻现状。块按 type 渲染、`visible=false` 跳过;某态无数据的块自动收起。
	 */
	layout?: CardBlock[];
	/** 玻璃片(内容层)透明度 0..1;缺省走 live 基线 0.82。 */
	glassOpacity?: number;
	/** 自定义背景图(已解析的 data URL / http URL);非空时替换外框渐变。 */
	backgroundImage?: string;
};

export function LiveCard(p: LiveCardProps) {
	const statusLabel = () => {
		if (p.liveStatus === 1) return { text: "直播中", bg: "#FF6699" };
		if (p.liveStatus === 2) return { text: "已下播", bg: "#aaa" };
		return { text: "未开播", bg: "#aaa" };
	};

	const statsLeft = () => {
		if (p.liveStatus === 3) return `点赞：${p.likedNum}`;
		return `人气：${p.onlineNum}`;
	};

	const followerText = () => {
		if (p.liveStatus === 1) return p.fansNum ? `当前粉丝数：${p.fansNum}` : "";
		if (p.liveStatus === 2) return p.watchedNum !== "API" ? `累计观看人数：${p.watchedNum}` : "";
		if (p.liveStatus === 3) return p.fansChanged ? `粉丝数变化：${p.fansChanged}` : "";
		return "";
	};

	const status = statusLabel();
	const follower = p.hideFollower ? "" : followerText();
	// B 站 `room_info.description` 是富文本(可能含 <p>/<br> 等标签,或 entity-encoded
	// 形式);简介区域只展示纯文本,这里统一剥成 plain text。
	const description = htmlToPlain(p.data.description);

	// 各块构建器(按 type):返回内层 VNode(无 data-block —— 由 renderBlocks 的 wrapper
	// 统一加),无数据时返回 null 自动收起。divider 是可重复的分割线块。
	const builders: Record<string, () => VNode | null> = {
		[DIVIDER_TYPE]: () => (
			<div style="height: 1px; background: rgba(0,0,0,0.06); margin: 0 16px;" />
		),
		cover: () => (
			<div class="px-4">
				<div class="relative w-full">
					<img
						class="block w-full rounded-lg"
						src={p.cover ? p.data.user_cover : p.data.keyframe}
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
		),

		header: () => (
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

		title: () => (
			<div class="px-4 text-[17px] font-bold leading-snug" style="color: #18191C;">
				{p.data.title}
			</div>
		),

		stats: () => (
			<div class="px-4 flex justify-between text-[13px]" style="color: #666;">
				<span>{statsLeft()}</span>
				<span>分区：{p.data.area_name}</span>
			</div>
		),

		follower: () =>
			follower ? (
				<div class="px-4 text-[13px]" style="color: #666;">
					{follower}
				</div>
			) : null,

		desc: () =>
			p.hideDesc ? null : (
				<div class="px-4 text-[13px] leading-normal" style="color: #999;">
					{description || "这个主播很懒，什么简介都没写"}
				</div>
			),
	};

	const frameBg = p.backgroundImage
		? `url("${p.backgroundImage}") center / cover`
		: `linear-gradient(to right bottom, ${p.cardColorStart}, ${p.cardColorEnd})`;

	return (
		<div class="h-auto p-3.75" style={{ background: frameBg }}>
			<div
				class="overflow-hidden rounded-xl"
				style={`background: rgba(255,255,255,${p.glassOpacity ?? 0.82}); backdrop-filter: blur(10px); box-shadow: 0 4px 16px rgba(0,0,0,0.12); min-width: 360px; padding-top: 14px; padding-bottom: 10px;`}
			>
				{renderBlocks(p.layout ?? DEFAULT_CARD_LAYOUT.live, builders)}
			</div>
		</div>
	);
}
