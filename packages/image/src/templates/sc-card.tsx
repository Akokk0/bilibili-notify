/** @jsxImportSource vue */
import { type CardBlock, DEFAULT_CARD_LAYOUT } from "@bilibili-notify/internal";
import { FRAMES } from "../blocks/frames";
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
	// 各块的 JSX 住在 `blocks/sc.tsx`、外框住在 `blocks/frames.tsx`(皮肤路径共用的同两份);
	// 这里只剩「把块按旧版式装进外框」。
	const builders = bindBlocks(SC_BLOCKS, p);
	return FRAMES.sc(p, renderBlocks(p.layout ?? DEFAULT_CARD_LAYOUT.sc, builders, "w-full"));
}
