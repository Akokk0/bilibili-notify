/**
 * 结构化 CSS 编辑器(ADR-0014 决策 21 的 2026-09-19 🔗):规则 → 一行行声明,按值的形状给
 * 控件;源码退成一个切换。七枚旋钮并进来了,不再单列一排。
 *
 * **它没有自己的文本 state。** 决策 21 那句「不要旋钮值和 CSS 文本两份状态互相盖」照旧:
 * 每次渲染都从那段 CSS 现读(`readRules`),改一下就把改过的**整段文本**交回去(`css-rules`
 * 里那几个外科手术)。结构与源码是同一段文本的两个视图,所以做成**切换**而不是上下同摆 ——
 * 同时摆着、改一边另一边跟着跳,看着就像两份状态在互相盖。
 *
 * 两条不肯让步的(从旋钮那儿继承):
 * 1. **认不出形状的值不许被悄悄改写。** 渐变、阴影、`var()`、多值一律是文本行,原文照显、
 *    直接能改;改成认得出的形状它自己就换成控件。
 * 2. **不预先灌默认值。** 结构视图列的是写了的那些;没写的就是没写,要加得自己加。
 *
 * 结构视图里的文本框(选择器、文本行的值、加声明那两格)**失焦 / 回车才提交**:逐字提交
 * 的话,打到 `linear-gradient(` 一半整段就解析不了,结构视图会在手底下换成源码。
 */

import {
	AddButton,
	EmptyNote,
	HintNote,
	Icon,
	IconButton,
	Picker,
	Pill,
	TArea,
	TColor,
	TInput,
	TNum,
	TSelect,
} from "@bilibili-notify/ui";
import { useEffect, useMemo, useState } from "react";
import {
	addDecl,
	addRule,
	type CssDecl,
	type CssRule,
	readRules,
	removeDecl,
	removeRule,
	setDeclValue,
	setSelector,
} from "./css-rules";
import {
	BORDER_STYLES,
	COMMON_PROPS,
	formatShape,
	INSERT_CHIP,
	LENGTH_UNITS,
	propLabel,
	shapeOf,
	type ValueShape,
} from "./css-value-shapes";

type View = "structure" | "source";

/** 加声明时最多列几个候选属性。 */
const MAX_SUGGESTIONS = 6;

export function CssEditor({
	css,
	hooks,
	hooksLabel,
	onChange,
	ariaLabel,
	placeholder,
}: {
	css: string;
	/** 这段 CSS 能挂的选择器:`[挂点名, 人话名]`。「加一条规则」的胶囊照它列。 */
	hooks: Array<[string, string]>;
	/** 那排胶囊的名字(读屏器念的)。 */
	hooksLabel: string;
	onChange: (css: string) => void;
	/** 源码那个文本框的名字。 */
	ariaLabel: string;
	placeholder?: string;
}) {
	const [view, setView] = useState<View>("structure");
	// 指针在画布上每进出一个块,上头的 `hotCell` 就换一次 state —— 没有这个 memo,
	// 那段一个字节都没变的 CSS(上限 16KB)会跟着被 css-tree 重新 parse 十几次。
	const rules = useMemo(() => readRules(css), [css]);

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center justify-between gap-2">
				<Picker
					value={view}
					onChange={setView}
					options={[
						{ value: "structure", label: "结构" },
						{ value: "source", label: "源码" },
					]}
				/>
			</div>

			{/* 解析不了就让位给源码:硬撑着显示等于拿半份 AST 上算出来的偏移去切作者的文本。 */}
			{rules === null ? (
				<HintNote className="w-full">
					这段 CSS 现在解析不了(多半是括号没配上),结构视图先让位 —— 在源码里改好它自己回来。
				</HintNote>
			) : null}

			{view === "source" || rules === null ? (
				<TArea
					value={css}
					onChange={onChange}
					rows={10}
					mono
					ariaLabel={ariaLabel}
					placeholder={placeholder}
				/>
			) : (
				<Structure
					css={css}
					rules={rules}
					hooks={hooks}
					hooksLabel={hooksLabel}
					onChange={onChange}
				/>
			)}
		</div>
	);
}

