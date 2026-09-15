/**
 * 七枚常用旋钮各自「认不认得出作者写的那个值」(ADR-0014 决策 21)。
 *
 * **CSS 的值域比旋钮宽**,这是这一层存在的全部原因:`padding` 能写四个数、`background`
 * 能是渐变、`border` 能省略任意一段。旋钮表示不了时**不折不猜** —— `parse` 回 `null`
 * 是正常结果,面板据此把那枚切到「复杂值」那一档、把原文照显。悄悄把 `12px 16px` 折成
 * `12px` 等于替作者把他写的东西删了,而他多半不会当场发现。
 */

import type { KnobProp } from "./css-knobs";

/** 长度一档:一个 px 数。 */
export interface LenValue {
	px: number;
}
/** 颜色一档:一个 hex(色块控件只吐 hex,所以 `red` 这种关键字算表示不了)。 */
export interface ColorValue {
	hex: string;
}
/** 关键字一档:取值来自固定表。 */
export interface KeywordValue {
	keyword: string;
}
/** 边框那一档:宽 + 样式 + 色,三段齐了才算认得出。 */
export interface BorderValue {
	px: number;
	style: string;
	hex: string;
}

export type KnobValue = LenValue | ColorValue | KeywordValue | BorderValue;

export interface KnobSpec {
	prop: KnobProp;
	/** 面板上的名字。**不许出现裸属性名** —— 这排控件正是给不写 CSS 的人用的。 */
	label: string;
	/** 控件形态,面板照它画。 */
	kind: "len" | "color" | "keyword" | "border";
	/** 关键字那一档的候选(`kind === "keyword"` 才有)。 */
	options?: ReadonlyArray<{ value: string; label: string }>;
	/** 原文 → 旋钮值;表示不了回 `null`(正常结果,不是错误)。 */
	parse: (raw: string) => KnobValue | null;
	/** 旋钮值 → 写进 CSS 的那一截。 */
	format: (value: KnobValue) => string;
}

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const LEN_RE = /^(-?\d+(?:\.\d+)?)px$/;
const BORDER_STYLES = ["solid", "dashed", "dotted", "double", "none"] as const;

/** 长度:单个 px,或裸 `0`(CSS 允许 0 不带单位)。多值简写一律表示不了。 */
function parseLen(raw: string): LenValue | null {
	const v = raw.trim();
	if (v === "0") return { px: 0 };
	const m = LEN_RE.exec(v);
	return m?.[1] ? { px: Number(m[1]) } : null;
}

function formatLen(value: KnobValue): string {
	const px = (value as LenValue).px;
	return px === 0 ? "0" : `${px}px`;
}

function parseColor(raw: string): ColorValue | null {
	const v = raw.trim();
	return HEX_RE.test(v) ? { hex: v } : null;
}

function formatColor(value: KnobValue): string {
	return (value as ColorValue).hex;
}

const ALIGNS = [
	{ value: "left", label: "左" },
	{ value: "center", label: "居中" },
	{ value: "right", label: "右" },
	{ value: "justify", label: "两端" },
] as const;

/**
 * 边框简写。CSS 里这三段**不讲顺序**,所以按 token 分类而不是按位置读;三段不齐就回
 * `null` —— 缺的那段补个默认值等于替作者做主(他可能正靠继承来的值)。
 */
function parseBorder(raw: string): BorderValue | null {
	const v = raw.trim();
	if (v.toLowerCase() === "none") return { px: 0, style: "none", hex: "#000000" };
	const tokens = v.split(/\s+/);
	let px: number | null = null;
	let style: string | null = null;
	let hex: string | null = null;
	for (const t of tokens) {
		const len = parseLen(t);
		if (len) {
			if (px !== null) return null;
			px = len.px;
			continue;
		}
		if ((BORDER_STYLES as readonly string[]).includes(t.toLowerCase())) {
			if (style !== null) return null;
			style = t.toLowerCase();
			continue;
		}
		if (HEX_RE.test(t)) {
			if (hex !== null) return null;
			hex = t;
			continue;
		}
		return null;
	}
	if (px === null || style === null || hex === null) return null;
	return { px, style, hex };
}

function formatBorder(value: KnobValue): string {
	const b = value as BorderValue;
	if (b.style === "none" || b.px === 0) return "none";
	return `${b.px}px ${b.style} ${b.hex}`;
}

/** 顺序就是面板上的顺序(决策 21 点名的那七条)。 */
export const KNOB_SPECS: readonly KnobSpec[] = [
	{ prop: "padding", label: "内边距", kind: "len", parse: parseLen, format: formatLen },
	{ prop: "background", label: "背景色", kind: "color", parse: parseColor, format: formatColor },
	{ prop: "border-radius", label: "圆角", kind: "len", parse: parseLen, format: formatLen },
	{ prop: "border", label: "边框", kind: "border", parse: parseBorder, format: formatBorder },
	{
		prop: "text-align",
		label: "对齐",
		kind: "keyword",
		options: ALIGNS,
		parse: (raw) => {
			const v = raw.trim().toLowerCase();
			return ALIGNS.some((a) => a.value === v) ? { keyword: v } : null;
		},
		format: (value) => (value as KeywordValue).keyword,
	},
	{ prop: "font-size", label: "字号", kind: "len", parse: parseLen, format: formatLen },
	{ prop: "color", label: "字色", kind: "color", parse: parseColor, format: formatColor },
];
