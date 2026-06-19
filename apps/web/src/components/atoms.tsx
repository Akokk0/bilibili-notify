/**
 * Atoms — Tailwind/JSX ports of `.bn-design/shared.jsx`. Inline-style escapes
 * are kept where Tailwind utilities can't take dynamic hex (per-UP color rings,
 * gradients keyed off props, stat colors).
 *
 * Source-of-truth: shared.jsx — when a design tweak lands there, mirror here.
 */

import type { CSSProperties, MouseEventHandler, ReactNode, SVGProps } from "react";
import { Icon, type IconName } from "./icons";

// ── Avatar ──────────────────────────────────────────────────────────────────

export interface AvatarProps {
	name: string;
	color: string;
	size?: number;
	ring?: boolean;
	status?: "live" | "living" | "off";
	/** Real avatar URL — if provided renders <img> instead of the initial-letter fallback. */
	url?: string;
}

export function Avatar({ name, color, size = 44, ring = false, status, url }: AvatarProps) {
	const inner: CSSProperties = {
		width: size,
		height: size,
		background: url ? "white" : `linear-gradient(135deg, ${color}, ${color}dd)`,
		fontSize: Math.round(size * 0.4),
		border: ring ? "3px solid white" : "2px solid white",
	};
	return (
		<div className="relative shrink-0" style={{ width: size, height: size }}>
			<div
				className="flex items-center justify-center overflow-hidden rounded-full font-bold text-white shadow-bn-card"
				style={inner}
			>
				{url ? (
					<img
						src={url}
						alt={name}
						className="h-full w-full object-cover"
						referrerPolicy="no-referrer"
					/>
				) : (
					(name?.[0] ?? "?")
				)}
			</div>
			{status === "live" ? (
				<span
					className="absolute -bottom-0.5 -right-0.5 rounded-md border-2 border-white bg-bn-pink px-1 text-[9px] font-bold tracking-wider text-white"
					style={{ lineHeight: 1 }}
				>
					LIVE
				</span>
			) : null}
			{status === "living" ? (
				<span className="bn-anim-pulse absolute -bottom-1 -right-1 h-3.5 w-3.5 rounded-full border-2 border-white bg-bn-pink" />
			) : null}
		</div>
	);
}

// ── Btn ─────────────────────────────────────────────────────────────────────

type BtnVariant = "primary" | "ghost" | "outline" | "danger" | "blue";
type BtnSize = "sm" | "md" | "lg";

export interface BtnProps {
	children?: ReactNode;
	onClick?: MouseEventHandler<HTMLButtonElement>;
	variant?: BtnVariant;
	size?: BtnSize;
	icon?: ReactNode;
	full?: boolean;
	disabled?: boolean;
	type?: "button" | "submit";
	title?: string;
	/** 下拉/弹层触发器的无障碍标注:透传到底层 <button>。 */
	ariaHasPopup?: boolean;
	ariaExpanded?: boolean;
}

const VARIANT_CLS: Record<BtnVariant, string> = {
	primary: "bg-bn-pink text-white border-transparent hover:opacity-90",
	blue: "bg-bn-blue text-white border-transparent hover:opacity-90",
	ghost: "bg-transparent text-bn-text-tertiary border-transparent hover:bg-bn-hover-muted",
	outline: "bg-bn-surface text-bn-text-primary border-bn-border hover:bg-bn-surface-muted",
	danger: "bg-transparent text-red-500 border-transparent hover:bg-red-500/10",
};

const SIZE_CLS: Record<BtnSize, string> = {
	sm: "h-[26px] px-2.5 text-xs",
	md: "h-[30px] px-3.5 text-[13px]",
	lg: "h-9 px-4 text-sm",
};

export function Btn({
	children,
	onClick,
	variant = "primary",
	size = "md",
	icon,
	full = false,
	disabled = false,
	type = "button",
	title,
	ariaHasPopup,
	ariaExpanded,
}: BtnProps) {
	return (
		<button
			type={type}
			onClick={onClick}
			disabled={disabled}
			title={title}
			aria-haspopup={ariaHasPopup}
			aria-expanded={ariaExpanded}
			className={`inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-bold transition disabled:cursor-not-allowed disabled:opacity-50 ${SIZE_CLS[size]} ${VARIANT_CLS[variant]} ${full ? "w-full" : "w-auto"}`}
		>
			{icon ? <span className="inline-flex shrink-0">{icon}</span> : null}
			{children}
		</button>
	);
}

// ── Pill ────────────────────────────────────────────────────────────────────

