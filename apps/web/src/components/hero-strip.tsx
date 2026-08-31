/**
 * Hero strip —— 页面顶部那条染色玻璃横幅(角标徽章 + 标题/说明 + 右侧控件)。
 * 收编前 Ai / Cards 两页逐字符抄了同一份,Dashboard 的 AI 洞察条又是它的紧凑版。
 *
 * 住 apps/web 而不是 ui 库:`bn-hero-tint` / `bn-hero-badge` 两个工具类定义在
 * web 的 styles.css,库件背不动它们。
 */

import type { ReactNode } from "react";

export interface HeroStripProps {
	/** 徽章里的图标(尺寸由调用方给:lg 配 26、compact 配 20)。 */
	icon: ReactNode;
	/** 紧凑档(Dashboard 洞察条):p-4 + 40px 徽章;缺省是页级 hero 的 p-5 + 52px。 */
	compact?: boolean;
	/**
	 * 标题行内容(壳子出 `text-bn-md font-bold` 的行样式)+ 下方一行小字。
	 * 自定义中栏(Dashboard 那种单行文案)不传这两个,改传 children。
	 */
	title?: ReactNode;
	subtitle?: ReactNode;
	/** 自定义中栏(与 title/subtitle 二选一)。 */
	children?: ReactNode;
	/** 右侧控件(总开关 Picker / 按钮)。 */
	right?: ReactNode;
}

export function HeroStrip({
	icon,
	compact = false,
	title,
	subtitle,
	children,
	right,
}: HeroStripProps) {
	return (
		<div
			className={`bn-glass bn-hero-tint relative rounded-bn-card shadow-bn-card ${compact ? "p-4" : "p-5"}`}
		>
			<div className="flex items-center gap-3.5">
				<div
					className={`bn-hero-badge grid shrink-0 place-items-center text-bn-on-solid ${
						compact ? "h-10 w-10 rounded-xl" : "h-13 w-13 rounded-2xl"
					}`}
				>
					{icon}
				</div>
				<div className="min-w-0 flex-1">
					{title != null ? (
						<>
							<div className="flex items-center gap-2 text-bn-md font-bold text-bn-text-primary">
								{title}
							</div>
							{subtitle != null ? (
								<div className="mt-1 text-bn-sm text-bn-text-tertiary">{subtitle}</div>
							) : null}
						</>
					) : (
						children
					)}
				</div>
				{right}
			</div>
		</div>
	);
}
