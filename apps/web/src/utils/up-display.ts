/**
 * UP 主的展示名 —— 从 `pages/up/helpers` 挪来:`components/scope-tabs` 也要用它,
 * 而组件层反向 import 页面层是圈套(pages 本来就 import components,迟早成环)。
 * helpers 原地转口,页面侧引用点不用改。
 */

import { colorFromUid } from "@bilibili-notify/internal/constants";
import { isBiliSubscription, type Subscription } from "../types/domain";

/**
 * B 站订阅没拿到资料时回落到「UID xxx」;拓展订阅(ADR-0019 决策 9)没有 uid,回落到主人起的
 * 名字、再回落到它的外部 id —— 总得认得出是哪一个。
 */
export function displayName(sub: Subscription): string {
	const cached = sub.cachedProfile?.name?.trim();
	if (cached) return cached;
	if (isBiliSubscription(sub)) return `UID ${sub.uid}`;
	return sub.name?.trim() || sub.externalId;
}

/**
 * 这条订阅在页面上的颜色。B 站订阅按 uid 取(与服务端渲染周报图时同一套,同一位 UP 在页面
 * 与图上是同一个颜色);拓展订阅没有 uid,按订阅自己的 id 取 —— 稳定,且不会与某位 B 站 UP
 * 撞成同一个人的颜色。
 */
export function subscriptionColor(sub: Subscription): string {
	return colorFromUid(isBiliSubscription(sub) ? sub.uid : sub.id);
}
