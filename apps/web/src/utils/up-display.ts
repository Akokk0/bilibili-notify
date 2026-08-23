/**
 * UP 主的展示名 —— 从 `pages/up/helpers` 挪来:`components/scope-tabs` 也要用它,
 * 而组件层反向 import 页面层是圈套(pages 本来就 import components,迟早成环)。
 * helpers 原地转口,页面侧引用点不用改。
 */

import type { Subscription } from "../types/domain";

export function displayName(sub: Subscription): string {
	return sub.cachedProfile?.name?.trim() || `UID ${sub.uid}`;
}
