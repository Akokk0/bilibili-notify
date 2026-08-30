/**
 * 设置表单的受控件家族 —— T 系列(TInput / TArea / TNum / TSelect / TColor)、
 * 段选 Picker 与两个行编辑器(ArrayEditor / QuietHoursEditor)。
 *
 * 从 apps/web 的 forms.tsx 升库(2026-08-23 全仓组件审计):这套是全站输入密度
 * 最高的原语(17 个文件消费),而它们本就零业务依赖。**字典那半没跟来** ——
 * `Field`(code 驱动的标签壳)与 `LogLevelPicker`(等级色表)缠着 web 的配置
 * 字典,仍住 `apps/web/src/components/forms.tsx`,那边同时转口这里的全部导出。
 *
 * 与 {@link Input} 的分工:Input 是带图标槽的搜索框原语(顶栏 / 弹窗里那种),
 * T 系列是设置表单的控件家族(挂点同为 `input`,底同为 `bg-bn-field`)。
 */

import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { ADD_LANGUAGE } from "./atoms";
import { Icon } from "./icons";

/** 只读态的观感:压暗 + 禁用光标。与 Toggle 的 disabled 同一套语汇。 */
const DISABLED_FIELD = "disabled:cursor-not-allowed disabled:opacity-60";

const INPUT_BASE =
	"h-[30px] rounded-md border border-bn-border bg-bn-field px-2.5 text-bn-sm text-bn-text-primary outline-none focus:border-bn-pink focus:ring-1 focus:ring-bn-pink/30";

/**
 * 皮肤的 `input` 挂点。设置面板的输入框(87 处)全走这套 —— 挂点脱落的话,皮肤写的
 * `[data-bn="input"]{…}` 只改得到登录框和几个搜索框,整片设置区纹丝不动。
 */
const INPUT_HOOK = "input";

/**
 * 无障碍名。**不是可选的装饰** —— 调用方常把控件包进一个 `<label>`,而那个 label
 * 里除了标题往往还有一整段提示文字;此时读屏器念出来的名字是**整段拼接**(「正文 ·
 * 做事的步骤 Markdown。这段会追加在女仆人格之后……」)。给了 `ariaLabel` 才只念标题。
 *
 * 走 prop 而不是让调用方在外面套 —— 属性得落在**控件本身**上,套在包装层等于没写。
 */
type Labelled = { ariaLabel?: string };

/**
 * 定宽。走 inline style 的**数字**而不是 `w-*` 类名:本仓没装 tailwind-merge,
 * 传进来的 `w-40` 压不掉基线里的 `w-full`/`w-auto`(同层同属性,胜负由样式表里的
 * 先后决定,不由 class 串的顺序),给出来的是个随构建漂移的结果。`TNum` 早就是
 * 这么解的,这里照抄。
 */
type Sized = { width?: number };

export interface TInputProps extends Labelled, Sized {
	value: string;
	onChange: (next: string) => void;
	placeholder?: string;
	mono?: boolean;
	secret?: boolean;
	full?: boolean;
	type?: string;
	/** 只读态(内置人格那几份)。禁用而不是隐藏 —— 内容本身仍是主人要看的。 */
	disabled?: boolean;
}

export function TInput({
	value,
	onChange,
	placeholder,
	mono,
	secret,
	full = true,
	type = "text",
	disabled,
	ariaLabel,
	width,
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
			disabled={disabled}
			aria-label={ariaLabel}
			data-bn={INPUT_HOOK}
			style={width === undefined ? undefined : { width }}
			className={`${INPUT_BASE} ${mono || secret ? "font-mono" : ""} ${
				width !== undefined ? "" : full ? "min-w-0 w-full" : "w-auto"
			} ${DISABLED_FIELD}`}
		/>
	);
}

export interface TAreaProps extends Labelled {
	value: string;
	onChange: (next: string) => void;
	placeholder?: string;
	rows?: number;
	mono?: boolean;
	/** 只读态,同 {@link TInputProps.disabled}。 */
	disabled?: boolean;
}

