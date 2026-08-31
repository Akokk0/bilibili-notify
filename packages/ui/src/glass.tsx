/**
 * Glass UI atoms — Tailwind ports of `.bn-design`'s frosted-glass primitives.
 * Inline styles in the design source are translated to utility classes; brand
 * colors live as CSS custom properties exposed via @theme in styles.css, so
 * `bg-bn-pink` / `text-bn-pink` etc. resolve to the canonical palette.
 */

import type { CSSProperties, ReactNode } from "react";

import { accentChip, accentRadial } from "./accent-surface";
import { Spinner } from "./atoms";

export interface GlassPanelProps {
	title?: ReactNode;
	subtitle?: ReactNode;
	right?: ReactNode;
	/**
	 * 主题色。十六进制字面量与 `var(--color-bn-*)` 都收 —— 下面用
	 * `color-mix()` 造透明度,不再拼 alpha 后缀。
	 *
	 * (曾经这里写着「**必须是十六进制字面量**」,因为实现是 `${accent}1f` 拼字符串,
	 * 传 var() 会拼出 `var(...)1f` 这种非法值、整条声明被浏览器静默丢弃。那条限制
	 * 在项目全面用上 color-mix 之后就过期了,只是没人回来改 —— 代价是所有带色件
	 * 都被钉死在写死的十六进制上,皮肤换了主强调色也搬不动。)
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
	const accentStyle: CSSProperties | undefined = accent ? accentRadial(accent) : undefined;
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
							className="flex h-7.5 w-7.5 shrink-0 items-center justify-center rounded-bn-card text-bn-on-solid"
							style={accentChip(accent)}
						>
							{icon}
						</div>
					) : null}
					<div className="min-w-0 flex-1">
						{title ? (
							<div className="text-bn-base font-bold text-bn-text-primary">{title}</div>
						) : null}
						{subtitle ? (
							<div className="mt-0.5 text-bn-sm text-bn-text-secondary">{subtitle}</div>
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
	/** 主题色。同 {@link GlassPanelProps.accent} —— hex 与 var() 都收。 */
	color: string;
	pulse?: boolean;
	/** 卡片底部的补充行(如涨跌幅 + 迷你走势),留给调用方自由组合。 */
	footer?: ReactNode;
}

export function GlassStatCard({ label, value, suffix, color, pulse, footer }: GlassStatCardProps) {
	// 染色渐变叠在完整玻璃底(--bn-glass-bg)之上,而不是渐变「渐到」玻璃底 ——
	// 后者会让渐变起点侧几乎全透明,花壁纸(皮肤)一透进来数字就没法读了。
	// blur 交给 .bn-glass(随皮肤变量),这里只覆盖染色。
	const bg: CSSProperties = {
		background: `linear-gradient(135deg, color-mix(in srgb, ${color} 12%, transparent), color-mix(in srgb, ${color} 4%, transparent)), var(--bn-glass-bg)`,
	};
	return (
		<div
			className="bn-glass relative overflow-hidden rounded-bn-card px-4 py-3.5 shadow-bn-card"
			style={bg}
		>
			<div className="mb-1.5 flex items-center gap-1.5 text-bn-sm font-semibold text-bn-text-tertiary">
				{pulse ? <PulseDot color={color} /> : null}
				{label}
			</div>
			<div className="flex items-baseline gap-1">
				<span
					// `tabular-nums` 而不是 `font-mono`:要的一直是**数字等宽**(几张卡并排,
					// 位数一变宽度就跳),而不是等宽**字体**。写成 font-mono 的代价是这些数字
					// 吃 `--font-mono` —— 那一档不在皮肤词表里,于是装了自带字体的皮肤只换掉
					// 周围的字,数字还是系统等宽体,一张卡上两种字体(2026-08-25 主人真机指出)。
					// 换成字形特性之后字体走 `--font-cjk`(皮肤唯一的字体入口),对齐照旧。
					className="text-bn-hero font-bold leading-none tracking-tight tabular-nums"
					style={{ color }}
				>
					{value}
				</span>
				{suffix ? <span className="text-bn-sm text-bn-text-secondary">{suffix}</span> : null}
			</div>
			{footer ? <div className="mt-2 flex items-center gap-1.5">{footer}</div> : null}
		</div>
	);
}

export interface LoadingBlockProps {
	/** 主提示语,如「正在读取统计数据」。别自带省略号,组件统一补。 */
	label: ReactNode;
	/** 第二行小字(女仆碎碎念 / 在做什么);不给就不渲染,不留空行。 */
	hint?: ReactNode;
	/**
	 * `card`(默认)=自带玻璃底,给直接坐在页面背景上的等待态。
	 * `inset`=只有转圈与文案,给**已经在别人卡里**的位置 —— 再套一层玻璃就是
	 * 玻璃叠玻璃,那个观感被否过。
	 */
	variant?: "card" | "inset";
	className?: string;
}

/**
 * 等待占位卡 —— 「正在读取…」这类整页/整段等待态的唯一写法。
 *
 * 由来:数据统计与推送历史原本各写一行裸文字直接坐在页面背景上,没有任何包装。
 * 页级容器一律玻璃底(见 README),等待态也是页级容器,凭什么例外 —— 皮肤壁纸
 * 一开,那行灰字就是飘在图上的。
 *
 * `role="status"` 是给读屏器的:转圈动画纯视觉,不念出来的话等待态等于不存在。
 * `aria-busy` 让它明确是「正在忙」,而不是一条静态提示。
 */
export function LoadingBlock({ label, hint, variant = "card", className }: LoadingBlockProps) {
	const shell =
		variant === "card" ? "bn-glass rounded-bn-card px-6 py-14 shadow-bn-card" : "px-6 py-10";
	return (
		<div
			role="status"
			aria-busy="true"
			className={`flex flex-col items-center justify-center gap-3 text-center ${shell} ${className ?? ""}`}
		>
			<Spinner size={30} thickness={3} />
			<div className="text-bn-base font-bold text-bn-text-secondary">{label}…</div>
			{hint ? <div className="text-bn-xs text-bn-text-tertiary">{hint}</div> : null}
		</div>
	);
}
