/**
 * 这种卡的 **props 契约**。整卡模板(把块按旧版式装进外框那一层)已退役 —— 出图与测试
 * 一律走皮肤渲染器,整卡模板一处都不剩了(ADR-0014 决策 24 的 2026-09-18 🔗)。块渲染器
 * 与外框吃的仍是这份 props,所以类型留在原地。
 */
export type LiveCardProps = {
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
};
