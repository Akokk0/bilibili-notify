import { GuardLevel } from "@bilibili-notify/blive";

// ── 颜色数据 ──────────────────────────────────────────────────────────────────

/**
 * 出厂渐变(起色, 止色)。**单一事实源在 `@bilibili-notify/internal`** —— 默认皮肤的外框
 * CSS 就是用它画的,这里只是给模板路径(基准快照)的 props 取值用。
 *
 * 用户配置里的 `cardColorStart` / `cardColorEnd` 已退役(ADR-0014 决策 15 的 🔗):
 * 出图的渐变来自皮肤的外框 CSS,渲染器不再从 config 读颜色。
 */
export { DEFAULT_CARD_GRADIENT } from "@bilibili-notify/internal";

export const BG_COLORS: Record<GuardLevel, [string, string]> = {
	[GuardLevel.None]: ["#4ebcec", "#F9CCDF"],
	[GuardLevel.Captain]: ["#4ebcec", "#b494e5"],
	[GuardLevel.Admiral]: ["#d8a0e6", "#b494e5"],
	[GuardLevel.Governor]: ["#f2a053", "#ef5f5f"],
};

export const SC_LEVELS = {
	Level1: { battery: 300, duration: "60秒", price: 30 },
	Level2: { battery: 500, duration: "2分钟", price: 50 },
	Level3: { battery: 1000, duration: "5分钟", price: 100 },
	Level4: { battery: 5000, duration: "30分钟", price: 500 },
	Level5: { battery: 10000, duration: "1小时", price: 1000 },
	Level6: { battery: 20000, duration: "2小时", price: 2000 },
} as const;

export const SC_COLORS = [
	["#a8e6cf", "#88d8b0"], // Level1 清新绿
	["#74b9ff", "#0984e3"], // Level2 天空蓝
	["#a29bfe", "#6c5ce7"], // Level3 梦幻紫
	["#fd79a8", "#e84393"], // Level4 热情粉
	["#fdcb6e", "#e17055"], // Level5 荣耀金
	["#ff7675", "#d63031"], // Level6 传说红
] as const;

export function getSCLevel(battery: number): number {
	if (battery >= 20000) return 5;
	if (battery >= 10000) return 4;
	if (battery >= 5000) return 3;
	if (battery >= 1000) return 2;
	if (battery >= 500) return 1;
	return 0;
}
