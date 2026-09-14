/** @jsxImportSource vue */

import { type CardBlock, DEFAULT_CARD_LAYOUT } from "@bilibili-notify/internal";
import { FRAMES } from "../blocks/frames";
import { LIVE_BLOCKS } from "../blocks/live";
import { bindBlocks } from "../blocks/types";
import { renderBlocks } from "./block-layout";

export type LiveCardProps = {
	cardColorStart: string;
	cardColorEnd: string;
	// biome-ignore lint/suspicious/noExplicitAny: Bilibili 直播 API 返回类型
	data: any;
	username: string;
	userface: string;
	titleStatus: string;
	liveTime: string;
	liveStatus: number;
	cover: boolean;
	/** 自定义封面(已解析 URL);有值时优先于 user_cover / keyframe。 */
	coverOverride?: string;
	onlineNum: string;
	likedNum: string;
	watchedNum: string;
	fansNum: string;
	fansChanged: string;
	/**
	 * live 版式描述符(块的顺序 + 显隐 + 边距 + 分割线)。缺省 = `DEFAULT_CARD_LAYOUT.live`,
	 * 复刻现状。块按 type 渲染、`visible=false` 跳过;某态无数据的块自动收起。
	 */
	layout?: CardBlock[];
	/** 玻璃片(内容层)透明度 0..1;缺省走 live 基线 0.82。 */
	glassOpacity?: number;
	/** 完全透明:白层透明 + 去掉毛玻璃模糊,底图完全清晰透出(优先于 glassOpacity)。 */
	glassClear?: boolean;
	/** 自定义背景图(已解析的 data URL / http URL);非空时替换外框渐变。 */
	backgroundImage?: string;
};

export function LiveCard(p: LiveCardProps) {
	// 各块的 JSX 住在 `blocks/live.tsx`、外框住在 `blocks/frames.tsx`(皮肤路径共用的同两份);
	// 这里只剩「把块按旧版式装进外框」。
	const builders = bindBlocks(LIVE_BLOCKS, p);
	return FRAMES.live(p, renderBlocks(p.layout ?? DEFAULT_CARD_LAYOUT.live, builders));
}
