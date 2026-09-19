/**
 * 这种卡的 **props 契约**。整卡模板(把块按旧版式装进外框那一层)已退役 —— 出图七个入口
 * 早就全走皮肤渲染器,模板只剩测试还在渲染(ADR-0014 决策 24 的 2026-09-18 🔗)。块渲染器
 * 与外框吃的仍是这份 props,所以类型留在原地。
 */
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
	/** 玻璃片(内容层)透明度 0..1;缺省走 live 基线 0.82。 */
	glassOpacity?: number;
	/** 完全透明:白层透明 + 去掉毛玻璃模糊,底图完全清晰透出(优先于 glassOpacity)。 */
	glassClear?: boolean;
};
