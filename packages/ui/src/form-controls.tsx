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

import {
	type CSSProperties,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { ADD_LANGUAGE, MenuItem } from "./atoms";
import { Icon } from "./icons";
import { PopoverShell, useDismiss } from "./popover";
import { useUiText } from "./texts";

/** 只读态的观感:压暗 + 禁用光标。与 Toggle 的 disabled 同一套语汇。 */
const DISABLED_FIELD = "disabled:cursor-not-allowed disabled:opacity-60";

const INPUT_CHROME =
	"rounded-md border border-bn-border bg-bn-field px-2.5 text-bn-sm text-bn-text-primary outline-none focus:border-bn-pink focus:ring-1 focus:ring-bn-pink/30";
const INPUT_BASE = `${INPUT_CHROME} h-[30px]`;

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
	id?: string;
	autoComplete?: string;
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
	id,
	autoComplete,
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
			id={id}
			value={value}
			onChange={(e) => onChange(e.target.value)}
			placeholder={placeholder}
			autoComplete={autoComplete ?? (secret ? "new-password" : undefined)}
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

export interface TNumProps extends Labelled {
	value: number;
	onChange: (next: number) => void;
	min?: number;
	max?: number;
	step?: number;
	suffix?: string;
	width?: number;
	/** 只读态,同 {@link TInputProps.disabled}。 */
	disabled?: boolean;
}

export function TNum({
	value,
	onChange,
	min,
	max,
	step = 1,
	suffix,
	width = 80,
	disabled,
	ariaLabel,
}: TNumProps) {
	return (
		<div className="inline-flex items-center gap-1.5">
			<input
				type="number"
				value={value}
				onChange={(e) => onChange(Number(e.target.value))}
				min={min}
				max={max}
				step={step}
				disabled={disabled}
				aria-label={ariaLabel}
				data-bn={INPUT_HOOK}
				className={`${INPUT_BASE} text-left font-mono ${DISABLED_FIELD}`}
				style={{ width }}
			/>
			{suffix ? <span className="text-bn-xs text-bn-text-secondary">{suffix}</span> : null}
		</div>
	);
}

export interface TSelectOption<T extends string = string> {
	value: T;
	label: string;
	icon?: ReactNode;
	description?: string;
	/** 不可选的一行:当前存着的值已经失效时,拿它如实显示出来(而不是让下拉悄悄跳到别的项)。 */
	disabled?: boolean;
}

export interface TSelectProps<T extends string = string> extends Labelled, Sized {
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
	width,
}: TSelectProps<T>) {
	const t = useUiText();
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(-1);
	const trigger = useRef<HTMLButtonElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	const gesture = useRef<{
		id: number;
		x: number;
		y: number;
		option: HTMLElement | null;
		down: boolean;
		canceled: boolean;
	} | null>(null);
	const optionAt = useCallback(
		(target: EventTarget | null) =>
			target instanceof Element ? target.closest<HTMLElement>('[role="option"]') : null,
		[],
	);
	const internal = (target: EventTarget | null) =>
		target instanceof Node &&
		(trigger.current?.contains(target) || panel.current?.contains(target));
	const settleFocus = useCallback(() => {
		if (!document.hasFocus()) {
			setOpen(false);
			return;
		}
		const current = document.activeElement;
		if (current === trigger.current) return;
		if (panel.current?.contains(current) || current === document.body)
			trigger.current?.focus({ preventScroll: true });
		else setOpen(false);
	}, []);
	useEffect(() => {
		if (!open) return;
		const finish = (e: PointerEvent) => {
			const g = gesture.current;
			if (!g || e.pointerId !== g.id) return;
			g.canceled ||=
				e.type === "pointercancel" ||
				Math.abs(e.clientX - g.x) >= 8 ||
				Math.abs(e.clientY - g.y) >= 8 ||
				optionAt(e.target) !== g.option;
			g.down = false;
			queueMicrotask(settleFocus);
		};
		const lost = () => setOpen(false);
		document.addEventListener("pointerup", finish, true);
		document.addEventListener("pointercancel", finish, true);
		window.addEventListener("blur", lost);
		return () => {
			document.removeEventListener("pointerup", finish, true);
			document.removeEventListener("pointercancel", finish, true);
			window.removeEventListener("blur", lost);
		};
	}, [open, optionAt, settleFocus]);
	const blur = (e: React.FocusEvent<HTMLButtonElement>) => {
		if (internal(e.relatedTarget)) return;
		if (e.relatedTarget) {
			setOpen(false);
			return;
		}
		queueMicrotask(() => {
			if (gesture.current?.down && document.activeElement === document.body && document.hasFocus())
				return;
			if (document.activeElement === document.body) setOpen(false);
			else settleFocus();
		});
	};
	useDismiss(trigger, () => setOpen(false), {
		enabled: open,
		event: "pointerdown",
		insideRefs: [panel],
	});
	const typed = useRef({ text: "", at: 0 });
	const id = useId();
	const selected = options.find((o) => o.value === value);
	const displayLabel =
		selected?.label ??
		(options.length === 0
			? t("ui.select.empty")
			: value === ""
				? t("ui.select.placeholder")
				: t("ui.select.unavailable", { value }));
	const available = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
	const show = (last = false) => {
		if (disabled || options.length === 0) return;
		const index = options.findIndex((o) => o.value === value && !o.disabled);
		setActive(index >= 0 ? index : ((last ? available.at(-1) : available[0]) ?? -1));
		gesture.current = null;
		typed.current = { text: "", at: 0 };
		setOpen(true);
	};
	const keys = (e: React.KeyboardEvent<HTMLElement>) => {
		if (disabled || e.nativeEvent.isComposing) return;
		if (open && e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			setOpen(false);
			trigger.current?.focus({ preventScroll: true });
			return;
		}
		if (e.key === "Tab") {
			setOpen(false);
			return;
		}
		if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(e.key)) e.preventDefault();
		if (e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			const char = e.key.toLocaleLowerCase();
			const previous = Date.now() - typed.current.at < 700 ? typed.current.text : "";
			const query = previous + char;
			const repeat = [...query].every((c) => c === char);
			const prefix = repeat ? char : query;
			const start = repeat || previous === "" ? active + 1 : active;
			const next = options
				.map((_, i) => (i + Math.max(0, start)) % options.length)
				.find(
					(i) => !options[i].disabled && options[i].label.toLocaleLowerCase().startsWith(prefix),
				);
			if (!open) show();
			typed.current = { text: query, at: Date.now() };
			if (next !== undefined) setActive(next);
			return;
		}
		if (!open) {
			if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) show(e.key === "ArrowUp");
			return;
		}
		if (e.key === "Enter" || e.key === " ") {
			if (options[active]) choose(options[active].value);
		} else if (e.key === "Home") setActive(available[0] ?? -1);
		else if (e.key === "End") setActive(available.at(-1) ?? -1);
		else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			const at = available.indexOf(active);
			setActive(
				available[
					Math.max(0, Math.min(available.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))
				] ?? -1,
			);
		}
	};
	useEffect(() => {
		if (open && active >= 0)
			document.getElementById(`${id}-${active}`)?.scrollIntoView?.({ block: "nearest" });
	}, [open, active, id]);
	useEffect(() => {
		if (disabled || options.length === 0) setOpen(false);
	}, [disabled, options.length]);
	useEffect(() => {
		if (open && (!options[active] || options[active].disabled))
			setActive(options.findIndex((option) => !option.disabled));
	}, [open, active, options]);
	const choose = (next: T) => {
		if (disabled || options.find((o) => o.value === next)?.disabled) return;
		if (next !== value) onChange(next);
		setOpen(false);
		trigger.current?.focus({ preventScroll: true });
	};
	return (
		<div
			className={full ? "relative w-full min-w-0" : "relative inline-block"}
			style={width === undefined ? undefined : { width }}
		>
			<button
				type="button"
				role="combobox"
				ref={trigger}
				disabled={disabled}
				aria-label={ariaLabel}
				aria-expanded={open}
				aria-haspopup="listbox"
				aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined}
				aria-controls={open ? id : undefined}
				data-bn={INPUT_HOOK}
				className={`${INPUT_CHROME} ${selected?.description ? "min-h-[30px] py-1.5" : "h-[30px]"} ${width === undefined ? "min-w-40" : ""} w-full inline-flex items-center gap-2 text-left ${DISABLED_FIELD}`}
				style={width === undefined ? undefined : { width }}
				onBlur={blur}
				onKeyDown={keys}
				onClick={() => (open ? setOpen(false) : show())}
			>
				{selected?.icon && (
					<span aria-hidden="true" className="shrink-0">
						{selected.icon}
					</span>
				)}
				<span className="min-w-0 flex-1">
					<span className="block truncate">{displayLabel}</span>
					{selected?.description && (
						<span
							className="block truncate text-bn-xs text-bn-text-tertiary"
							title={selected.description}
						>
							{selected.description}
						</span>
					)}
				</span>
				<Icon.chevronRight size={12} className="shrink-0 rotate-90 text-bn-text-tertiary" />
			</button>
			{open && (
				<PopoverShell
					id={id}
					anchorRef={trigger}
					onAnchorHidden={() => setOpen(false)}
					layer="modal"
					ref={panel}
					role="listbox"
					ariaLabel={ariaLabel}
				>
					<div
						className="min-h-0 overflow-y-auto"
						onKeyDownCapture={keys}
						onFocusCapture={() => trigger.current?.focus({ preventScroll: true })}
						onMouseDownCapture={(e) => {
							if (e.button === 0 && optionAt(e.target)) e.preventDefault();
						}}
						onPointerDownCapture={(e) => {
							if (gesture.current?.down || e.isPrimary === false || e.button > 0) {
								if (gesture.current) gesture.current.canceled = true;
								return;
							}
							gesture.current = {
								id: e.pointerId,
								x: e.clientX,
								y: e.clientY,
								option: optionAt(e.target),
								down: true,
								canceled: false,
							};
						}}
						onPointerMoveCapture={(e) => {
							const g = gesture.current;
							if (
								g?.down &&
								g.id === e.pointerId &&
								(Math.abs(e.clientX - g.x) >= 8 || Math.abs(e.clientY - g.y) >= 8)
							)
								g.canceled = true;
						}}
						onScrollCapture={() => {
							if (gesture.current?.down) gesture.current.canceled = true;
						}}
						onClickCapture={(e) => {
							const g = gesture.current;
							if (e.detail > 0 && g && (g.canceled || optionAt(e.target) !== g.option)) {
								e.preventDefault();
								e.stopPropagation();
							}
							gesture.current = null;
						}}
					>
						{options.map((o, i) => (
							<MenuItem
								id={`${id}-${i}`}
								active={i === active}
								key={o.value}
								role="option"
								tabIndex={-1}
								ariaSelected={o.value === value}
								ariaLabel={o.description ? `${o.label} · ${o.description}` : o.label}
								icon={o.icon}
								disabled={o.disabled}
								onClick={() => choose(o.value)}
							>
								<span className="min-w-0 flex-1">
									<span className="block truncate">{o.label}</span>
									{o.description && (
										<span
											className="block truncate text-bn-xs text-bn-text-tertiary"
											title={o.description}
										>
											{o.description}
										</span>
									)}
								</span>
							</MenuItem>
						))}
					</div>
				</PopoverShell>
			)}
		</div>
	);
}

