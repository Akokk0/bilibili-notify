/** @jsxImportSource vue */

import type { GuardLevel } from "@bilibili-notify/blive";
import { DEFAULT_CARD_LAYOUT, type GuardLayout } from "@bilibili-notify/internal";
import { GUARD_BLOCKS } from "../blocks/guard";
import { bindBlocks } from "../blocks/types";
import { renderBlocks } from "./block-layout";

export type GuardCardProps = {
	captainImgUrl: string;
	guardLevel: GuardLevel;
	uname: string;
	face: string;
	isAdmin: number;
	masterAvatarUrl: string;
	masterName: string;
	bgColor: [string, string];
	/**
	 * guard 受限 2D 版式。`badgeSide` 决定徽章块靠左/靠右,`blocks`(name/text/可插分割线)
	 * 在另一侧上下排、顺序+显隐+边距由数组决定。缺省 = `DEFAULT_CARD_LAYOUT.guard`。
	 */
	layout?: GuardLayout;
	/** 玻璃片(内容层)透明度 0..1;缺省走 guard 基线 0.75。 */
	glassOpacity?: number;
	/** 完全透明:白层透明 + 去掉毛玻璃模糊,底图完全清晰透出(优先于 glassOpacity)。 */
	glassClear?: boolean;
	/** 自定义背景图(已解析的 data URL / http URL);非空时替换外框渐变。 */
	backgroundImage?: string;
};

export function GuardCard(p: GuardCardProps) {
	const layout = p.layout ?? DEFAULT_CARD_LAYOUT.guard;
	// 完全透明:白层透明 + 无模糊;否则用透明度(0 也保留磨砂)。
	const glass = p.glassClear ? 0 : (p.glassOpacity ?? 0.75);
	const blur = p.glassClear ? 0 : 10;

	// 各块的 JSX 住在 `blocks/guard.tsx`(皮肤按块装配的同一份);这里只剩外框与两块的定位。
	const builders = bindBlocks(GUARD_BLOCKS, p);
	const badgeLeft = layout.badgeSide === "left";

	// 内容列:name/text(可插分割线)按 layout.blocks 上下排;badge 在左时整列右对齐。
	const content = (
		<div
			class={`flex-1 min-w-0 h-full flex flex-col justify-between px-[16px] py-[12px] ${
				badgeLeft ? "items-end text-right" : ""
			}`}
		>
			{renderBlocks(layout.blocks, builders)}
		</div>
	);

	// 徽章块:舰长大图,受限 2D 里的常驻块,由 badgeSide 定位(自带 data-block,不经 renderBlocks)。
	const badge = GUARD_BLOCKS.badge(p);

	return (
		<div
			class="flex justify-center items-center w-[430px] h-[220px] p-[15px]"
			style={{
				background: p.backgroundImage
					? `url("${p.backgroundImage}") center / cover`
					: `linear-gradient(to right bottom, ${p.bgColor[0]}, ${p.bgColor[1]})`,
			}}
		>
			<div
				class="flex items-center w-[400px] h-[190px] rounded-[10px] shadow-[0_4px_8px_0_rgba(0,0,0,0.2)]"
				style={{
					background: `rgba(255,255,255,${glass})`,
					backdropFilter: `blur(${blur}px)`,
				}}
			>
				{layout.badgeSide === "left" ? [badge, content] : [content, badge]}
			</div>
		</div>
	);
}
