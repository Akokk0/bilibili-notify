/** @jsxImportSource vue */

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
				{/* ── 封面图 ── */}
				<div class="px-4 pt-3.5">
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

				{/* ── 主播信息 ── */}
				<div class="flex items-center gap-2.5 px-4 pt-3.5 pb-2.5">
					<img
						class="w-11 h-11 rounded-full object-cover shrink-0"
						src={p.userface}
						alt="主播头像"
					/>
					<div class="flex flex-col gap-0.5 min-w-0">
						<span class="text-[16px] font-bold leading-none" style="color: #18191C;">
							{p.username}
						</span>
						<span class="text-[12px]" style="color: #999;">
							{p.liveTime}
						</span>
					</div>
				</div>

				{/* ── 直播标题 ── */}
				<div class="px-4 pb-2.5 text-[17px] font-bold leading-snug" style="color: #18191C;">
					{p.data.title}
				</div>

				{/* 分隔线 */}
				<div style="height: 1px; background: rgba(0,0,0,0.06); margin: 0 16px;" />

				{/* ── 数据区 ── */}
				<div class="px-4 py-2.5 flex flex-col gap-1.5">
					<div class="flex justify-between text-[13px]" style="color: #666;">
						<span>{statsLeft()}</span>
						<span>分区：{p.data.area_name}</span>
					</div>

					{follower && (
						<div class="text-[13px]" style="color: #666;">
							{follower}
						</div>
					)}

					{!p.hideDesc && (
						<div class="text-[13px] leading-normal" style="color: #999;">
							{description || "这个主播很懒，什么简介都没写"}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
