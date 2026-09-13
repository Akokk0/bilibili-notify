/** @jsxImportSource vue */

import { type CardBlock, DEFAULT_CARD_LAYOUT } from "@bilibili-notify/internal";
import { LIVE_BLOCKS } from "../blocks/live";
import { bindBlocks } from "../blocks/types";
import { renderBlocks } from "./block-layout";

export type LiveCardProps = {
	/** 数据区:显示人气 / 点赞(直播中=人气,下播=点赞)。 */
	showPopularity: boolean;
	/** 数据区:显示分区。 */
	showArea: boolean;
	/** 数据区:显示粉丝数据(当前粉丝数 / 累计观看 / 粉丝变化,按直播态)。 */
	showFans: boolean;
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
	// 各块的 JSX 住在 `blocks/live.tsx`(皮肤按块装配的同一份);这里只剩外框。
	const builders = bindBlocks(LIVE_BLOCKS, p);

	const frameBg = p.backgroundImage
		? `url("${p.backgroundImage}") center / cover`
		: `linear-gradient(to right bottom, ${p.cardColorStart}, ${p.cardColorEnd})`;
	// 完全透明:白层透明 + 无模糊;否则用透明度(0 也保留磨砂)。
	const glass = p.glassClear ? 0 : (p.glassOpacity ?? 0.82);
	const blur = p.glassClear ? 0 : 10;

	return (
		<div class="h-auto p-3.75" style={{ background: frameBg }}>
			<div
				class="overflow-hidden rounded-xl"
				style={`background: rgba(255,255,255,${glass}); backdrop-filter: blur(${blur}px); box-shadow: 0 4px 16px rgba(0,0,0,0.12); min-width: 360px; padding-top: 14px; padding-bottom: 10px;`}
			>
				{renderBlocks(p.layout ?? DEFAULT_CARD_LAYOUT.live, builders)}
			</div>
		</div>
	);
}
