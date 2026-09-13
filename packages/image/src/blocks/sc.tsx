/** @jsxImportSource vue */

/**
 * SC(醒目留言)卡的块库。
 *
 * 复合块(amount / sender / message / divider)是从 `templates/sc-card.tsx` **原样搬**
 * 进来的那几段 JSX —— class、inline style、文案一个字都没动;原子块(avatar / name)是
 * **新抠**的:从 sender 里取出头像那一坨(定宽圆框 + img)与名牌胶囊,保持它们在复合块里
 * 的 class 与 style,让皮肤能把两件分开摆。
 *
 * 键名对齐 `CARD_SKIN_BUILTIN_BLOCKS.sc`,一个不多一个不少(`__tests__/card-blocks.test.ts`
 * 对表钉着)。
 */

import { DIVIDER_TYPE } from "@bilibili-notify/internal";
import { SVG_DURATION } from "../icons";
import type { SCCardProps } from "../templates/sc-card";
import type { BlockRenderer } from "./types";

/** 留言文本:B 站弹幕来的原文,手工转义后交给 `innerHTML` 以保留换行。 */
function escapeText(p: SCCardProps): string {
	return p.text
		?.trim()
		?.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\n/g, "<br>");
}

/** 发送者头像(原子块):sender 复合块里的那个定宽圆框 + img。 */
const avatar: BlockRenderer<SCCardProps> = (p) => (
	<div class="w-[70px] h-[70px] overflow-hidden rounded-full">
		<img class="w-full h-full rounded-full object-cover" src={p.senderFace} alt="发送者头像" />
	</div>
);

/** 发送者名(原子块):sender 复合块里的那个名牌胶囊。 */
const name: BlockRenderer<SCCardProps> = (p) => (
	<div
		class="px-[14px] py-[5px] rounded-[15px] text-white font-bold text-[14px]"
		style={{ backgroundColor: p.bgColor[0] }}
	>
		{p.senderName}
	</div>
);

/**
 * sc 卡的块表。每块返回内层 VNode(无 `data-block`),无数据时返回 null。
 * divider 是 sc 专属的渐变分割线(可重复)。
 */
export const SC_BLOCKS: Record<string, BlockRenderer<SCCardProps>> = {
	[DIVIDER_TYPE]: (p) => (
		<div
			class="w-full h-px"
			style={{
				background: `linear-gradient(to right, transparent, ${p.bgColor[0]}, transparent)`,
			}}
		/>
	),

	amount: (p) => (
		<div class="text-center">
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
	),

	sender: (p) => (
		<div class="flex flex-col items-center gap-2">
			<div class="w-[70px] h-[70px] overflow-hidden rounded-full">
				<img class="w-full h-full rounded-full object-cover" src={p.senderFace} alt="发送者头像" />
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
	),

	message: (p) => {
		const escapedText = escapeText(p);
		return escapedText ? (
			<div class="w-full text-center">
				<div class="px-3 py-[10px] bg-white/50 rounded-lg">
					<div
						class="text-[13px] text-[#333] leading-[1.6] break-words whitespace-pre-wrap"
						innerHTML={escapedText}
					/>
				</div>
			</div>
		) : null;
	},

	avatar,
	name,
};
