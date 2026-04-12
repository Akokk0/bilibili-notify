/** @jsxImportSource vue */

// ── SVG 图标常量 ──────────────────────────────────────────────────────────────

const SVG_DURATION = (
	<svg
		style="width:12px;height:12px;flex-shrink:0"
		xmlns="http://www.w3.org/2000/svg"
		viewBox="0 0 20 20"
		aria-label="时长"
	>
		<path
			d="M10 2.5C5.85786 2.5 2.5 5.85786 2.5 10C2.5 14.1421 5.85786 17.5 10 17.5C14.1421 17.5 17.5 14.1421 17.5 10C17.5 5.85786 14.1421 2.5 10 2.5ZM10 4C13.3137 4 16 6.68629 16 10C16 13.3137 13.3137 16 10 16C6.68629 16 4 13.3137 4 10C4 6.68629 6.68629 4 10 4Z"
			fill="currentColor"
		/>
		<path
			d="M10 6C10.4142 6 10.75 6.33579 10.75 6.75V9.68934L12.5303 11.4697C12.8232 11.7626 12.8232 12.2374 12.5303 12.5303C12.2374 12.8232 11.7626 12.8232 11.4697 12.5303L9.46967 10.5303C9.32902 10.3897 9.25 10.1989 9.25 10V6.75C9.25 6.33579 9.58579 6 10 6Z"
			fill="currentColor"
		/>
	</svg>
);

export type SCCardProps = {
	senderFace: string;
	senderName: string;
	masterName: string;
	masterAvatarUrl?: string;
	text: string;
	price: number;
	duration: string;
	bgColor: readonly [string, string];
};

export function SCCard(p: SCCardProps) {
	const escapedText = p.text
		?.trim()
		?.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\n/g, "<br>");

	return (
		<div
			class="flex justify-center items-center w-[280px] py-[15px]"
			style={{ background: `linear-gradient(to right bottom, ${p.bgColor[0]}, ${p.bgColor[1]})` }}
		>
			<div class="flex flex-col items-center w-[260px] px-[15px] py-5 rounded-[10px] shadow-[0_4px_8px_0_rgba(0,0,0,0.2)] bg-white/75 backdrop-blur-[10px]">
				{/* 金额区 */}
				<div class="text-center mb-[15px]">
					<div
						class="text-[36px] font-bold bg-clip-text text-transparent"
						style={{ backgroundImage: `linear-gradient(135deg, ${p.bgColor[0]}, ${p.bgColor[1]})` }}
					>
						¥{p.price}
					</div>
					<div
						class="inline-flex items-center gap-1 mt-[5px] px-[10px] py-1 rounded-[12px] text-white text-[12px] font-bold"
						style={{ backgroundColor: p.bgColor[0] }}
					>
						{SVG_DURATION}
						<span>{p.duration}</span>
					</div>
				</div>

				{/* 分割线 */}
				<div
					class="w-full h-px my-3"
					style={{
						background: `linear-gradient(to right, transparent, ${p.bgColor[0]}, transparent)`,
					}}
				/>

				{/* 头像区 */}
				<div class="flex flex-col items-center gap-2 mb-3">
					<div class="w-[70px] h-[70px] overflow-hidden rounded-full">
						<img
							class="w-full h-full rounded-full object-cover"
							src={p.senderFace}
							alt="发送者头像"
						/>
					</div>
					<div
						class="px-[14px] py-[5px] rounded-[15px] text-white font-bold text-[14px]"
						style={{ backgroundColor: p.bgColor[0] }}
					>
						{p.senderName}
					</div>
					<div class="flex items-center gap-[5px] text-[12px] text-[#666]">
						<span class="mr-[3px]">SC to</span>
						<div class="flex items-center gap-[2px]">
							{p.masterAvatarUrl && (
								<div
									class="w-[18px] h-[18px] rounded-full border border-black/10 bg-cover bg-center"
									style={{ backgroundImage: `url("${p.masterAvatarUrl}")` }}
								/>
							)}
							<span>{p.masterName}</span>
						</div>
					</div>
				</div>

				{/* 留言区 */}
				{escapedText && (
					<div class="w-full text-center">
						<div class="px-3 py-[10px] bg-white/50 rounded-lg">
							<div
								class="text-[13px] text-[#333] leading-[1.6] break-words whitespace-pre-wrap"
								innerHTML={escapedText}
							/>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
