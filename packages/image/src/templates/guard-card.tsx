/** @jsxImportSource vue */

import type { GuardLevel } from "@bilibili-notify/blive";
import { DEFAULT_CARD_LAYOUT, type GuardLayout } from "@bilibili-notify/internal";
import type { VNode } from "vue";
import { FRAMES } from "../blocks/frames";
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

	// 各块的 JSX 住在 `blocks/guard.tsx`、外框(到玻璃层为止)住在 `blocks/frames.tsx` ——
	// 皮肤路径共用的同两份;玻璃层里这个「内容列 + 徽章」的二分结构是**旧版式专属**的
	// (受限 2D),所以留在这里当 children 传进去,不进 FRAMES。
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
	// 它恒有内容(等级图是必给的),`BlockRenderer` 的可空签名在这条路上用不上。
	const badge = GUARD_BLOCKS.badge(p) as VNode;

	return FRAMES.guard(p, layout.badgeSide === "left" ? [badge, content] : [content, badge]);
}
