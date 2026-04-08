import { GuardLevel } from "blive-message-listener";

// ── 颜色数据 ──────────────────────────────────────────────────────────────────

export const BG_COLORS: Record<GuardLevel, [string, string]> = {
	[GuardLevel.None]: ["#4ebcec", "#F9CCDF"],
	[GuardLevel.Jianzhang]: ["#4ebcec", "#b494e5"],
	[GuardLevel.Tidu]: ["#d8a0e6", "#b494e5"],
	[GuardLevel.Zongdu]: ["#f2a053", "#ef5f5f"],
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

// ── 共享 CSS 工具 ─────────────────────────────────────────────────────────────

/** CSS reset + 字体设置 */
export function cssReset(font: string): string {
	return `
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            font-family: "${font}", "Microsoft YaHei", "Source Han Sans", "Noto Sans CJK", sans-serif;
        }
    `;
}

/** 渐变背景包装层样式（内联到 .background / .bg 类） */
export function cssGradientBg(colorStart: string, colorEnd: string, padding = "15px"): string {
	return `
        background: linear-gradient(to right bottom, ${colorStart}, ${colorEnd});
        padding: ${padding};
    `;
}

/** 毛玻璃卡片样式 — 应用到内容容器 */
export const CSS_FROSTED_CARD = `
        border-radius: 10px;
        box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.2);
        background-color: rgba(255, 255, 255, 0.75);
        backdrop-filter: blur(10px);
    `;

/** 圆形头像样式 */
export const CSS_AVATAR = `
        border-radius: 50%;
        border: 3px solid white;
        box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.2);
    `;