export interface PillProps {
	children: ReactNode;
	color?: string;
	subtle?: boolean;
	size?: "sm" | "md";
	className?: string;
}

export function Pill({
	children,
	color = "#FB7299",
	subtle = false,
	size = "md",
	className,
}: PillProps) {
	const sizeCls =
		size === "sm" ? "text-[10px] px-1.5 leading-4" : "text-[11px] px-2 leading-[18px]";
	const style: CSSProperties = subtle
		? { background: `${color}1f`, color }
		: { background: color, color: "white" };
	return (
		<span
			className={`inline-flex items-center gap-1 whitespace-nowrap rounded font-bold tracking-wide ${sizeCls} ${className ?? ""}`}
			style={style}
		>
			{children}
		</span>
	);
}

// ── StatusDot ───────────────────────────────────────────────────────────────

export type StatusDotKind = "live" | "living" | "off" | "ok" | "warn" | "err" | "pending";

const STATUS_COLORS: Record<StatusDotKind, string> = {
	live: "#FF6699",
	living: "#FF6699",
	off: "#cccccc",
	ok: "#22c55e",
	warn: "#f59e0b",
	err: "#ef4444",
	pending: "#94a3b8",
};

export function StatusDot({ kind }: { kind: StatusDotKind }) {
	const blink = kind === "live" || kind === "living";
	const style: CSSProperties = {
		background: STATUS_COLORS[kind],
		boxShadow: blink ? "0 0 0 3px rgba(255,102,153,0.18)" : undefined,
	};
	return (
		<span
			className={`inline-block h-2 w-2 shrink-0 rounded-full ${blink ? "bn-anim-pulse" : ""}`}
			style={style}
		/>
	);
}

// ── Toggle ──────────────────────────────────────────────────────────────────

export interface ToggleProps {
	value: boolean;
	onChange: (next: boolean) => void;
	size?: "sm" | "md";
	disabled?: boolean;
}

export function Toggle({ value, onChange, size = "md", disabled }: ToggleProps) {
	const sz = size === "sm" ? { w: 28, h: 16, dot: 12 } : { w: 36, h: 20, dot: 16 };
	const trackStyle: CSSProperties = {
		width: sz.w,
		height: sz.h,
		borderRadius: sz.h / 2,
		background: value ? "#FB7299" : "#d8d8d8",
	};
	const dotStyle: CSSProperties = {
		width: sz.dot,
		height: sz.dot,
		left: value ? sz.w - sz.dot - 2 : 2,
		top: 2,
		transition: "left 0.18s",
	};
	return (
		<button
			type="button"
			onClick={(e) => {
				e.stopPropagation();
				if (!disabled) onChange(!value);
			}}
			disabled={disabled}
			className="relative shrink-0 cursor-pointer border-none transition disabled:opacity-50"
			style={trackStyle}
		>
			<span
				className="absolute rounded-full bg-bn-surface shadow-[0_1px_3px_rgba(0,0,0,0.2)]"
				style={dotStyle}
			/>
		</button>
	);
}

// ── Input ──────────────────────────────────────────────────────────────────

export interface InputProps {
	value: string;
	onChange: (next: string) => void;
	placeholder?: string;
	icon?: ReactNode;
	size?: "sm" | "md";
	full?: boolean;
	type?: string;
}

export function Input({
	value,
	onChange,
	placeholder,
	icon,
	size = "md",
	full = false,
	type = "text",
}: InputProps) {
	const sz = size === "sm" ? "h-7 text-xs" : "h-8 text-[13px]";
	return (
		<div
			className={`inline-flex items-center gap-1.5 rounded-md border border-bn-border bg-bn-field px-2.5 ${sz} ${full ? "w-full flex-1" : "w-auto"}`}
		>
			{icon ? (
				<span className="inline-flex h-3.5 w-3.5 shrink-0 text-bn-text-secondary">{icon}</span>
			) : null}
			<input
				type={type}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				className="min-w-0 flex-1 border-0 bg-transparent text-bn-text-primary outline-none placeholder:text-bn-text-secondary"
			/>
		</div>
	);
}

// ── PlatformIcon ────────────────────────────────────────────────────────────

const PLATFORM_META: Record<string, { color: string; label: string; icon?: IconName }> = {
	onebot: { color: "#3b82f6", label: "OneBot", icon: "qq" },
	"qq-official": { color: "#14b8a6", label: "QQ官方", icon: "qq" },
	webhook: { color: "#22c55e", label: "Webhook" },
	"web-dashboard": { color: "#a29bfe", label: "Dashboard" },
};