export function TArea({
	value,
	onChange,
	placeholder,
	rows = 3,
	mono,
	disabled,
	ariaLabel,
}: TAreaProps) {
	return (
		<textarea
			value={value}
			onChange={(e) => onChange(e.target.value)}
			placeholder={placeholder}
			rows={rows}
			disabled={disabled}
			aria-label={ariaLabel}
			data-bn={INPUT_HOOK}
			className={`min-w-0 w-full resize-y rounded-md border border-bn-border bg-bn-field px-2.5 py-2 text-bn-sm leading-relaxed text-bn-text-primary outline-none focus:border-bn-pink focus:ring-1 focus:ring-bn-pink/30 ${mono ? "font-mono" : ""} ${DISABLED_FIELD}`}
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
				data-bn={INPUT_HOOK}
				className={`${INPUT_BASE} text-left font-mono`}
				style={{ width }}
			/>
			{suffix ? <span className="text-bn-xs text-bn-text-secondary">{suffix}</span> : null}
		</div>
	);
}

interface TSelectOption<T extends string = string> {
	value: T;
	label: string;
}

export interface TSelectProps<T extends string = string> extends Labelled {
	value: T;
	onChange: (next: T) => void;
	options: TSelectOption<T>[];
	full?: boolean;
	/** 只读态,同 {@link TInputProps.disabled}。四件 T 里只有它此前漏了。 */
	disabled?: boolean;
}

export function TSelect<T extends string = string>({
	value,
	onChange,
	options,
	full,
	disabled,
	ariaLabel,
}: TSelectProps<T>) {
	return (
		<select
			value={value}
			onChange={(e) => onChange(e.target.value as T)}
			disabled={disabled}
			aria-label={ariaLabel}
			data-bn={INPUT_HOOK}
			className={`${INPUT_BASE} min-w-40 ${full ? "w-full" : "w-auto"} ${DISABLED_FIELD}`}
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
				data-bn={INPUT_HOOK}
				className="h-7.5 w-9 cursor-pointer rounded-md border border-bn-border bg-bn-field p-0"
			/>
			<input
				type="text"
				data-bn={INPUT_HOOK}
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
				className={`w-22 rounded-md border bg-bn-field px-2 py-1 font-mono text-bn-xs outline-none transition-colors ${
					valid
						? "border-bn-border text-bn-text-primary focus:border-bn-pink"
						: "border-bn-danger-border text-bn-danger-text focus:border-bn-danger-text"
				}`}
			/>
		</div>
	);
}

// ── Picker — generic button-group, prefer over TSelect when options ≤ ~5 ─────

interface PickerOption<T> {
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
		<div className="inline-flex flex-wrap gap-1 rounded-md bg-bn-surface-muted p-0.75">
			{options.map((o) => {
				const active = value === o.value;
				return (
					<button
						type="button"
						key={String(o.value)}
						onClick={() => onChange(o.value)}
						// 选中态此前只体现在 class 上 —— 读屏软件读不出来,测试也只能去比对
						// 样式字符串。aria-pressed 让「选的是哪个」成为可查询的事实。
						aria-pressed={active}
						// 段选改的是值,不是动作 —— chip 家族,别挂回 btn。
						data-bn={active ? "chip chip-active" : "chip"}
						className={`rounded-sm px-3 py-1 text-bn-xs font-semibold transition ${
							active ? "bg-bn-surface-strong text-bn-pink shadow-sm" : "text-bn-text-tertiary"
						}`}
						// `--bn-tint` 是**给皮肤读的**(同 ToneChip / Pill):选中那段把自己那档
						// 的语义色露出来,皮肤描边时引用它就不会把几档罩成同一个色。只在选中
						// 态给 —— 未选中是中性档。
						style={
							active && o.color
								? ({ color: o.color, "--bn-tint": o.color } as CSSProperties)
								: undefined
						}
					>
						{o.label}
					</button>
				);
			})}
		</div>
	);
}

/**
 * ── 行编辑器的共用装饰 ──────────────────────────────────────────────────────
 *
 * ArrayEditor 与 QuietHoursEditor 是同一种控件的两个特化(一列可增删的行),
 * 行号徽标 / 移除钮 / 添加钮此前在两处逐字抄了一遍。抄的东西一旦漂开,同一页
 * 上两个编辑器就会一个 h-7.5 一个不是 —— 所以这三件收成局部件,不导出:它们
 * 是这两个编辑器的实现细节,不是给页面用的原语。
 */

