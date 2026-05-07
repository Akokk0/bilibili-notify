/**
 * GlassBox — heavier alternative to GlassPanel from .bn-design's
 * variation-ac-plugins.jsx. Used by Rules / Cards / AI pages where each
 * sub-section has an icon chip + accent color + optional badge + right
 * actions slot.
 */

import type { CSSProperties, ReactNode } from "react";
import { Pill } from "./atoms";

export interface GlassBoxProps {
	title: ReactNode;
	subtitle?: ReactNode;
	accent?: string;
	icon?: ReactNode;
	badge?: ReactNode;
	right?: ReactNode;
	dense?: boolean;
	children: ReactNode;
	className?: string;
}

export function GlassBox({
	title,
	subtitle,
	accent = "#FB7299",
	icon,
	badge,
	right,
	dense,
	children,
	className,
}: GlassBoxProps) {
	const accentRadial: CSSProperties = {
		background: `radial-gradient(circle at top right, ${accent}1f, transparent 70%)`,
	};
	const iconChip: CSSProperties = {
		background: `linear-gradient(135deg, ${accent}, ${accent}cc)`,
		boxShadow: `0 4px 12px ${accent}55`,
	};
	return (
		<div
			className={`bn-glass relative overflow-hidden rounded-bn-card shadow-bn-card ${className ?? ""}`}
		>
			<div className="pointer-events-none absolute right-0 top-0 h-40 w-40" style={accentRadial} />
			<div className="relative flex items-center gap-3 border-b border-black/5 px-[18px] pb-3 pt-3.5">
				{icon ? (
					<div
						className="grid h-8 w-8 place-items-center rounded-[9px] text-sm font-bold text-white"
						style={iconChip}
					>
						{icon}
					</div>
				) : null}
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="text-[13.5px] font-bold tracking-tight text-bn-text-primary">
							{title}
						</span>
						{badge ? (
							<Pill color={accent} subtle size="sm">
								{badge}
							</Pill>
						) : null}
					</div>
					{subtitle ? (
						<div className="mt-0.5 text-[11px] text-bn-text-secondary">{subtitle}</div>
					) : null}
				</div>
				{right}
			</div>
			<div className={`relative ${dense ? "px-[18px] pb-3.5 pt-2" : "px-[18px] pb-4 pt-2.5"}`}>
				{children}
			</div>
		</div>
	);
}

export interface CollapseBlockProps {
	label: ReactNode;
	enabled: boolean;
	onToggle: (next: boolean) => void;
	accent?: string;
	children?: ReactNode;
}

export function CollapseBlock({
	label,
	enabled,
	onToggle,
	accent = "#FB7299",
	children,
}: CollapseBlockProps) {
	const style: CSSProperties = enabled
		? { background: `${accent}0a`, borderColor: `${accent}33` }
		: { background: "rgba(0,0,0,0.02)", borderColor: "#ececec" };
	return (
		<div className="mt-2.5 rounded-lg border px-3 py-2.5" style={style}>
			<div className="flex items-center justify-between">
				<span
					className={`text-[12.5px] font-bold ${enabled ? "text-bn-text-primary" : "text-bn-text-secondary"}`}
				>
					{label}
				</span>
				<button
					type="button"
					onClick={() => onToggle(!enabled)}
					className="relative h-4 w-7 cursor-pointer rounded-full transition"
					style={{ background: enabled ? "#FB7299" : "#d8d8d8" }}
					aria-pressed={enabled}
				>
					<span
						className="absolute top-[2px] h-3 w-3 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.2)]"
						style={{ left: enabled ? 12 : 2, transition: "left 0.18s" }}
					/>
				</button>
			</div>
			{enabled ? <div className="mt-2">{children}</div> : null}
		</div>
	);
}