function Structure({
	css,
	rules,
	hooks,
	hooksLabel,
	onChange,
}: {
	css: string;
	rules: CssRule[];
	hooks: Array<[string, string]>;
	hooksLabel: string;
	onChange: (css: string) => void;
}) {
	return (
		<div className="flex flex-col gap-2.5">
			{rules.length === 0 ? (
				<EmptyNote size="sm">还没有规则 —— 点下面一个挂点起一条。</EmptyNote>
			) : (
				rules.map((rule, ri) => (
					<RuleSection
						// 位置就是身份:同一段文本里第 n 条规则。
						key={rule.rule.start}
						rule={rule}
						onSelector={(sel) => onChange(setSelector(css, ri, sel))}
						onRemoveRule={() => onChange(removeRule(css, ri))}
						onValue={(di, value) => onChange(setDeclValue(css, ri, di, value))}
						onRemoveDecl={(di) => onChange(removeDecl(css, ri, di))}
						onAddDecl={(prop, value) => onChange(addDecl(css, ri, prop, value))}
					/>
				))
			)}

			{/* 挂点名是**对外 API**,记不住名字是写卡片皮肤的第一道坎 —— 列出来还能点一下起一条
			    规则。只是起手快捷,选择器本身照旧能改成自由段;限制的活归清洗器。 */}
			<fieldset aria-label={hooksLabel} className="flex min-w-0 flex-wrap items-center gap-1">
				<span className="text-bn-2xs text-bn-text-tertiary">加一条规则:</span>
				{hooks.map(([name, human]) => (
					<button
						key={name}
						type="button"
						data-bn="chip"
						title={`[data-bn="${name}"] —— ${human}`}
						onClick={() => onChange(addRule(css, `[data-bn="${name}"]`))}
						className={`flex items-center gap-1 ${INSERT_CHIP}`}
					>
						<span>{shortLabel(human)}</span>
						<span className="font-mono text-bn-text-tertiary">{name}</span>
					</button>
				))}
			</fieldset>
		</div>
	);
}

/** 挂点的人话名摆在胶囊上时只取括号前那截 —— 「外框(渐变 / 背景图那一层)」太长。 */
function shortLabel(human: string): string {
	return human.split("(")[0]?.trim() || human;
}

function RuleSection({
	rule,
	onSelector,
	onRemoveRule,
	onValue,
	onRemoveDecl,
	onAddDecl,
}: {
	rule: CssRule;
	onSelector: (selector: string) => void;
	onRemoveRule: () => void;
	onValue: (declIndex: number, value: string) => void;
	onRemoveDecl: (declIndex: number) => void;
	onAddDecl: (prop: string, value: string) => void;
}) {
	// 声明在 `decls` 里的下标 —— 写操作按它找;`items` 里夹着注释,下标对不上。
	let declIndex = -1;
	return (
		<section
			aria-label={`规则 ${rule.selector}`}
			className="flex flex-col gap-1.5 rounded-bn-sm border border-bn-border bg-bn-surface-muted p-2"
		>
			{rule.notes.map((note) => (
				<Note key={`${rule.rule.start}:${note}`} text={note} />
			))}
			<div className="flex items-center gap-1.5">
				{rule.atRule ? (
					<Pill subtle color="var(--color-bn-purple)">
						{rule.atRule}
					</Pill>
				) : null}
				<CommitInput
					value={rule.selector}
					onCommit={onSelector}
					ariaLabel={`规则 ${rule.selector} 的选择器`}
					mono
				/>
				<IconButton
					size="sm"
					label={`删掉规则 ${rule.selector}`}
					icon={<Icon.trash size={12} />}
					onClick={onRemoveRule}
				/>
			</div>

			{rule.items.map((item) => {
				if (item.kind === "comment") return <Note key={item.at} text={item.text} />;
				declIndex += 1;
				const di = declIndex;
				return (
					<DeclRow
						key={item.at}
						decl={item.decl}
						onValue={(v) => onValue(di, v)}
						onRemove={() => onRemoveDecl(di)}
					/>
				);
			})}

			<AddDeclRow onAdd={onAddDecl} />
		</section>
	);
}

/** 注释当灰字说明行摆出来(只读)—— 女仆写的注释就是给人看的解释。 */
function Note({ text }: { text: string }) {
	return <p className="text-bn-2xs text-bn-text-tertiary italic">{text}</p>;
}

function DeclRow({
	decl,
	onValue,
	onRemove,
}: {
	decl: CssDecl;
	onValue: (value: string) => void;
	onRemove: () => void;
}) {
	const label = propLabel(decl.prop);
	const shape = shapeOf(decl.prop, decl.value);
	return (
		<div className="flex min-w-0 flex-wrap items-center gap-1.5">
			<span className="flex min-w-0 flex-col leading-tight">
				<span className="text-bn-2xs text-bn-text-secondary">{label}</span>
				{label !== decl.prop ? (
					<span className="font-mono text-bn-2xs text-bn-text-tertiary">{decl.prop}</span>
				) : null}
			</span>
			<ValueControl label={label} shape={shape} raw={decl.value} onValue={onValue} />
			{decl.important ? (
				<Pill subtle color="var(--color-bn-warn)">
					!important
				</Pill>
			) : null}
			<IconButton
				size="xs"
				label={`删掉${label}`}
				icon={<Icon.close size={10} />}
				onClick={onRemove}
			/>
		</div>
	);
}

