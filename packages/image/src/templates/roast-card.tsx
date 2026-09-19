/** @jsxImportSource vue */

/**
 * AI 锐评卡 —— 榜单周报({@link RoastBoardCard})与单人锐评({@link RoastSoloCard})。
 *
 * 与其它卡最大的不同:正文**整段由大模型生成**,没有任何 B 站原始结构可依。所以
 * 这里一律走 JSX 文本节点(Vue 会转义),**绝不用 `innerHTML`** —— SC 卡为了保留
 * 换行用了它,那是因为文本来自 B 站弹幕且已手工转义过;模型输出没有那个前提。
 *
 * 这两张卡不接 `cardStyleByKind` 的 per-kind 样式矩阵,也没有版式编辑器:那套是
 * 「每位 UP × 每种卡」的二维覆盖,而榜单卡压根不属于任何单个 UP。配色跟词云卡
 * 同源,直接吃全局 `cardStyle`。
 *
 * 正文(两张卡各自的 `body` 块)住在 `blocks/roast.tsx`,这里只剩外框 + 玻璃片。
 *
 * 图标一律用 `icons.tsx` 那批内联 SVG,**卡里不写 emoji** —— emoji 的
 * 长相由渲染机器的字体决定,同一张卡在开发机、Docker 镜像、桌面版上各画各的,
 * 缺字体时直接是豆腐块。推送的纯文字消息不受此限(那边由 IM 客户端画)。
 */

import type { VNode } from "vue";
import { FRAMES } from "../blocks/frames";
import { ROAST_BOARD_BLOCKS, ROAST_SOLO_BLOCKS } from "../blocks/roast";

export type RoastCardUp = {
	name: string;
	/** B 站头像 URL(渲染前已内联成 data URL);缺省时退回首字母圆牌。 */
	avatar?: string;
	/** 该 UP 的强调色,来自 `colorFromUid` —— 与 dashboard 上同一位 UP 的颜色一致。 */
	color: string;
};

export type RoastBoardCardProps = {
	/** 统计窗口天数。必须标在卡上:同一份榜单在 7 日和 30 日下讲的不是一回事。 */
	days: number;
	pigeon: RoastCardUp & { reason: string };
	diligent: RoastCardUp & { reason: string };
	roast: Array<RoastCardUp & { comment: string }>;
	scores: Array<RoastCardUp & { score: number }>;
	cardColorStart: string;
	cardColorEnd: string;
	/** 玻璃片(内容层)透明度 0..1;缺省走 0.86 —— 这张卡文字密,比 live 卡再实一点。 */
	glassOpacity?: number;
	/** 完全透明:内容层透明 + 去掉毛玻璃模糊(优先于 glassOpacity)。 */
	glassClear?: boolean;
};

export type RoastSoloCardProps = {
	days: number;
	up: RoastCardUp;
	verdict: string;
	score: number;
	highlights: Array<{ label: string; comment: string }>;
	cardColorStart: string;
	cardColorEnd: string;
	glassOpacity?: number;
	glassClear?: boolean;
};

/**
 * 正文块住在 `blocks/roast.tsx`、外框住在 `blocks/frames.tsx`(皮肤路径共用的同两份);
 * 这里只剩「把正文块装进外框」。
 *
 * 外框写成**普通函数**而不是组件,是因为 Vue 的函数式组件把 children 送进 slots 而
 * 不是 props —— 写成 `<CardFrame>…</CardFrame>` 时 `p.children` 恒为 undefined,
 * 卡片会渲染出一个完全空的外框(而且构建全绿,只在看图时才发现)。
 */
export function RoastBoardCard(p: RoastBoardCardProps) {
	return FRAMES.roastBoard(p, [ROAST_BOARD_BLOCKS.body(p) as VNode]);
}

export function RoastSoloCard(p: RoastSoloCardProps) {
	return FRAMES.roastSolo(p, [ROAST_SOLO_BLOCKS.body(p) as VNode]);
}