/** 行号徽标。宽度固定,好让两个编辑器的行首在同一条竖线上对齐。 */
function RowIndex({ n }: { n: number }) {
	return (
		<span className="grid h-7.5 w-5.5 place-items-center tabular-nums text-bn-xs text-bn-text-secondary">
			{n}
		</span>
	);
}

/** 行尾的移除钮。`aria-label` 是测试与读屏器认它的唯一凭据,别改成纯 × 文本。 */
function RemoveRowButton({ onClick }: { onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			data-bn="btn"
			className="grid h-7.5 w-7.5 place-items-center rounded-md border border-bn-border bg-bn-field text-bn-text-secondary hover:text-bn-danger"
			aria-label="移除"
		>
			×
		</button>
	);
}

/** 列表末尾那条虚线添加钮。文案各编辑器自己给。虚线=空位是它的语义,挂的是
 *  专词 `add-slot` 而非 `btn`(皮肤的按钮实底会把空位画成一颗真按钮),观感
 *  整句吃 {@link ADD_LANGUAGE} —— 此前自带白底、hover 变白,与家族其余成员
 *  的「粉描边 + 粉纱」不是一路(2026-08-30 主人点名统一)。 */
function AddRowButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
	return (
		<button
			type="button"
			onClick={onClick}
			data-bn="add-slot"
			className={`h-7.5 rounded-md text-bn-sm ${ADD_LANGUAGE}`}
		>
			{children}
		</button>
	);
}

/**
 * 0–23 的整点下拉。免扰时段每行两个,起点与终点只差写回哪个字段。
 * 24 个选项是常量,提到模块作用域 —— 原先每次 render 都现造一遍数组。
 */
const HOURS = Array.from({ length: 24 }, (_, i) => i);

function HourSelect({ value, onChange }: { value: number; onChange: (next: number) => void }) {
	return (
		<select
			value={value}
			onChange={(e) => onChange(Number(e.target.value))}
			data-bn={INPUT_HOOK}
			className={`${INPUT_BASE} w-18 font-mono`}
		>
			{HOURS.map((h) => (
				<option key={h} value={h}>
					{String(h).padStart(2, "0")}:00
				</option>
			))}
		</select>
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
					<RowIndex n={i + 1} />
					<input
						value={v}
						onChange={(e) => {
							const n = [...value];
							n[i] = e.target.value;
							onChange(n);
						}}
						data-bn={INPUT_HOOK}
						className={`${INPUT_BASE} flex-1 font-mono`}
					/>
					<RemoveRowButton onClick={() => onChange(value.filter((_, j) => j !== i))} />
				</div>
			))}
			<AddRowButton onClick={() => onChange([...value, ""])}>
				+ 添加一行{placeholder ? `（${placeholder}）` : ""}
			</AddRowButton>
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
	return (
		<div className="flex w-full flex-col gap-1">
			{value.map((r, i) => {
				const crossMidnight = r.start > r.end;
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: positional row identity
					<div key={i} className="flex items-center gap-1.5">
						<RowIndex n={i + 1} />
						<HourSelect
							value={r.start}
							onChange={(h) => {
								const n = [...value];
								n[i] = { ...n[i], start: h };
								onChange(n);
							}}
						/>
						<span className="text-bn-xs text-bn-text-tertiary">至</span>
						<HourSelect
							value={r.end}
							onChange={(h) => {
								const n = [...value];
								n[i] = { ...n[i], end: h };
								onChange(n);
							}}
						/>
						<span className="flex items-center gap-1 text-bn-2xs text-bn-text-tertiary">
							{crossMidnight ? (
								"(跨次日)"
							) : r.start === r.end ? (
								<>
									<Icon.warning size={11} className="shrink-0" />
									区间为空
								</>
							) : (
								""
							)}
						</span>
						<RemoveRowButton onClick={() => onChange(value.filter((_, j) => j !== i))} />
					</div>
				);
			})}
			<AddRowButton onClick={() => onChange([...value, { start: 23, end: 7 }])}>
				+ 添加免扰时段
			</AddRowButton>
		</div>
	);
}
