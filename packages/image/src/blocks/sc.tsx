/** @jsxImportSource vue */

/**
 * SC(醒目留言)卡的块库。
 *
 * 复合块(amount / sender / message / divider)是从 `templates/sc-card.tsx` **原样搬**
 * 进来的那几段 JSX —— class、inline style、文案一个字都没动;原子块是**新抠**的,保持它们在
 * 复合块里的 class 与 style,让皮肤能把各件分开摆:
 * - avatar / name:sender 里的头像那一坨(定宽圆框 + img)与名牌胶囊;
 * - to(2026-09-18,决策 8 的 🔗):sender 里「SC to」那一行,主播小头像与主播名照挂;
 * - price / duration(同日):amount 里的金额数字与时长胶囊。档位色变量在复合块里挂在 amount
 *   **根上**,单独摆没有那个根,所以两件各自带上(金额是渐变裁字,缺一个变量字就透明了)。
 *
 * 键名对齐 `CARD_SKIN_BUILTIN_BLOCKS.sc`,一个不多一个不少(`__tests__/card-blocks.test.ts`
 * 对表钉着)。
 *
 * 复合块内部的部件挂 `data-bn="<挂点>"`(ADR-0014 决策 9),挂点名取自
 * `CARD_SKIN_BUILTIN_BLOCKS.sc[<块>].hooks`;原子块的**根**是 `self`,所以根上不挂,里头带着的
 * 部件照挂(`__tests__/card-hooks.test.ts` 两头钉着)。
 *
 * **这块暴露的 CSS 变量**(ADR-0014 决策 13 的 🔗):颜色的**值**留在 inline 的 `--bn-*`
 * 自定义属性里,颜色**属性**(`color` / `background*`)写到 class 上 —— 皮肤 CSS 的
 * `!important` 被清洗器摘掉,inline 声明永远压不过,写成 class 皮肤才染得动。
 *
 * | 变量 | 含义 | 挂在哪 |
 * | --- | --- | --- |
 * | `--bn-card-tier-color` | 价位档位色的起色(`bgColor[0]`) | `divider` 块根(= 线自己)、`amount` 块根、`name` 名牌胶囊、`price` / `duration` 原子块 |
 * | `--bn-card-tier-color-end` | 价位档位色的止色(`bgColor[1]`) | `amount` 块根、`price` 原子块 |
 *
 * 写法用 UnoCSS 的**任意属性** `[color:var(--bn-x)]`,不用 `text-[var(--bn-x)]`:preset-wind4 的
 * 颜色工具类会编成 `color-mix(in oklab, … , transparent)`,那趟色彩空间往返**会动像素**
 * (本机 Chrome 实测,14 个颜色里 12 个栅格字节变了),像素门当场红。
 *
 * 名牌胶囊的变量刻意挂在**胶囊自己**身上而不是 `sender` 块根:`name` 原子块就是这颗胶囊,
 * 两边必须逐字同形(`__tests__/card-blocks.test.ts` 的「原子块与复合块同形」钉着),
 * 变量提到复合块根上原子块就没人给它值了。
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
		class="px-[14px] py-[5px] rounded-[15px] text-white font-bold text-[14px] [background-color:var(--bn-card-tier-color)]"
		style={{ "--bn-card-tier-color": p.bgColor[0] }}
	>
		{p.senderName}
	</div>
);

/** 金额(原子块):amount 复合块里的金额数字,自带那两个档位色变量(渐变裁字要用)。 */
const price: BlockRenderer<SCCardProps> = (p) => (
	<div
		class="text-[36px] font-bold bg-clip-text text-transparent [background-image:linear-gradient(135deg,var(--bn-card-tier-color),var(--bn-card-tier-color-end))]"
		style={{
			"--bn-card-tier-color": p.bgColor[0],
			"--bn-card-tier-color-end": p.bgColor[1],
		}}
	>
		¥{p.price}
	</div>
);

/** 时长胶囊(原子块):amount 复合块里的那颗胶囊,自带档位色变量(底色要用)。 */
const duration: BlockRenderer<SCCardProps> = (p) => (
	<div
		class="inline-flex items-center gap-1 mt-[5px] px-[10px] py-1 rounded-[12px] text-white text-[12px] font-bold [background-color:var(--bn-card-tier-color)]"
		style={{ "--bn-card-tier-color": p.bgColor[0] }}
	>
		{SVG_DURATION}
		<span>{p.duration}</span>
	</div>
);

/** 「SC to」那一行(原子块):sender 复合块里的那一行,主播小头像与主播名的挂点照挂。 */
const to: BlockRenderer<SCCardProps> = (p) => (
	<div class="flex items-center gap-[5px] text-[12px] text-[#666]">
		<span class="mr-[3px]">SC to</span>
		<div class="flex items-center gap-[2px]">
			{p.masterAvatarUrl && (
				<div
					data-bn="masterAvatar"
					class="w-[18px] h-[18px] rounded-full border border-black/10 bg-cover bg-center"
					style={{ backgroundImage: `url("${p.masterAvatarUrl}")` }}
				/>
			)}
			<span data-bn="masterName">{p.masterName}</span>
		</div>
	</div>
);

/**
 * sc 卡的块表。每块返回内层 VNode(无 `data-block`),无数据时返回 null。
 * divider 是 sc 专属的渐变分割线(可重复)。
 */
export const SC_BLOCKS: Record<string, BlockRenderer<SCCardProps>> = {
	[DIVIDER_TYPE]: (p) => (
		<div
			class="w-full h-px [background:linear-gradient(to_right,transparent,var(--bn-card-tier-color),transparent)]"
			style={{ "--bn-card-tier-color": p.bgColor[0] }}
		/>
	),

	message: (p) => {
		const escapedText = escapeText(p);
		return escapedText ? (
			<div class="w-full text-center">
				<div class="px-3 py-[10px] bg-white/50 rounded-lg">
					<div
						data-bn="text"
						class="text-[13px] text-[#333] leading-[1.6] break-words whitespace-pre-wrap"
						innerHTML={escapedText}
					/>
				</div>
			</div>
		) : null;
	},

	avatar,
	name,
	price,
	duration,
	to,
};
