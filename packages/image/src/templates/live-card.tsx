/** @jsxImportSource vue */

export type LiveCardProps = {
	hideDesc: boolean;
	followerDisplay: boolean;
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
		if (p.liveStatus === 3) return { text: "下播统计", bg: "#aaa" };
		return { text: "未开播", bg: "#aaa" };
	};

	const statsLeft = () => {
		if (p.liveStatus === 3) return `点赞：${p.likedNum}`;
		return `人气：${p.onlineNum}`;
	};

	const followerText = () => {
		if (p.liveStatus === 1) return p.fansNum ? `粉丝：${p.fansNum}` : "";
		if (p.liveStatus === 2) return p.watchedNum !== "API" ? `观看：${p.watchedNum}` : "";
		if (p.liveStatus === 3) return p.fansChanged ? `粉丝变化：${p.fansChanged}` : "";
		return "";
	};

	const status = statusLabel();
	const follower = p.followerDisplay ? followerText() : "";

	return (
		<div
			class="h-auto p-[15px]"
			style={{
				background: `linear-gradient(to right bottom, ${p.cardColorStart}, ${p.cardColorEnd})`,
			}}
		>
			<div
				class="overflow-hidden rounded-[12px]"
				style="background: rgba(255,255,255,0.82); backdrop-filter: blur(10px); box-shadow: 0 4px 16px rgba(0,0,0,0.12); min-width: 360px;"
			>
				{/* ── 封面图 ── */}
				<div class="px-[16px] pt-[14px]">
					<div class="relative w-full">
						<img
							class="block w-full rounded-[8px]"
							src={p.cover ? p.data.user_cover : p.data.keyframe}
							alt="封面"
						/>
						{/* 直播状态角标，叠在封面右上角 */}
						<div
							class="absolute top-[8px] right-[8px] px-[10px] py-[4px] rounded-[12px] text-white text-[12px] font-bold"
							style={{ backgroundColor: status.bg }}
						>
							{status.text}
						</div>
					</div>
				</div>

				{/* ── 主播信息 ── */}
				<div class="flex items-center gap-[10px] px-[16px] pt-[14px] pb-[10px]">
					<img
						class="w-[44px] h-[44px] rounded-full object-cover shrink-0"
						style="border: 2px solid #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.15);"
						src={p.userface}
						alt="主播头像"
					/>
					<div class="flex flex-col gap-[2px] min-w-0">
						<span class="text-[16px] font-bold leading-none" style="color: #18191C;">
							{p.username}
						</span>
						<span class="text-[12px]" style="color: #999;">
							{p.liveTime}
						</span>
					</div>
				</div>

				{/* ── 直播标题 ── */}
				<div class="px-[16px] pb-[10px] text-[17px] font-bold leading-snug" style="color: #18191C;">
					{p.data.title}
				</div>

				{/* 分隔线 */}
				<div style="height: 1px; background: rgba(0,0,0,0.06); margin: 0 16px;" />

				{/* ── 数据区 ── */}
				<div class="px-[16px] py-[10px] flex flex-col gap-[6px]">
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
						<div class="text-[13px] leading-[1.5]" style="color: #999;">
							{p.data.description || "这个主播很懒，什么简介都没写"}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
