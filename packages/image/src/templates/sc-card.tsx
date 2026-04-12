/** @jsxImportSource vue */
import { SVG_DURATION } from "../icons";

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
