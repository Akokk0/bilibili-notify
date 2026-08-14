/**
 * Glass UI atoms — Tailwind ports of `.bn-design`'s frosted-glass primitives.
 * Inline styles in the design source are translated to utility classes; brand
 * colors live as CSS custom properties exposed via @theme in styles.css, so
 * `bg-bn-pink` / `text-bn-pink` etc. resolve to the canonical palette.
 */

import type { CSSProperties, ReactNode } from "react";

export interface GlassPanelProps {
	title?: ReactNode;
	subtitle?: ReactNode;
	right?: ReactNode;
	/**
	 * 主题色。**必须是十六进制字面量**(如 `#FB7299`)—— 下面要拼 alpha 后缀
	 * 构造渐变,传 `var(--color-bn-*)` 会拼出 `var(...)1f` 这种非法值,整条
	 * background 声明会被浏览器静默丢弃。
	 */
	accent?: string;
	/** 标题左侧的图标,会被放进一枚 accent 渐变圆角方块里。 */
	icon?: ReactNode;
	children: ReactNode;
	className?: string;
}

export function GlassPanel({
	title,
	subtitle,
	right,
	accent,
	icon,
	children,
	className,
}: GlassPanelProps) {
	const accentStyle: CSSProperties | undefined = accent
		? { background: `radial-gradient(circle at top right, ${accent}1f, transparent 70%)` }
		: undefined;
	return (
		// flex-col + 下面 body 的 flex-1:让面板正文吃满卡片高度。栅格里的卡片会被
		// 拉到与最高的兄弟等高,若正文只按内容高度排,矮内容(如热力图)下方就留一大片空白。
		// 有了它,正文里的 `h-full` 才真正生效。
		<div
			className={`bn-glass relative flex flex-col overflow-hidden rounded-bn-card p-4 shadow-bn-card ${className ?? ""}`}
		>
			{accent ? (
				<div className="pointer-events-none absolute right-0 top-0 h-24 w-24" style={accentStyle} />
			) : null}
			{title || subtitle || right ? (
				<div className="relative mb-3 flex items-center gap-2.5">
					{icon && accent ? (
						<div
							className="flex h-7.5 w-7.5 shrink-0 items-center justify-center rounded-bn-card text-white"
							style={{
								background: `linear-gradient(135deg, ${accent}, ${accent}cc)`,
								boxShadow: `0 4px 12px ${accent}55`,
							}}
						>
							{icon}
						</div>
					) : null}
					<div className="min-w-0 flex-1">
						{title ? <div className="text-sm font-bold text-bn-text-primary">{title}</div> : null}
						{subtitle ? (
							<div className="mt-0.5 text-xs text-bn-text-secondary">{subtitle}</div>
						) : null}
					</div>
					{right}
				</div>
			) : null}
			<div className="relative min-h-0 flex-1">{children}</div>
		</div>
	);
}

interface PulseDotProps {
	color?: string;
	className?: string;
}

function PulseDot({ color = "currentColor", className }: PulseDotProps) {
	return (
		<span
			className={`bn-anim-pulse inline-block h-1.5 w-1.5 rounded-full ${className ?? ""}`}
			style={{ background: color }}
		/>
	);
}

export interface GlassStatCardProps {
	label: string;
	value: ReactNode;
	suffix?: ReactNode;
	/**
	 * 主题色。**必须是十六进制字面量** —— 同 {@link GlassPanelProps.accent},
	 * 这里要拼 `${color}1f` / `${color}33` 造染色层与描边。
	 */
	color: string;
	pulse?: boolean;
	/** 卡片底部的补充行(如涨跌幅 + 迷你走势),留给调用方自由组合。 */
	footer?: ReactNode;
}

export function GlassStatCard({ label, value, suffix, color, pulse, footer }: GlassStatCardProps) {
	// 染色渐变叠在完整玻璃底(--bn-glass-bg)之上,而不是渐变「渐到」玻璃底 ——
	// 后者会让渐变起点侧几乎全透明,花壁纸(皮肤)一透进来数字就没法读了。
	// blur / 边框宽度交给 .bn-glass(随皮肤变量),这里只覆盖染色与描边色。
	const bg: CSSProperties = {
		background: `linear-gradient(135deg, ${color}1f, ${color}0a), var(--bn-glass-bg)`,
		borderColor: `${color}33`,
	};
	return (
		<div className="bn-glass relative overflow-hidden rounded-bn-card px-4 py-3.5" style={bg}>
			<div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-bn-text-tertiary">
				{pulse ? <PulseDot color={color} /> : null}
				{label}
			</div>
			<div className="flex items-baseline gap-1">
				<span
					className="font-mono text-3xl font-bold leading-none tracking-tight"
					style={{ color }}
				>
					{value}
				</span>
				{suffix ? <span className="text-xs text-bn-text-secondary">{suffix}</span> : null}
			</div>
			{footer ? <div className="mt-2 flex items-center gap-1.5">{footer}</div> : null}
		</div>
	);
}
