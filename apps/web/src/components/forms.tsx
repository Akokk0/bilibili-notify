/**
 * Form atoms — Field / TInput / TArea / TNum / TSelect / TColor / ArrayEditor /
 * LogLevelPicker. Ported from `.bn-design/variation-ac-plugins.jsx`. Each
 * accepts the "code" prop the design uses (a backing `code-tag` shown next to
 * the label so users see which schema field they're editing).
 */

import { type ReactNode, useEffect, useState } from "react";

// ── Field ────────────────────────────────────────────────────────────────────

export interface FieldProps {
	label: ReactNode;
	hint?: ReactNode;
	code?: string;
	required?: boolean;
	full?: boolean;
	children: ReactNode;
}

export function Field({ label, hint, code, required, full, children }: FieldProps) {
	return (
		<div
			className={`border-b border-dashed border-black/5 py-2.5 ${
				full ? "flex flex-col gap-1.5" : "flex flex-row gap-3.5"
			} last:border-b-0`}
		>
			<div className={`pt-1 ${full ? "flex-none" : "flex-none basis-50"}`}>
				<div className="mb-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
					<span className="text-[12.5px] font-semibold text-bn-text-primary">{label}</span>
					{required ? <span className="text-[11px] text-red-500">*</span> : null}
					{code ? (
						<code className="rounded bg-black/5 px-1.5 py-px font-mono text-[10.5px] text-bn-text-tertiary">
							{code}
						</code>
					) : null}
				</div>
				{hint ? (
					<div className="text-[11px] leading-snug text-bn-text-secondary">{hint}</div>
				) : null}
			</div>
			<div className="flex min-w-0 flex-1 items-start">{children}</div>
		</div>
	);
}

// ── Inputs ───────────────────────────────────────────────────────────────────

const INPUT_BASE =
	"h-[30px] rounded-md border border-gray-200 bg-white px-2.5 text-[12.5px] text-bn-text-primary outline-none focus:border-bn-pink focus:ring-1 focus:ring-bn-pink/30";

export interface TInputProps {
	value: string;
	onChange: (next: string) => void;
	placeholder?: string;
	mono?: boolean;
	secret?: boolean;
	full?: boolean;
	type?: string;
}

export function TInput({
	value,
	onChange,
	placeholder,
	mono,
	secret,
	full = true,
	type = "text",
}: TInputProps) {
	// secret=true 时使用 <input type="password">,DOM value 不在 devtools 树展示明文,
	// 也阻止屏幕共享/截图泄漏。
	const effectiveType = secret ? "password" : type;
	return (
		<input
			type={effectiveType}
			value={value}
			onChange={(e) => onChange(e.target.value)}
			placeholder={placeholder}
			autoComplete={secret ? "new-password" : undefined}
			className={`${INPUT_BASE} ${mono || secret ? "font-mono" : ""} ${full ? "min-w-0 w-full" : "w-auto"}`}
		/>
	);
}

export interface TAreaProps {
	value: string;
	onChange: (next: string) => void;
	placeholder?: string;
	rows?: number;
	mono?: boolean;
}

export function TArea({ value, onChange, placeholder, rows = 3, mono }: TAreaProps) {
	return (
		<textarea
			value={value}
			onChange={(e) => onChange(e.target.value)}
			placeholder={placeholder}
			rows={rows}
			className={`min-w-0 w-full resize-y rounded-md border border-gray-200 bg-white px-2.5 py-2 text-[12.5px] leading-relaxed text-bn-text-primary outline-none focus:border-bn-pink focus:ring-1 focus:ring-bn-pink/30 ${mono ? "font-mono" : ""}`}
		/>
	);
}

export interface TNumProps {
	value: number;
	onChange: (next: number) => void;
	min?: number;
	max?: number;
	step?: number;
	suffix?: string;
	width?: number;
}

export function TNum({ value, onChange, min, max, step = 1, suffix, width = 80 }: TNumProps) {
	return (
		<div className="inline-flex items-center gap-1.5">
			<input
				type="number"
				value={value}
				onChange={(e) => onChange(Number(e.target.value))}
				min={min}
				max={max}
				step={step}
				className={`${INPUT_BASE} text-left font-mono`}
				style={{ width }}
			/>
			{suffix ? <span className="text-[11.5px] text-bn-text-secondary">{suffix}</span> : null}
		</div>
	);
}

export interface TSelectOption<T extends string = string> {
	value: T;
	label: string;
}

export interface TSelectProps<T extends string = string> {
	value: T;
	onChange: (next: T) => void;
	options: TSelectOption<T>[];
	full?: boolean;
}

