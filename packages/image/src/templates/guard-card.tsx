/** @jsxImportSource vue */
import { DEFAULT_CARD_LAYOUT, DIVIDER_TYPE, type GuardLayout } from "@bilibili-notify/internal";
import type { GuardLevel } from "blive-message-listener";
import type { VNode } from "vue";
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
};

const GUARD_DESC: Record<GuardLevel, (uname: string, masterName: string) => string> = {
	0: () => "",
	1: (uname, masterName) => `"${uname}"上任\n"${masterName}"大航海舰队总督！`,
	2: (uname, masterName) => `"${uname}"就任\n"${masterName}"大航海舰队提督！`,
	3: (uname, masterName) => `"${uname}号"加入\n"${masterName}"大航海舰队！`,
};

export function GuardCard(p: GuardCardProps) {
	const desc = GUARD_DESC[p.guardLevel]?.(p.uname, p.masterName) ?? "";
	const layout = p.layout ?? DEFAULT_CARD_LAYOUT.guard;

	// 内容列块构建器(按 type):返回内层 VNode(无 data-block),无数据时返回 null。
	const builders: Record<string, () => VNode | null> = {
		[DIVIDER_TYPE]: () => (
			<div class="my-[6px]" style={{ height: "1px", background: `${p.bgColor[0]}33` }} />
		),
		name: () => (
			<div class="flex gap-[10px]">
				<div class="w-[90px] h-[90px] overflow-hidden rounded-full shrink-0">
					<img class="w-full h-full rounded-full object-cover" src={p.face} alt="用户头像" />
				</div>
				<div class="flex flex-col items-start gap-[7px] mt-[10px]">
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
		),

		text: () =>
			desc ? (
				<div
					class="text-[16px] font-bold italic whitespace-pre-line"
					style={{ color: p.bgColor[0] }}
				>
					{desc}
				</div>
			) : null,
	};

	// 内容列:name/text(可插分割线)按 layout.blocks 上下排。
	const content = (
		<div class="flex-1 min-w-0 h-full flex flex-col justify-between px-[16px] py-[12px]">
			{renderBlocks(layout.blocks, builders)}
		</div>
	);

	// 徽章块:舰长大图,受限 2D 里的常驻块,由 badgeSide 定位。
	const badge = (
		<div
			data-block="badge"
			class="w-[175px] h-[175px] bg-cover bg-center shrink-0"
			style={{ backgroundImage: `url("${p.captainImgUrl}")` }}
		/>
	);

	return (
		<div
			class="flex justify-center items-center w-[430px] h-[220px] p-[15px]"
			style={{ background: `linear-gradient(to right bottom, ${p.bgColor[0]}, ${p.bgColor[1]})` }}
		>
			<div class="flex items-center w-[400px] h-[190px] rounded-[10px] shadow-[0_4px_8px_0_rgba(0,0,0,0.2)] bg-white/75 backdrop-blur-[10px]">
				{layout.badgeSide === "left" ? [badge, content] : [content, badge]}
			</div>
		</div>
	);
}
