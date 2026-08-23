/**
 * 设置表单的**字典半** —— `Field`(code 驱动的标签壳,挂 data-code 灵动岛锚点、
 * code 徽章、默认值更新账本)与 `LogLevelPicker`(等级色表绑定)。
 *
 * 受控件家族(T 系列 / Picker / 行编辑器)已升 `@bilibili-notify/ui` 的
 * form-controls(2026-08-23 组件审计),这里**原样转口** —— 17 个消费方的
 * `from "../components/forms"` 一行不用改。缠字典的两件搬不走:FIELD_LABELS 与
 * LOG_LEVEL_TONE 都是业务配置,库背不动。
 */

import {
	Btn,
	type FieldUpdate,
	Icon,
	Picker,
	useFieldReset,
	useFieldUpdate,
} from "@bilibili-notify/ui";
import type { ReactNode } from "react";
import { type FieldLabel, getFieldLabel } from "../config/field-labels.js";
import { LOG_LEVEL_TONE } from "../config/log-levels";

export {
	ArrayEditor,
	type ArrayEditorProps,
	Picker,
	type PickerProps,
	QuietHoursEditor,
	type QuietHoursEditorProps,
	TArea,
	type TAreaProps,
	TColor,
	type TColorProps,
	TInput,
	type TInputProps,
	TNum,
	type TNumProps,
	TSelect,
	type TSelectProps,
} from "@bilibili-notify/ui";

// ── Field ────────────────────────────────────────────────────────────────────

/**
 * Field props 设计:
 * - `code` 必填,作为字段身份。外层 div 挂 `data-code={code}`,灵动岛 click
 *   跳转(Phase E)用 `querySelector('[data-code="X"]')` 找回字段位置。
 * - `label` / `hint` 可选 override,默认走 `field-labels.ts` 字典 lookup。
 *   多数页面只填 code 即可;Targets 这种 transport 类型分支会动态 label/hint
 *   的场景仍走 prop override(prop 优先 > 字典 > code 字面量兜底)。
 * - lookup miss 在开发环境会 warn 但不抛错,防止 schema 漂移直接白屏。
 */
export interface FieldProps {
	code: string;
	label?: ReactNode;
	hint?: ReactNode;
	required?: boolean;
	full?: boolean;
	children: ReactNode;
}

export function Field({ code, label, hint, required, full, children }: FieldProps) {
	const entry: FieldLabel | null = getFieldLabel(code);
	const effectiveLabel: ReactNode = label ?? entry?.label ?? code;
	const effectiveHint: ReactNode = hint ?? entry?.hint;
	const update = useFieldUpdate(code);
	const reset = useFieldReset(code);
	return (
		<div
			data-code={code}
			className={`border-b border-dashed border-bn-border-subtle py-2.5 ${
				full ? "flex flex-col gap-1.5" : "flex flex-row gap-3.5"
			} last:border-b-0`}
		>
			<div className={`pt-1 ${full ? "flex-none" : "flex-none basis-50"}`}>
				<div className="mb-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
					<span className="text-bn-sm font-semibold text-bn-text-primary">{effectiveLabel}</span>
					{required ? <span className="text-bn-xs text-bn-danger">*</span> : null}
					<code className="rounded-sm bg-bn-code-bg px-1.5 py-px font-mono text-bn-2xs text-bn-text-tertiary">
						{code}
					</code>
					{reset ? (
						<span data-field-reset>
							<Btn variant="ghost" size="sm" onClick={reset} title="把这条文案还原成当前默认">
								恢复默认
							</Btn>
						</span>
					) : null}
				</div>
				{effectiveHint ? (
					<div className="text-bn-xs leading-snug text-bn-text-secondary">{effectiveHint}</div>
				) : null}
			</div>
			<div className="flex min-w-0 flex-1 flex-col items-stretch gap-1.5">
				{children}
				{update ? <DefaultUpdateNotice update={update} /> : null}
			</div>
		</div>
	);
}

/**
 * 「这条文案的默认值变了」的提示条,贴在字段下方。
 *
 * 摆出新默认让主人自己比,再给两条出路 —— 换成新的,或者留着自己的。两个动作都会
 * 把这一版记进账本,所以**点完就不再打扰**(留着自己的那条尤其要紧:不记的话他每次
 * 打开这页都被问一遍同一件事)。
 */
function DefaultUpdateNotice({ update }: { update: FieldUpdate }) {
	return (
		<div
			data-template-update
			className="rounded-bn-card border border-bn-warning-border bg-bn-warning-soft px-2.5 py-2"
		>
			<div className="mb-1.5 flex items-center gap-1.5 text-bn-xs font-bold text-bn-warning-text">
				<Icon.sparkle className="h-3 w-3" />
				默认文案有更新
			</div>
			<pre className="mb-2 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-md bg-bn-code-bg px-2 py-1.5 font-mono text-bn-2xs leading-relaxed text-bn-text-secondary">
				{update.preview}
			</pre>
			<div className="flex flex-wrap gap-2">
				<Btn variant="primary" size="sm" onClick={update.accept}>
					用新默认
				</Btn>
				<Btn variant="outline" size="sm" onClick={update.keep}>
					保持我的
				</Btn>
			</div>
		</div>
	);
}

// ── LogLevelPicker ───────────────────────────────────────────────────────────

export type LogLevelValue = 1 | 2 | 3 | 4;

export interface LogLevelPickerProps {
	/** `null` 表示「跟随全局」,仅当 `allowInherit` 时合法。 */
	value: LogLevelValue | null;
	onChange: (next: LogLevelValue | null) => void;
	/** 增加首个「跟随全局」按钮,选中后回调收 null。默认 false。 */
	allowInherit?: boolean;
}

/** `null`(跟随全局)在 Picker 里的替身 —— Picker 的 value 不收 null。 */
const INHERIT = "inherit" as const;

const LOG_LEVELS: { v: LogLevelValue; label: string; color: string }[] = [
	{ v: 1, label: "错误", color: LOG_LEVEL_TONE.error },
	{ v: 2, label: "告警", color: LOG_LEVEL_TONE.warn },
	{ v: 3, label: "信息", color: LOG_LEVEL_TONE.info },
	{ v: 4, label: "调试", color: LOG_LEVEL_TONE.debug },
];

/**
 * 四档日志等级 + 可选的「跟随全局」。它就是一个 {@link Picker},此前把外壳与
 * 按钮又抄了一份 —— 抄的那份漏了 `aria-pressed`,于是这四颗对读屏器和测试都
 * 没有「选中」这回事。
 *
 * 「跟随全局」的语义色取正文色:它不是某一档等级,不该染成粉的。收编后它选中
 * 时的底色从 `bn-surface` 变成与四档一致的 `bn-surface-strong`(亮色下两个
 * token 同为 #fff,只有暗色看得出来 —— 它此前比同排的兄弟暗一档)。
 */
export function LogLevelPicker({ value, onChange, allowInherit }: LogLevelPickerProps) {
	const options = [
		...(allowInherit
			? [{ value: INHERIT, label: "跟随全局", color: "var(--color-bn-text-primary)" }]
			: []),
		...LOG_LEVELS.map((o) => ({ value: o.v, label: `L${o.v} · ${o.label}`, color: o.color })),
	];
	return (
		<Picker<LogLevelValue | typeof INHERIT>
			value={value ?? INHERIT}
			onChange={(next) => onChange(next === INHERIT ? null : next)}
			options={options}
		/>
	);
}