export interface TColorProps extends Labelled {
	value: string;
	onChange: (next: string) => void;
	/** 只读态,同 {@link TInputProps.disabled}。两个原生 input 都要跟着禁。 */
	disabled?: boolean;
}

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function TColor({ value, onChange, disabled, ariaLabel }: TColorProps) {
	const t = useUiText();
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
				disabled={disabled}
				aria-label={
					ariaLabel === undefined ? undefined : t("ui.form.colorPicker", { label: ariaLabel })
				}
				data-bn={INPUT_HOOK}
				className={`h-7.5 w-9 cursor-pointer rounded-md border border-bn-border bg-bn-field p-0 ${DISABLED_FIELD}`}
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
				disabled={disabled}
				aria-label={ariaLabel}
				className={`w-22 rounded-md border bg-bn-field px-2 py-1 font-mono text-bn-xs outline-none transition-colors ${
					valid
						? "border-bn-border text-bn-text-primary focus:border-bn-pink"
						: "border-bn-danger-border text-bn-danger-text focus:border-bn-danger-text"
				} ${DISABLED_FIELD}`}
			/>
		</div>
	);
}

// ── Picker — generic button-group: use it for a fixed set of options (it wraps),
//    keep TSelect for options that come from data ─────────────────────────────

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
	const t = useUiText();
	return (
		<button
			type="button"
			onClick={onClick}
			data-bn="btn"
			className="grid h-7.5 w-7.5 place-items-center rounded-md border border-bn-border bg-bn-field text-bn-text-secondary hover:text-bn-danger"
			aria-label={t("ui.form.remove")}
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

function HourSelect({
	value,
	onChange,
	ariaLabel,
}: {
	value: number;
	onChange: (next: number) => void;
	ariaLabel: string;
}) {
	return (
		<TSelect
			width={72}
			value={String(value)}
			onChange={(next) => onChange(Number(next))}
			ariaLabel={ariaLabel}
			options={HOURS.map((h) => ({ value: String(h), label: `${String(h).padStart(2, "0")}:00` }))}
		/>
	);
}

export interface ArrayEditorProps {
	value: string[];
	onChange: (next: string[]) => void;
	placeholder?: string;
}

export function ArrayEditor({ value, onChange, placeholder }: ArrayEditorProps) {
	const t = useUiText();
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
				{placeholder ? t("ui.form.addRowWithHint", { hint: placeholder }) : t("ui.form.addRow")}
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
	const t = useUiText();
	return (
		<div className="flex w-full flex-col gap-1">
			{value.map((r, i) => {
				const crossMidnight = r.start > r.end;
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: positional row identity
					<div key={i} className="flex items-center gap-1.5">
						<RowIndex n={i + 1} />
						<HourSelect
							ariaLabel={t("ui.form.quietStart", { row: i + 1 })}
							value={r.start}
							onChange={(h) => {
								const n = [...value];
								n[i] = { ...n[i], start: h };
								onChange(n);
							}}
						/>
						<span className="text-bn-xs text-bn-text-tertiary">{t("ui.form.until")}</span>
						<HourSelect
							ariaLabel={t("ui.form.quietEnd", { row: i + 1 })}
							value={r.end}
							onChange={(h) => {
								const n = [...value];
								n[i] = { ...n[i], end: h };
								onChange(n);
							}}
						/>
						<span className="flex items-center gap-1 text-bn-2xs text-bn-text-tertiary">
							{crossMidnight ? (
								t("ui.form.crossMidnight")
							) : r.start === r.end ? (
								<>
									<Icon.warning size={11} className="shrink-0" />
									{t("ui.form.emptyRange")}
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
				{t("ui.form.addQuiet")}
			</AddRowButton>
		</div>
	);
}