export function PlatformIcon({ platform, size = 16 }: { platform: string; size?: number }) {
	const meta = PLATFORM_META[platform];
	const color = meta?.color ?? "#888";
	const I = meta?.icon ? Icon[meta.icon] : null;
	if (I) return <I size={size} style={{ color }} />;
	const label = meta?.label ?? platform;
	const badgeStyle: CSSProperties & SVGProps<SVGSVGElement> = {
		width: size,
		height: size,
		borderRadius: size * 0.22,
		background: color,
		fontSize: size * 0.52,
	};
	return (
		<span
			className="inline-flex shrink-0 items-center justify-center font-extrabold tracking-tighter text-white"
			style={badgeStyle}
		>
			{label[0]}
		</span>
	);
}

export function platformLabel(platform: string): string {
	return PLATFORM_META[platform]?.label ?? platform;
}

// ── StatsBar (mini bar chart) ──────────────────────────────────────────────

export interface StatsBarDatum {
	d: string;
	live: number;
	dyn: number;
	sc: number;
	guard: number;
}

export function StatsBar({ data, height = 80 }: { data: StatsBarDatum[]; height?: number }) {
	const max = Math.max(1, ...data.map((d) => d.live + d.dyn + d.sc + d.guard));
	return (
		<div className="relative flex items-end gap-2.5 pb-4.5" style={{ height }}>
			{data.map((d) => {
				const total = d.live + d.dyn + d.sc + d.guard;
				const h = (total / max) * (height - 18);
				return (
					<div key={d.d} className="relative flex flex-1 flex-col items-center gap-1">
						<div
							className="flex w-full flex-col justify-end overflow-hidden rounded-t"
							style={{ height: h }}
						>
							{d.guard > 0 ? (
								<div style={{ background: "#f2a053", height: `${(d.guard / total) * 100}%` }} />
							) : null}
							{d.sc > 0 ? (
								<div style={{ background: "#fdcb6e", height: `${(d.sc / total) * 100}%` }} />
							) : null}
							{d.dyn > 0 ? (
								<div style={{ background: "#00AEEC", height: `${(d.dyn / total) * 100}%` }} />
							) : null}
							{d.live > 0 ? (
								<div style={{ background: "#FB7299", height: `${(d.live / total) * 100}%` }} />
							) : null}
						</div>
						<div className="absolute bottom-0 text-[10px] text-bn-text-secondary">{d.d}</div>
					</div>
				);
			})}
		</div>
	);
}

// ── Donut ──────────────────────────────────────────────────────────────────

export interface DonutProps {
	value: number;
	size?: number;
	color?: string;
	track?: string;
	stroke?: number;
	label?: ReactNode;
}

export function Donut({
	value,
	size = 64,
	color = "#FB7299",
	track = "#f0f0f0",
	stroke = 8,
	label,
}: DonutProps) {
	const r = (size - stroke) / 2;
	const c = 2 * Math.PI * r;
	return (
		<div className="relative shrink-0" style={{ width: size, height: size }}>
			<svg width={size} height={size} aria-hidden="true" focusable="false">
				<circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
				<circle
					cx={size / 2}
					cy={size / 2}
					r={r}
					fill="none"
					stroke={color}
					strokeWidth={stroke}
					strokeDasharray={`${c * value} ${c}`}
					strokeLinecap="round"
					transform={`rotate(-90 ${size / 2} ${size / 2})`}
				/>
			</svg>
			<div className="absolute inset-0 flex flex-col items-center justify-center text-[11px] font-bold leading-tight text-bn-text-primary">
				{label ?? `${Math.round(value * 100)}%`}
			</div>
		</div>
	);
}

// ── Section / Row (used by drawer + dashboard panels) ─────────────────────

export function Section({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div>
			<div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-bn-text-secondary">
				{label}
			</div>
			<div className="rounded-lg border border-bn-border bg-bn-surface-muted/80">{children}</div>
		</div>
	);
}

export function Row({
	label,
	sub,
	icon,
	children,
}: {
	label: string;
	sub?: string;
	icon?: ReactNode;
	children?: ReactNode;
}) {
	return (
		<div className="flex items-center gap-2.5 border-b border-bn-border-subtle px-3 py-2.5 last:border-b-0">
			{icon ? <span className="shrink-0">{icon}</span> : null}
			<div className="min-w-0 flex-1">
				<div className="text-[12.5px] font-semibold text-bn-text-primary">{label}</div>
				{sub ? <div className="mt-0.5 text-[11px] text-bn-text-secondary">{sub}</div> : null}
			</div>
			{children}
		</div>
	);
}
