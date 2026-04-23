/** @jsxImportSource vue */

export type WordCloudCardProps = {
	masterName: string;
	masterAvatarUrl?: string;
	colorStart: string;
	colorEnd: string;
};

export function WordCloudCard(p: WordCloudCardProps) {
	return (
		<div
			class="h-auto p-[15px]"
			style={{ background: `linear-gradient(to right bottom, ${p.colorStart}, ${p.colorEnd})` }}
		>
			<div
				class="overflow-hidden rounded-[12px]"
				style="background: rgba(255,255,255,0.82); backdrop-filter: blur(10px); box-shadow: 0 4px 16px rgba(0,0,0,0.12);"
			>
				{/* ── 头部：头像 + 标题 ── */}
				<div class="flex items-center gap-[10px] px-[16px] pt-[14px] pb-[10px]">
					{p.masterAvatarUrl && (
						<img
							class="w-[44px] h-[44px] rounded-full object-cover shrink-0"
							src={p.masterAvatarUrl}
							alt="头像"
						/>
					)}
					<div class="flex flex-col gap-[2px] min-w-0">
						<span class="text-[16px] font-bold leading-none" style="color: #18191C;">
							{p.masterName}
						</span>
						<span class="text-[12px]" style="color: #999;">
							本场直播弹幕词云
						</span>
					</div>
				</div>

				{/* ── 分隔线 ── */}
				<div style="height: 1px; background: rgba(0,0,0,0.06); margin: 0 16px;" />

				{/* ── 词云画布 ── */}
				<div class="px-[16px] pt-[12px] pb-[14px]">
					<canvas id="wordCloudCanvas" style="width: 100%; height: 400px; display: block;" />
				</div>
			</div>
		</div>
	);
}