export function TSelect<T extends string = string>({
	value,
	onChange,
	options,
	full,
}: TSelectProps<T>) {
	return (
		<select
			value={value}
			onChange={(e) => onChange(e.target.value as T)}
			className={`${INPUT_BASE} min-w-40 ${full ? "w-full" : "w-auto"}`}
		>
			{options.map((o) => (
				<option key={o.value} value={o.value}>
					{o.label}
				</option>
			))}
		</select>
	);
}

export interface TColorProps {
	value: string;
	onChange: (next: string) => void;
}

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function TColor({ value, onChange }: TColorProps) {
	const [hex, setHex] = useState(value);
	// keep the text input in sync when the color picker (or external resets)
	// pushes a new value down.
	useEffect(() => {
		setHex(value);
	}, [value]);

	const valid = HEX_RE.test(hex);

	return (
		<div className="inline-flex items-center gap-1.5">
			<input
				type="color"
				value={valid ? hex : value}
				onChange={(e) => {
					setHex(e.target.value);
					onChange(e.target.value);
				}}
				className="h-7.5 w-9 cursor-pointer rounded-md border border-gray-200 bg-white p-0"
			/>
			<input
				type="text"
				value={hex}
				onChange={(e) => {
					const next = e.target.value;
					setHex(next);
					if (HEX_RE.test(next)) onChange(next);
				}}
				onBlur={() => {
					if (!HEX_RE.test(hex)) setHex(value);
				}}
				placeholder="#rrggbb"
				spellCheck={false}
				className={`w-22 rounded-md border bg-white px-2 py-1 font-mono text-[11.5px] outline-none transition-colors ${
					valid
						? "border-gray-200 text-bn-text-primary focus:border-bn-pink"
						: "border-red-300 text-red-600 focus:border-red-400"
				}`}
			/>
		</div>
	);
}

// ── Picker — generic button-group, prefer over TSelect when options ≤ ~5 ─────

export interface PickerOption<T> {
	value: T;
	label: ReactNode;
	color?: string;
}

export interface PickerProps<T> {
	value: T;
	onChange: (next: T) => void;
	options: PickerOption<T>[];
}

export function Picker<T extends string | number | boolean>({
	value,
	onChange,
	options,
}: PickerProps<T>) {
	return (
		<div className="inline-flex flex-wrap gap-1 rounded-md bg-gray-100 p-0.75">
			{options.map((o) => {
				const active = value === o.value;
				return (
					<button
						type="button"
						key={String(o.value)}
						onClick={() => onChange(o.value)}
						className={`rounded px-3 py-1 text-[11.5px] font-semibold transition ${
							active ? "bg-white text-bn-pink shadow-sm" : "text-bn-text-tertiary"
						}`}
						style={active && o.color ? { color: o.color } : undefined}
					>
						{o.label}
					</button>
				);
			})}
		</div>
	);
}

export type LogLevelValue = 1 | 2 | 3 | 4;

export interface LogLevelPickerProps {
	/** `null` 表示「跟随全局」,仅当 `allowInherit` 时合法。 */
	value: LogLevelValue | null;
	onChange: (next: LogLevelValue | null) => void;
	/** 增加首个「跟随全局」按钮,选中后回调收 null。默认 false。 */
	allowInherit?: boolean;
}

export function LogLevelPicker({ value, onChange, allowInherit }: LogLevelPickerProps) {
	const opts: { v: LogLevelValue; label: string; color: string }[] = [
		{ v: 1, label: "错误", color: "#ef4444" },
		{ v: 2, label: "告警", color: "#f59e0b" },
		{ v: 3, label: "信息", color: "#00AEEC" },
		{ v: 4, label: "调试", color: "#a29bfe" },
	];
	return (
		<div className="inline-flex flex-wrap gap-1 rounded-md bg-gray-100 p-0.75">
			{allowInherit ? (
				<button
					type="button"
					onClick={() => onChange(null)}
					className={`rounded px-3 py-1 text-[11.5px] font-semibold transition ${
						value === null ? "bg-white text-bn-text-primary shadow-sm" : "text-bn-text-tertiary"
					}`}
				>
					跟随全局
				</button>
			) : null}
			{opts.map((o) => {
				const active = value === o.v;
				return (
					<button
						type="button"
						key={o.v}
						onClick={() => onChange(o.v)}
						className={`rounded px-3 py-1 text-[11.5px] font-semibold transition ${active ? "bg-white shadow-sm" : "text-bn-text-tertiary"}`}
						style={active ? { color: o.color } : undefined}
					>
						L{o.v} · {o.label}
					</button>
				);
			})}
		</div>
	);
}

export interface ArrayEditorProps {
	value: string[];
	onChange: (next: string[]) => void;
	placeholder?: string;
}

