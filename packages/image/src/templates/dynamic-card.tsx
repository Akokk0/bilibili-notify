/** @jsxImportSource vue */
import { type CardBlock, DEFAULT_CARD_LAYOUT } from "@bilibili-notify/internal";
import { dynamicNodeBuilders } from "../blocks/dynamic";
import { renderBlocks } from "./block-layout";
import type { DynamicNode } from "./dynamic-content";

export type { DynamicNode };

export type DynamicCardProps = {
	cardColorStart: string;
	cardColorEnd: string;
	/** 动态内容结构树(含可选的内部转发原动态)。 */
	node: DynamicNode;
	/**
	 * dynamic 版式描述符(块的顺序 + 显隐 + 边距 + 分割线)。缺省 = `DEFAULT_CARD_LAYOUT.dynamic`,
	 * 复刻现状。块按 type 渲染、`visible=false` 跳过;无附加内容时 additional 块自动收起。
	 * 话题标签内联在正文块顶部(无独立块);内部转发的原动态用**同一套版式**递归渲染。
	 */
	layout?: CardBlock[];
	/** 玻璃片(内容层)透明度 0..1;缺省走 dynamic 基线 0.82。 */
	glassOpacity?: number;
	/** 完全透明:白层透明 + 去掉毛玻璃模糊,底图完全清晰透出(优先于 glassOpacity)。 */
	glassClear?: boolean;
	/** 自定义背景图(已解析的 data URL / http URL);非空时替换外框渐变。 */
	backgroundImage?: string;
};

/** 各块的 JSX 住在 `blocks/dynamic.tsx`(皮肤按块装配的同一份);这里只剩外框。 */
export function DynamicCard(p: DynamicCardProps) {
	const layout = p.layout ?? DEFAULT_CARD_LAYOUT.dynamic;
	const frameBg = p.backgroundImage
		? `url("${p.backgroundImage}") center / cover`
		: `linear-gradient(to right bottom, ${p.cardColorStart}, ${p.cardColorEnd})`;
	// 完全透明:白层透明 + 无模糊;否则用透明度(0 也保留磨砂)。
	const glass = p.glassClear ? 0 : (p.glassOpacity ?? 0.82);
	const blur = p.glassClear ? 0 : 10;
	return (
		<div class="h-auto p-[15px]" style={{ background: frameBg, minWidth: "380px" }}>
			<div
				class="w-full overflow-hidden rounded-[12px]"
				style={`background: rgba(255,255,255,${glass}); backdrop-filter: blur(${blur}px); box-shadow: 0 4px 16px rgba(0,0,0,0.12); padding-top: 14px; padding-bottom: 12px;`}
			>
				{renderBlocks(layout, dynamicNodeBuilders(p.node, layout))}
			</div>
		</div>
	);
}
