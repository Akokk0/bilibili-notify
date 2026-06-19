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
	accent?: string;
	children: ReactNode;
	className?: string;
}

export function GlassPanel({
	title,
	subtitle,
	right,
	accent,
	children,
	className,
}: GlassPanelProps) {
	const accentStyle: CSSProperties | undefined = accent
		? { background: `radial-gradient(circle at top right, ${accent}1f, transparent 70%)` }
		: undefined;
	return (
		<div
			className={`bn-glass relative overflow-hidden rounded-bn-card p-4 shadow-bn-card ${className ?? ""}`}
		>
			{accent ? (
				<div className="pointer-events-none absolute right-0 top-0 h-24 w-24" style={accentStyle} />
			) : null}
			{title || subtitle || right ? (
				<div className="relative mb-3 flex items-center justify-between">
					<div>
						{title ? <div className="text-sm font-bold text-bn-text-primary">{title}</div> : null}
						{subtitle ? (
							<div className="mt-0.5 text-xs text-bn-text-secondary">{subtitle}</div>
						) : null}
					</div>
					{right}
				</div>
			) : null}
			<div className="relative">{children}</div>
		</div>
	);
}

export interface PillProps {
	children: ReactNode;
	color?: "pink" | "blue" | "green" | "amber" | "red" | "gray";
	subtle?: boolean;
	className?: string;
}

export function Pill({ children, color = "gray", subtle = false, className }: PillProps) {
	const palette: Record<NonNullable<PillProps["color"]>, [string, string]> = {
		pink: ["bg-bn-pink/15 text-bn-pink", "bg-bn-pink text-white"],
		blue: ["bg-bn-blue/15 text-bn-blue", "bg-bn-blue text-white"],
		green: ["bg-bn-success-soft text-bn-success-text", "bg-emerald-500 text-white"],
		amber: ["bg-amber-500/15 text-amber-500", "bg-amber-500 text-white"],
		red: ["bg-bn-danger-soft text-bn-danger-text", "bg-red-500 text-white"],
		gray: ["bg-bn-surface-muted text-bn-text-tertiary", "bg-bn-text-tertiary text-white"],
	};
	const cls = palette[color][subtle ? 0 : 1];
	return (
		<span
			className={`inline-flex items-center gap-1.5 rounded-bn-pill px-2 py-0.5 text-xs font-semibold ${cls} ${className ?? ""}`}
		>
			{children}
		</span>
	);
}

export interface PulseDotProps {
	color?: string;
	className?: string;
}

export function PulseDot({ color = "currentColor", className }: PulseDotProps) {
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
	color: string;
	pulse?: boolean;
}

export function GlassStatCard({ label, value, suffix, color, pulse }: GlassStatCardProps) {
	const bg: CSSProperties = {
		background: `linear-gradient(135deg, ${color}1a, var(--bn-glass-bg))`,
		border: `1px solid ${color}33`,
	};
	return (
		<div
			className="relative overflow-hidden rounded-bn-card px-4 py-3.5 backdrop-blur-md"
			style={bg}
		>
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
		</div>
	);
}

export interface ServiceStatusPillProps {
	online: boolean;
	label: string;
}

export function ServiceStatusPill({ online, label }: ServiceStatusPillProps) {
	return (
		<span
			className={`inline-flex items-center gap-1.5 rounded-bn-pill px-2.5 py-1 text-xs font-semibold ${
				online ? "bg-bn-success-soft text-bn-success-text" : "bg-bn-danger-soft text-bn-danger-text"
			}`}
		>
			<PulseDot color={online ? "#22c55e" : "#ef4444"} />
			{label}
		</span>
	);
}
