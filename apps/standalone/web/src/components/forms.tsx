/**
 * Form atoms — Field / TInput / TArea / TNum / TSelect / TColor / ArrayEditor /
 * LogLevelPicker. Ported from `.bn-design/variation-ac-plugins.jsx`. Each
 * accepts the "code" prop the design uses (a backing `code-tag` shown next to
 * the label so users see which schema field they're editing).
 */

import type { ReactNode } from "react";

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
			<div className={`pt-1 ${full ? "flex-none" : "flex-none basis-[200px]"}`}>
				<div className="mb-0.5 flex items-center gap-1.5">
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
	return (
		<input
			type={type}
			value={value}
			onChange={(e) => onChange(e.target.value)}
			placeholder={placeholder}
			className={`${INPUT_BASE} ${mono || secret ? "font-mono" : ""} ${full ? "min-w-0 w-full" : "w-auto"}`}
			style={secret ? ({ WebkitTextSecurity: "disc" } as React.CSSProperties) : undefined}
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

export function TNum({ value, onChange, min, max, step = 1, suffix, width = 100 }: TNumProps) {
	return (
		<div className="inline-flex items-center gap-1.5">
			<input
				type="number"
				value={value}
				onChange={(e) => onChange(Number(e.target.value))}
				min={min}
				max={max}
				step={step}
				className={`${INPUT_BASE} text-right font-mono`}
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
			className={`${INPUT_BASE} min-w-[160px] ${full ? "w-full" : "w-auto"}`}
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

export function TColor({ value, onChange }: TColorProps) {
	return (
		<div className="inline-flex items-center gap-1.5">
			<input
				type="color"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="h-[30px] w-9 cursor-pointer rounded-md border border-gray-200 bg-white p-0"
			/>
			<code className="rounded-md border border-gray-200 bg-white px-2 py-1 font-mono text-[11.5px] text-bn-text-primary">
				{value}
			</code>
		</div>
	);
}

export interface LogLevelPickerProps {
	value: 1 | 2 | 3;
	onChange: (next: 1 | 2 | 3) => void;
}

export function LogLevelPicker({ value, onChange }: LogLevelPickerProps) {
	const opts: { v: 1 | 2 | 3; label: string; color: string }[] = [
		{ v: 1, label: "错误", color: "#ef4444" },
		{ v: 2, label: "信息", color: "#00AEEC" },
		{ v: 3, label: "调试", color: "#a29bfe" },
	];
	return (
		<div className="inline-flex gap-1 rounded-md bg-gray-100 p-[3px]">
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
					<span className="grid h-[30px] w-[22px] place-items-center font-mono text-[11px] text-bn-text-secondary">
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
						className="grid h-[30px] w-[30px] place-items-center rounded-md border border-gray-200 bg-white text-bn-text-secondary hover:text-red-500"
						aria-label="移除"
					>
						×
					</button>
				</div>
			))}
			<button
				type="button"
				onClick={() => onChange([...value, ""])}
				className="h-[30px] rounded-md border border-dashed border-gray-200 bg-white/60 text-[12px] text-bn-text-secondary hover:bg-white"
			>
				+ 添加一行{placeholder ? `（${placeholder}）` : ""}
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
