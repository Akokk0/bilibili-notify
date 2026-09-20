/**
 * 这种卡的 **props 契约**。整卡模板(把块按旧版式装进外框那一层)已退役 —— 出图与测试
 * 一律走皮肤渲染器,整卡模板一处都不剩了(ADR-0014 决策 24 的 2026-09-18 🔗)。块渲染器
 * 与外框吃的仍是这份 props,所以类型留在原地。
 */
import type { GuardLevel } from "@bilibili-notify/blive";

export type GuardCardProps = {
	captainImgUrl: string;
	guardLevel: GuardLevel;
	uname: string;
	face: string;
	isAdmin: number;
	masterAvatarUrl: string;
	masterName: string;
	bgColor: [string, string];
};
