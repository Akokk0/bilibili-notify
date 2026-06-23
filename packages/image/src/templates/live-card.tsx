/** @jsxImportSource vue */

import { type CardBlock, DEFAULT_CARD_LAYOUT } from "@bilibili-notify/internal";
import type { VNode } from "vue";
import { htmlToPlain } from "../html-to-plain";

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
	 * live 版式描述符(块的顺序 + 显隐)。缺省 = `DEFAULT_CARD_LAYOUT.live`,复刻现状。
	 * 块按数组顺序渲染、`visible=false` 的跳过;某态无数据的块(如下播无人气)由块
	 * 构建器返回 null 自动收起。
	 */
	layout?: CardBlock[];
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
	// 形式如 `&lt;p&gt;...`);直接交给 JSX 文本插值会被 escape 成字面字符串。
	// 简介区域只展示纯文本,这里统一剥成 plain text。
	const description = htmlToPlain(p.data.description);

	// 各块构建器:返回带 `data-block` 标记的 VNode(供版式契约测试与渲染器识别),
	// 无数据时返回 null 自动收起。块只负责自身内容,容器外壳由下方统一包裹。
	const blocks: Record<string, () => VNode | null> = {
		cover: () => (
			<div data-block="cover" class="px-4 pt-3.5">
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
			<div data-block="header" class="flex items-center gap-2.5 px-4 pt-3.5 pb-2.5">
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
			<div
				data-block="title"
				class="px-4 pb-2.5 text-[17px] font-bold leading-snug"
				style="color: #18191C;"
			>
				{p.data.title}
			</div>
		),

		stats: () => (
			<div data-block="stats">
				{/* 分隔线 */}
				<div style="height: 1px; background: rgba(0,0,0,0.06); margin: 0 16px;" />
				<div class="px-4 pt-2.5 flex justify-between text-[13px]" style="color: #666;">
					<span>{statsLeft()}</span>
					<span>分区：{p.data.area_name}</span>
				</div>
			</div>
		),

		follower: () =>
			follower ? (
				<div data-block="follower" class="px-4 pt-1.5 pb-2.5 text-[13px]" style="color: #666;">
					{follower}
				</div>
			) : null,

		desc: () =>
			p.hideDesc ? null : (
				<div
					data-block="desc"
					class="px-4 pt-1.5 pb-2.5 text-[13px] leading-normal"
					style="color: #999;"
				>
					{description || "这个主播很懒，什么简介都没写"}
				</div>
			),
	};

	const order = (p.layout ?? DEFAULT_CARD_LAYOUT.live).filter((b) => b.visible).map((b) => b.id);

	return (
		<div
			class="h-auto p-3.75"
			style={{
				background: `linear-gradient(to right bottom, ${p.cardColorStart}, ${p.cardColorEnd})`,
			}}
		>
			<div
				class="overflow-hidden rounded-xl"
				style="background: rgba(255,255,255,0.82); backdrop-filter: blur(10px); box-shadow: 0 4px 16px rgba(0,0,0,0.12); min-width: 360px;"
			>
				{order.map((id) => blocks[id]?.())}
			</div>
		</div>
	);
}
