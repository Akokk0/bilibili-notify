/** @jsxImportSource vue */

/**
 * 上舰卡的块库。
 *
 * 复合块(badge / name / text / divider)是从 `templates/guard-card.tsx` **原样搬**进来的
 * 那几段 JSX —— class、inline style、文案一个字都没动(badge 今天不经 `renderBlocks`,所以
 * 它自带的 `data-block="badge"` 也照搬);原子块(avatar)是**新抠**的:从 name 里取出头像
 * 那一坨(定宽圆框 + img),保持它在复合块里的 class 与 style,让皮肤能单独摆头像。
 *
 * 键名对齐 `CARD_SKIN_BUILTIN_BLOCKS.guard`,一个不多一个不少(`__tests__/card-blocks.test.ts`
 * 对表钉着)。
 */

import type { GuardLevel } from "@bilibili-notify/blive";
import { DEFAULT_CARD_LAYOUT, DIVIDER_TYPE } from "@bilibili-notify/internal";
import type { GuardCardProps } from "../templates/guard-card";
import type { BlockRenderer } from "./types";

const GUARD_DESC: Record<GuardLevel, (uname: string, masterName: string) => string> = {
	0: () => "",
	1: (uname, masterName) => `"${uname}"上任\n"${masterName}"大航海舰队总督！`,
	2: (uname, masterName) => `"${uname}"就任\n"${masterName}"大航海舰队提督！`,
	3: (uname, masterName) => `"${uname}号"加入\n"${masterName}"大航海舰队！`,
};

/** 徽章靠左 → 内容在右,整列镜像右对齐(文字右对齐、姓名行头像移到外侧右边)。 */
function isBadgeLeft(p: GuardCardProps): boolean {
	return (p.layout ?? DEFAULT_CARD_LAYOUT.guard).badgeSide === "left";
}

/** 头像(原子块):name 复合块里的那个定宽圆框 + img。 */
const avatar: BlockRenderer<GuardCardProps> = (p) => (
	<div class="w-[90px] h-[90px] overflow-hidden rounded-full shrink-0">
		<img class="w-full h-full rounded-full object-cover" src={p.face} alt="用户头像" />
	</div>
);

/**
 * guard 卡的块表。name / text / divider 走内容列的 `renderBlocks`;badge 是受限 2D 里的
 * 常驻块,由模板按 `badgeSide` 直接定位(所以它自带 `data-block`)。
 */
export const GUARD_BLOCKS: Record<string, BlockRenderer<GuardCardProps>> = {
	[DIVIDER_TYPE]: (p) => (
		<div class="my-[6px]" style={{ height: "1px", background: `${p.bgColor[0]}33` }} />
	),

	// 徽章块:舰长大图,受限 2D 里的常驻块,由 badgeSide 定位。
	badge: (p) => (
		<div
			data-block="badge"
			class="w-[175px] h-[175px] bg-cover bg-center shrink-0"
			style={{ backgroundImage: `url("${p.captainImgUrl}")` }}
		/>
	),

	name: (p) => {
		const badgeLeft = isBadgeLeft(p);
		return (
			<div class={`flex gap-[10px] ${badgeLeft ? "flex-row-reverse" : ""}`}>
				<div class="w-[90px] h-[90px] overflow-hidden rounded-full shrink-0">
					<img class="w-full h-full rounded-full object-cover" src={p.face} alt="用户头像" />
				</div>
				<div class={`flex flex-col gap-[7px] mt-[10px] ${badgeLeft ? "items-end" : "items-start"}`}>
					<div
						class="flex items-center h-[30px] rounded-[25px] px-[10px] overflow-hidden"
						style={{ backgroundColor: p.bgColor[0] }}
					>
						<span class="max-w-[100px] truncate font-bold text-[12px] text-white">{p.uname}</span>
					</div>
					<div
						class="flex gap-[5px] items-center h-[25px] rounded-[25px] overflow-hidden"
						style={{ backgroundColor: p.bgColor[0] }}
					>
						<div
							class="w-[25px] h-[25px] rounded-full bg-cover bg-center shrink-0"
							style={{ backgroundImage: `url("${p.masterAvatarUrl}")` }}
						/>
						<span class="max-w-[85px] truncate text-white text-[10px] font-bold mr-[5px]">
							{p.isAdmin ? "房管" : p.masterName}
						</span>
					</div>
				</div>
			</div>
		);
	},

	text: (p) => {
		const desc = GUARD_DESC[p.guardLevel]?.(p.uname, p.masterName) ?? "";
		return desc ? (
			<div class="text-[16px] font-bold italic whitespace-pre-line" style={{ color: p.bgColor[0] }}>
				{desc}
			</div>
		) : null;
	},

	avatar,
};
