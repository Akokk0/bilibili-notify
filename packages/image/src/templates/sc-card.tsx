/** @jsxImportSource vue */
import { type CardBlock, DEFAULT_CARD_LAYOUT } from "@bilibili-notify/internal";
import { SC_BLOCKS } from "../blocks/sc";
import { bindBlocks } from "../blocks/types";
import { renderBlocks } from "./block-layout";

export type SCCardProps = {
	senderFace: string;
	senderName: string;
	masterName: string;
	masterAvatarUrl?: string;
	text: string;
	price: number;
	duration: string;
	bgColor: readonly [string, string];
	/**
	 * sc 版式描述符(块的顺序 + 显隐 + 边距 + 分割线)。缺省 = `DEFAULT_CARD_LAYOUT.sc`,
	 * 复刻现状。块按 type 渲染;无留言文本时 message 块自动收起。
	 */
	layout?: CardBlock[];
	/** 玻璃片(内容层)透明度 0..1;缺省走 sc 基线 0.75。 */
	glassOpacity?: number;
	/** 完全透明:白层透明 + 去掉毛玻璃模糊,底图完全清晰透出(优先于 glassOpacity)。 */
	glassClear?: boolean;
	/** 自定义背景图(已解析的 data URL / http URL);非空时替换外框渐变。 */
	backgroundImage?: string;
};

export function SCCard(p: SCCardProps) {
	// 各块的 JSX 住在 `blocks/sc.tsx`(皮肤按块装配的同一份);这里只剩外框。
	const builders = bindBlocks(SC_BLOCKS, p);

	// 完全透明:白层透明 + 无模糊;否则用透明度(0 也保留磨砂)。
	const glass = p.glassClear ? 0 : (p.glassOpacity ?? 0.75);
	const blur = p.glassClear ? 0 : 10;

	return (
		<div
			class="flex justify-center items-center w-[290px] p-[15px]"
			style={{
				background: p.backgroundImage
					? `url("${p.backgroundImage}") center / cover`
					: `linear-gradient(to right bottom, ${p.bgColor[0]}, ${p.bgColor[1]})`,
			}}
		>
			<div
				class="flex flex-col items-center w-[260px] px-[16px] py-5 rounded-[10px] shadow-[0_4px_8px_0_rgba(0,0,0,0.2)]"
				style={{
					background: `rgba(255,255,255,${glass})`,
					backdropFilter: `blur(${blur}px)`,
				}}
			>
				{renderBlocks(p.layout ?? DEFAULT_CARD_LAYOUT.sc, builders, "w-full")}
			</div>
		</div>
	);
}
