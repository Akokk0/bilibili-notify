/**
 * AI 锐评卡 —— 榜单周报与单人锐评的 **props 契约**。
 *
 * 整卡模板(把块按旧版式装进外框那一层)已退役(ADR-0014 决策 24 的 2026-09-18 🔗) ——
 * 出图七个入口全走皮肤渲染器,正文块住在 `blocks/roast.tsx`、外框住在 `blocks/frames.tsx`,
 * 它们吃的仍是这份 props,所以类型留在原地。
 *
 * 与其它卡最大的不同:正文**整段由大模型生成**,没有任何 B 站原始结构可依。所以块里
 * 一律走 JSX 文本节点(Vue 会转义),**绝不用 `innerHTML`** —— SC 卡为了保留换行用了它,
 * 那是因为文本来自 B 站弹幕且已手工转义过;模型输出没有那个前提。
 *
 * 这两张卡不接 `cardStyleByKind` 的 per-kind 样式矩阵:那套是「每位 UP × 每种卡」的二维
 * 覆盖,而榜单卡压根不属于任何单个 UP。
 *
 * 图标一律用 `icons.tsx` 那批内联 SVG,**卡里不写 emoji** —— emoji 的长相由渲染机器的
 * 字体决定,同一张卡在开发机、Docker 镜像、桌面版上各画各的,缺字体时直接是豆腐块。
 * 推送的纯文字消息不受此限(那边由 IM 客户端画)。
 */

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
};

export type RoastSoloCardProps = {
	days: number;
	up: RoastCardUp;
	verdict: string;
	score: number;
	highlights: Array<{ label: string; comment: string }>;
};
