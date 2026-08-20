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
		background: url
			? "var(--color-bn-surface)"
			: `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 87%, transparent))`,
		fontSize: Math.round(size * 0.4),
		border: ring ? "3px solid var(--color-bn-surface)" : "2px solid var(--color-bn-surface)",
	};
	return (
		<div className="relative shrink-0" style={{ width: size, height: size }}>
			{/* 皮肤挂点在圆形元素上:hook 语义是「圆头像」,border/box-shadow 必须跟圆走,
			    挂外层方形定位容器会画出方框(踩过)。 */}
			<div
				data-bn="avatar"
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
	danger: "bg-transparent text-bn-danger border-transparent hover:bg-bn-danger/10",
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
			data-bn={variant === "primary" ? "btn btn-primary" : "btn"}
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
	color = "var(--color-bn-pink)",
	subtle = false,
	size = "md",
	className,
}: PillProps) {
	const sizeCls =
		size === "sm" ? "text-[10px] px-1.5 leading-4" : "text-[11px] px-2 leading-[18px]";
	const style: CSSProperties = subtle
		? { background: `color-mix(in srgb, ${color} 12%, transparent)`, color }
		: { background: color, color: "white" };
	return (
		<span
			className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm font-bold tracking-wide ${sizeCls} ${className ?? ""}`}
			style={style}
		>
			{children}
		</span>
	);
}

// ── ToneChip ────────────────────────────────────────────────────────────────

export interface ToneChipProps {
	children: React.ReactNode;
	/**
	 * 选中态的语义色。收十六进制**或** `var(--color-bn-*)` —— 透明度用 `color-mix()`
	 * 现调,不走 `${tone}1f` 那种十六进制 alpha 后缀(后缀只对 6 位 hex 生效,
	 * 传 var() 会静默变成一条废样式)。
	 *
	 * 只在 `active` 时用得上,所以可选:没有开关态的纯操作钮不必填一个用不上的颜色。
	 */
	tone?: string;
	/** 选中 / 开启。缺省 false = 中性描边态。 */
	active?: boolean;
	onClick?: () => void;
	disabled?: boolean;
	/** 内容按大写渲染(日志等级那排要,类型筛选不要)。 */
	uppercase?: boolean;
	className?: string;
	title?: string;
}

/**
 * 「一排里选一个 / 开一个」的可点胶囊 —— 选中时按 `tone` 染色(底 12% / 字实色 /
 * 边 33%),未选中时退回中性描边。
 *
 * 与 {@link Pill} 的分工:Pill 是不可点的徽章(`<span>`,无描边),这个是按钮
 * (`<button>`,挂 `data-bn="btn"` 跟着换肤走造型)。**别拿 Pill 套 onClick** ——
 * 徽章语义混进按钮语义,挂点也就无处可挂了。
 *
 * `tone` 是**内容语义色**(error 红 / 直播粉 / 暂停橙),刻意不跟主强调色换肤:
 * 换个皮肤不该把「error」染成别的颜色。皮肤能改的是造型那一半(圆角、描边样式、
 * 阴影、字重),那半走 `btn` 挂点。
 */
export function ToneChip({
	children,
	tone = "var(--color-bn-pink)",
	active = false,
	onClick,
	disabled,
	uppercase,
	className,
	title,
}: ToneChipProps) {
	// active 态的三色由 `tone` 现算,只能落 inline;未选中态是静态的,走 class ——
	// inline 没有 `:hover`,写进去这颗胶囊就永远没有悬停反馈。
	const style: CSSProperties | undefined = active
		? {
				background: `color-mix(in srgb, ${tone} 12%, transparent)`,
				color: tone,
				borderColor: `color-mix(in srgb, ${tone} 33%, transparent)`,
			}
		: undefined;
	const toneCls = active
		? ""
		: " bg-transparent text-bn-text-tertiary border-bn-border hover:text-bn-text-primary";
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			title={title}
			data-bn="btn"
			className={`inline-flex items-center gap-1 rounded-bn-pill border px-3 py-1 text-[12px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50${toneCls}${uppercase ? " uppercase" : ""}${className ? ` ${className}` : ""}`}
			style={style}
		>
			{children}
		</button>
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
	/**
	 * 给读屏器的名字。不传时这颗开关念出来就是「一个按钮」—— 旁边有文字说明的
	 * 场合还能靠上下文猜,单独摆着的就完全不知道它管什么。
	 */
	ariaLabel?: string;
}

export function Toggle({ value, onChange, size = "md", disabled, ariaLabel }: ToggleProps) {
	const sz = size === "sm" ? { w: 28, h: 16, dot: 12 } : { w: 36, h: 20, dot: 16 };
	const trackStyle: CSSProperties = {
		width: sz.w,
		height: sz.h,
		// 走 token 而不是字面值 —— `--color-bn-pink` 正是皮肤 `colors.accent` 的落点。
		// 写死 #FB7299 的后果是全站每一颗开关的「开」都还是 B 站粉,皮肤换了主强调色
		// 也搬不动。inline style 里放 var() 完全合法,照样跟着换肤走。
		//
		// 关闭态同理走 `textDisabled`(默认装 #d1d5db,与从前写死的 #d8d8d8 几乎同色)
		// —— 语义正好是「这一档是关着的」,而每套皮肤都配了它。**不能挂 `btn` 挂点**:
		// 皮肤给按钮写的实底会盖掉轨道背景,开关的开/关当场就看不出来了。
		background: value ? "var(--color-bn-pink)" : "var(--color-bn-text-disabled)",
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
			aria-label={ariaLabel}
			aria-pressed={ariaLabel ? value : undefined}
			// 禁用态除了淡下去,指针也得跟着变 —— 只淡不换指针的话,鼠标一悬停
			// 仍是「可点」的手型,点下去却毫无反应,像坏了而不像被禁用。
			// 圆角走 class 上的 pill 轴,**不能写进 style** —— inline 压过一切 author
			// 样式,皮肤把 radius.pill 调到 0 求一身硬直角也掰不直这一颗。
			className="relative shrink-0 cursor-pointer rounded-bn-pill border-none transition disabled:cursor-not-allowed disabled:opacity-50"
			style={trackStyle}
		>
			<span
				// 滑块跟着轨道走:只掰直轨道的话,方轨道里滚着个圆球。
				className="absolute rounded-bn-pill bg-bn-surface shadow-[0_1px_3px_rgba(0,0,0,0.2)]"
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
			data-bn="input"
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

// ── Spinner ────────────────────────────────────────────────────────────────

export interface SpinnerProps {
	/** 直径(px)。 */
	size?: number;
	/** 环粗(px)。 */
	thickness?: number;
	className?: string;
}

/** 品牌色圆环加载指示:淡粉底环 + 粉色顶弧旋转。 */
export function Spinner({ size = 32, thickness = 2, className }: SpinnerProps) {
	return (
		<div
			className={`bn-anim-spin rounded-full border-solid border-bn-pink/30 border-t-bn-pink ${className ?? ""}`}
			style={{ width: size, height: size, borderWidth: thickness }}
		/>
	);
}

// ── CheckRow ────────────────────────────────────────────────────────────────

export interface CheckRowProps {
	checked: boolean;
	onChange: (next: boolean) => void;
	children: ReactNode;
}

/** 多选列表的选项行:粉色勾选方块 + 文本,checkbox 本体 sr-only。 */
export function CheckRow({ checked, onChange, children }: CheckRowProps) {
	return (
		<label
			className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-2 text-[13px] transition ${
				checked
					? "border-bn-pink/60 bg-bn-pink/10 font-semibold text-bn-text-primary"
					: "border-bn-border bg-bn-surface text-bn-text-secondary hover:border-bn-pink/40 hover:bg-bn-surface-muted"
			}`}
		>
			<input
				type="checkbox"
				checked={checked}
				onChange={() => onChange(!checked)}
				className="sr-only"
			/>
			<span
				className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border transition ${
					checked ? "border-bn-pink bg-bn-pink text-white" : "border-bn-border bg-bn-surface"
				}`}
			>
				{checked ? <Icon.check size={11} /> : null}
			</span>
			<span className="truncate">{children}</span>
		</label>
	);
}

// ── ErrorNote ───────────────────────────────────────────────────────────────

/**
 * 错误/失败提示盒 —— 「XX 失败:…」这类红字盒子的唯一写法。
 * 外边距(mt-3 / mb-3 …)交给调用方 className,盒子本体样式不许各处漂。
 */
export function ErrorNote({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div
			className={`rounded-md border border-bn-danger-border bg-bn-danger-soft p-2.5 text-xs leading-relaxed text-bn-danger-text ${className ?? ""}`}
		>
			{children}
		</div>
	);
}

/**
 * 黄字提示盒 —— 「做完了,但有几处没照办」这一档。红字那档见 {@link ErrorNote}。
 *
 * 行高**刻意不给**:两处用它的地方(皮肤上传警告、消息排版提示)一个是短句列表、
 * 一个是整段说明,行高各要各的。同名工具类在一个 class 串里谁赢由生成顺序定,
 * 靠调用方覆盖不住,所以基础样式里干脆不放。
 */
export function WarnNote({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div
			className={`rounded-lg border border-bn-warning/40 bg-bn-warning/10 px-3 py-2 text-[11.5px] text-bn-warning ${className ?? ""}`}
		>
			{children}
		</div>
	);
}

// ── PlatformIcon ────────────────────────────────────────────────────────────

const PLATFORM_META: Record<string, { color: string; label: string; icon?: IconName }> = {
	onebot: { color: "#3b82f6", label: "OneBot", icon: "qq" },
	"qq-official": { color: "#14b8a6", label: "QQ官方", icon: "qq" },
	webhook: { color: "#22c55e", label: "Webhook" },
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