function ValueControl({
	label,
	shape,
	raw,
	onValue,
}: {
	label: string;
	shape: ValueShape;
	raw: string;
	onValue: (value: string) => void;
}) {
	if (shape.kind === "length") {
		return (
			<div className="flex items-center gap-1">
				<TNum
					value={shape.n}
					min={-9999}
					max={9999}
					step={shape.unit === "" ? 0.1 : 1}
					onChange={(n) => onValue(formatShape({ ...shape, n }))}
					ariaLabel={label}
					width={72}
				/>
				<TSelect
					value={shape.unit}
					onChange={(unit) => onValue(formatShape({ ...shape, unit }))}
					options={[...LENGTH_UNITS]}
					ariaLabel={`${label}的单位`}
					width={60}
				/>
			</div>
		);
	}
	if (shape.kind === "color") {
		return (
			<TColor
				value={shape.hex}
				onChange={(hex) => onValue(formatShape({ ...shape, hex }))}
				ariaLabel={label}
			/>
		);
	}
	if (shape.kind === "keyword") {
		return (
			<TSelect
				value={shape.keyword}
				onChange={(keyword) => onValue(formatShape({ ...shape, keyword }))}
				options={[...shape.options]}
				ariaLabel={label}
				width={120}
			/>
		);
	}
	if (shape.kind === "border") {
		return (
			<div className="flex flex-wrap items-center gap-1">
				<TNum
					value={shape.px}
					min={0}
					max={40}
					onChange={(px) => onValue(formatShape({ ...shape, px }))}
					ariaLabel={`${label}宽度`}
					width={64}
				/>
				<TSelect
					value={shape.style}
					onChange={(style) => onValue(formatShape({ ...shape, style }))}
					options={[...BORDER_STYLES]}
					ariaLabel={`${label}样式`}
					width={80}
				/>
				<TColor
					value={shape.hex}
					onChange={(hex) => onValue(formatShape({ ...shape, hex }))}
					ariaLabel={`${label}颜色`}
				/>
			</div>
		);
	}
	// 认不出形状:原文照显、直接能改。失焦 / 回车才提交(见文件头)。
	return <CommitInput value={raw} onCommit={onValue} ariaLabel={label} mono />;
}

/**
 * 失焦 / 回车才提交的文本框;Esc 退回原值。外面的值变了(别的控件改了同一段 CSS)就跟着换。
 */
function CommitInput({
	value,
	onCommit,
	ariaLabel,
	mono,
	placeholder,
}: {
	value: string;
	onCommit: (next: string) => void;
	ariaLabel: string;
	mono?: boolean;
	placeholder?: string;
}) {
	const [draft, setDraft] = useState(value);
	useEffect(() => setDraft(value), [value]);
	const commit = () => {
		const next = draft.trim();
		if (next === "" || next === value) {
			setDraft(value);
			return;
		}
		onCommit(next);
	};
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: 只为拦回车 / Esc,焦点在里面那个 input 上
		<span
			className="flex min-w-0 flex-1"
			onBlur={commit}
			onKeyDown={(e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					commit();
				} else if (e.key === "Escape") {
					setDraft(value);
				}
			}}
		>
			<TInput
				value={draft}
				onChange={setDraft}
				ariaLabel={ariaLabel}
				mono={mono}
				placeholder={placeholder}
			/>
		</span>
	);
}

/** 加声明那一行:属性名(带常用候选)+ 值 + 「加上」。 */
function AddDeclRow({ onAdd }: { onAdd: (prop: string, value: string) => void }) {
	const [prop, setProp] = useState("");
	const [value, setValue] = useState("");
	const typed = prop.trim().toLowerCase();
	const suggestions =
		typed === ""
			? []
			: COMMON_PROPS.filter((p) => p.startsWith(typed) && p !== typed).slice(0, MAX_SUGGESTIONS);
	const ready = typed !== "" && value.trim() !== "";
	const submit = () => {
		if (!ready) return;
		onAdd(typed, value.trim());
		setProp("");
		setValue("");
	};
	return (
		<div className="flex flex-col gap-1">
			{/* biome-ignore lint/a11y/noStaticElementInteractions: 只为让两格里按回车都能「加上」 */}
			<div
				className="flex flex-wrap items-center gap-1.5"
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						submit();
					}
				}}
			>
				<TInput
					value={prop}
					onChange={setProp}
					ariaLabel="要加的属性"
					placeholder="属性,如 padding"
					mono
					full={false}
					width={140}
				/>
				<TInput
					value={value}
					onChange={setValue}
					ariaLabel="要加的值"
					placeholder="值,如 12px"
					mono
					full={false}
					width={160}
				/>
				<AddButton disabled={!ready} onClick={submit}>
					<Icon.plus size={12} /> 加上
				</AddButton>
			</div>
			{suggestions.length > 0 ? (
				<fieldset className="flex flex-wrap gap-1" aria-label="属性候选">
					{suggestions.map((p) => (
						<button
							key={p}
							type="button"
							data-bn="chip"
							onClick={() => setProp(p)}
							className={INSERT_CHIP}
						>
							{propLabel(p)} <span className="font-mono text-bn-text-tertiary">{p}</span>
						</button>
					))}
				</fieldset>
			) : null}
		</div>
	);
}