export function ArrayEditor({ value, onChange, placeholder }: ArrayEditorProps) {
	return (
		<div className="flex w-full flex-col gap-1">
			{value.map((v, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: index is the stable identity here — entries are positional and the row exposes it as the line number anyway
				<div key={i} className="flex gap-1.5">
					<span className="grid h-7.5 w-5.5 place-items-center font-mono text-[11px] text-bn-text-secondary">
						{i + 1}
					</span>
					<input
						value={v}
						onChange={(e) => {
							const n = [...value];
							n[i] = e.target.value;
							onChange(n);
						}}
						className={`${INPUT_BASE} flex-1 font-mono`}
					/>
					<button
						type="button"
						onClick={() => onChange(value.filter((_, j) => j !== i))}
						className="grid h-7.5 w-7.5 place-items-center rounded-md border border-gray-200 bg-white text-bn-text-secondary hover:text-red-500"
						aria-label="移除"
					>
						×
					</button>
				</div>
			))}
			<button
				type="button"
				onClick={() => onChange([...value, ""])}
				className="h-7.5 rounded-md border border-dashed border-gray-200 bg-white/60 text-[12px] text-bn-text-secondary hover:bg-white"
			>
				+ 添加一行{placeholder ? `（${placeholder}）` : ""}
			</button>
		</div>
	);
}

/**
 * QuietHoursEditor — TimeRange[] 编辑器,粒度按「时」。每行两个 hour picker (0-23),
 * 跨午夜由 start > end 隐式表达(显示在文案上说明),add/remove 按 ArrayEditor 风格。
 *
 * 后端 `inQuietHours` 把 `[start, end)` 当半开区间处理;`start === end` 被 schema
 * refine 拒绝,提交时若用户留了这种行会被后端 reject,前端不重复校验。
 */
export interface QuietHoursEditorProps {
	value: { start: number; end: number }[];
	onChange: (next: { start: number; end: number }[]) => void;
}

export function QuietHoursEditor({ value, onChange }: QuietHoursEditorProps) {
	const hours = Array.from({ length: 24 }, (_, i) => i);
	return (
		<div className="flex w-full flex-col gap-1">
			{value.map((r, i) => {
				const crossMidnight = r.start > r.end;
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: positional row identity
					<div key={i} className="flex items-center gap-1.5">
						<span className="grid h-7.5 w-5.5 place-items-center font-mono text-[11px] text-bn-text-secondary">
							{i + 1}
						</span>
						<select
							value={r.start}
							onChange={(e) => {
								const n = [...value];
								n[i] = { ...n[i], start: Number(e.target.value) };
								onChange(n);
							}}
							className={`${INPUT_BASE} w-18 font-mono`}
						>
							{hours.map((h) => (
								<option key={h} value={h}>
									{String(h).padStart(2, "0")}:00
								</option>
							))}
						</select>
						<span className="text-[11px] text-bn-text-tertiary">至</span>
						<select
							value={r.end}
							onChange={(e) => {
								const n = [...value];
								n[i] = { ...n[i], end: Number(e.target.value) };
								onChange(n);
							}}
							className={`${INPUT_BASE} w-18 font-mono`}
						>
							{hours.map((h) => (
								<option key={h} value={h}>
									{String(h).padStart(2, "0")}:00
								</option>
							))}
						</select>
						<span className="text-[10.5px] text-bn-text-tertiary">
							{crossMidnight ? "(跨次日)" : r.start === r.end ? "⚠ 区间为空" : ""}
						</span>
						<button
							type="button"
							onClick={() => onChange(value.filter((_, j) => j !== i))}
							className="grid h-7.5 w-7.5 place-items-center rounded-md border border-gray-200 bg-white text-bn-text-secondary hover:text-red-500"
							aria-label="移除"
						>
							×
						</button>
					</div>
				);
			})}
			<button
				type="button"
				onClick={() => onChange([...value, { start: 23, end: 7 }])}
				className="h-7.5 rounded-md border border-dashed border-gray-200 bg-white/60 text-[12px] text-bn-text-secondary hover:bg-white"
			>
				+ 添加免扰时段
			</button>
		</div>
	);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Immutably set a dot-path on an object (mirrors the design's setNested helper). */
export function setNested<T>(obj: T, path: string, value: unknown): T {
	const keys = path.split(".");
	const next = (Array.isArray(obj) ? [...obj] : { ...(obj as object) }) as T;
	let cur = next as Record<string, unknown>;
	for (let i = 0; i < keys.length - 1; i++) {
		const k = keys[i];
		const child = cur[k];
		cur[k] = (Array.isArray(child) ? [...child] : { ...(child as object) }) as unknown;
		cur = cur[k] as Record<string, unknown>;
	}
	cur[keys[keys.length - 1]] = value;
	return next;
}
