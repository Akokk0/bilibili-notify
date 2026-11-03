import { i18n } from "../../i18n";
/**
 * 一条声明的值长什么样,就给什么控件(ADR-0014 决策 21 的 2026-09-19 🔗:**按值的形状判,
 * 不按属性名**)。
 *
 * 从前七枚旋钮各自「认不认得出作者写的那个值」,这里推广成三类 + 边框那一档:单个颜色 →
 * 取色器,单个长度 → 数字 + 单位,已知关键字集 → 下拉,`1px solid #hex` → 边框三段。
 * **认不出的一律是文本行**(渐变、阴影、`var()`、多值、带透明度的颜色)—— 这不是错误,是
 * 正常结果;文本行照显原文、直接能改,改成认得出的形状它自己就换成控件。悄悄把
 * `12px 16px` 折成 `12px` 等于替作者删东西,而他多半不会当场发现。
 */

export type ValueShape =
	| { kind: "color"; hex: string }
	| { kind: "length"; n: number; unit: string }
	| { kind: "keyword"; keyword: string; options: ReadonlyArray<{ value: string; label: string }> }
	| { kind: "border"; px: number; style: string; hex: string }
	| { kind: "text" };

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
/** 单个长度:数 + 单位;裸数(`0`、`1.5`)单位为空。 */
const LEN_RE = /^(-?\d+(?:\.\d+)?)(px|em|rem|%|vw|vh|)$/;

/** 长度控件的单位候选。空串是「无」—— `line-height: 1.5`、`opacity: 0.8` 这种裸数。 */
export const LENGTH_UNITS: ReadonlyArray<{ value: string; label: string }> = [
	{ value: "px", label: "px" },
	{ value: "em", label: "em" },
	{ value: "rem", label: "rem" },
	{ value: "%", label: "%" },
	{ value: "vw", label: "vw" },
	{ value: "vh", label: "vh" },
	{
		value: "",
		get label() {
			return i18n.t("skinUi.css-value-shapes.1");
		},
	},
];

/**
 * 「点一下往框里填一段」那种小胶囊的说法 —— 挂点胶囊、属性候选、自定义块的字段胶囊,
 * 三处说的是同一句话。写死三份的话,改一次配色就会漂出两种小胶囊并排摆着。
 *
 * **刻意不套 `ToneChip`**:那件自带 `data-bn="btn"`、说的是「一排里选一个」(选中态 +
 * 实色边),悬停语义与这里的「按一下,内容进框」不是一回事 —— 换过去是换观感,不是复用。
 * 布局(flex / gap)留在摆放处:胶囊里摆一格还是两格是位置,不算漂移。
 */
export const INSERT_CHIP =
	"rounded-bn-pill border border-bn-border px-2 py-0.5 text-bn-2xs text-bn-text-secondary transition hover:border-bn-pink hover:text-bn-pink";

export const BORDER_STYLES: ReadonlyArray<{ value: string; label: string }> = [
	{
		value: "solid",
		get label() {
			return i18n.t("skinUi.css-value-shapes.2");
		},
	},
	{
		value: "dashed",
		get label() {
			return i18n.t("skinUi.css-value-shapes.3");
		},
	},
	{
		value: "dotted",
		get label() {
			return i18n.t("skinUi.css-value-shapes.4");
		},
	},
	{
		value: "double",
		get label() {
			return i18n.t("skinUi.css-value-shapes.5");
		},
	},
	{
		value: "none",
		get label() {
			return i18n.t("skinUi.css-value-shapes.6");
		},
	},
];

const opts = (pairs: ReadonlyArray<[string, string]>) =>
	pairs.map(([value, label]) => ({ value, label }));

/**
 * 关键字属性的候选表。**只列写卡片皮肤真会用到的**,不抄整份 CSS 规范 —— 表里没有的值照旧
 * 是文本行,不会被下拉吃掉。
 */
export const KEYWORD_OPTIONS: Readonly<
	Record<string, ReadonlyArray<{ value: string; label: string }>>
> = {
	get "text-align"() {
		return opts([
			["left", i18n.t("skinUi.css-value-shapes.7")],
			["center", i18n.t("skinUi.css-value-shapes.8")],
			["right", i18n.t("skinUi.css-value-shapes.9")],
			["justify", i18n.t("skinUi.css-value-shapes.10")],
		]);
	},
	get "font-weight"() {
		return opts([
			["normal", i18n.t("skinUi.css-value-shapes.11")],
			["bold", i18n.t("skinUi.css-value-shapes.12")],
			["300", i18n.t("skinUi.css-value-shapes.13")],
			["400", "400"],
			["500", i18n.t("skinUi.css-value-shapes.14")],
			["600", i18n.t("skinUi.css-value-shapes.15")],
			["700", i18n.t("skinUi.css-value-shapes.16")],
			["800", "800"],
			["900", i18n.t("skinUi.css-value-shapes.17")],
		]);
	},
	get "font-style"() {
		return opts([
			["normal", i18n.t("skinUi.css-value-shapes.18")],
			["italic", i18n.t("skinUi.css-value-shapes.19")],
		]);
	},
	get display() {
		return opts([
			["block", i18n.t("skinUi.css-value-shapes.20")],
			["inline", i18n.t("skinUi.css-value-shapes.21")],
			["inline-block", i18n.t("skinUi.css-value-shapes.22")],
			["flex", i18n.t("skinUi.css-value-shapes.23")],
			["inline-flex", i18n.t("skinUi.css-value-shapes.24")],
			["grid", i18n.t("skinUi.css-value-shapes.25")],
			["none", i18n.t("skinUi.css-value-shapes.26")],
		]);
	},
	get position() {
		return opts([
			["static", i18n.t("skinUi.css-value-shapes.27")],
			["relative", i18n.t("skinUi.css-value-shapes.28")],
			["absolute", i18n.t("skinUi.css-value-shapes.29")],
		]);
	},
	get "align-self"() {
		return opts([
			["auto", i18n.t("skinUi.css-value-shapes.30")],
			["start", i18n.t("skinUi.css-value-shapes.31")],
			["center", i18n.t("skinUi.css-value-shapes.32")],
			["end", i18n.t("skinUi.css-value-shapes.33")],
			["stretch", i18n.t("skinUi.css-value-shapes.34")],
		]);
	},
	get "justify-self"() {
		return opts([
			["auto", i18n.t("skinUi.css-value-shapes.35")],
			["start", i18n.t("skinUi.css-value-shapes.36")],
			["center", i18n.t("skinUi.css-value-shapes.37")],
			["end", i18n.t("skinUi.css-value-shapes.38")],
			["stretch", i18n.t("skinUi.css-value-shapes.39")],
		]);
	},
	get "align-items"() {
		return opts([
			["flex-start", i18n.t("skinUi.css-value-shapes.40")],
			["center", i18n.t("skinUi.css-value-shapes.41")],
			["flex-end", i18n.t("skinUi.css-value-shapes.42")],
			["stretch", i18n.t("skinUi.css-value-shapes.43")],
			["baseline", i18n.t("skinUi.css-value-shapes.44")],
		]);
	},
	get "justify-content"() {
		return opts([
			["flex-start", i18n.t("skinUi.css-value-shapes.45")],
			["center", i18n.t("skinUi.css-value-shapes.46")],
			["flex-end", i18n.t("skinUi.css-value-shapes.47")],
			["space-between", i18n.t("skinUi.css-value-shapes.48")],
			["space-around", i18n.t("skinUi.css-value-shapes.49")],
		]);
	},
	get "flex-direction"() {
		return opts([
			["row", i18n.t("skinUi.css-value-shapes.50")],
			["column", i18n.t("skinUi.css-value-shapes.51")],
		]);
	},
	get "flex-wrap"() {
		return opts([
			["nowrap", i18n.t("skinUi.css-value-shapes.52")],
			["wrap", i18n.t("skinUi.css-value-shapes.53")],
		]);
	},
	get "object-fit"() {
		return opts([
			["cover", i18n.t("skinUi.css-value-shapes.54")],
			["contain", i18n.t("skinUi.css-value-shapes.55")],
			["fill", i18n.t("skinUi.css-value-shapes.56")],
			["none", i18n.t("skinUi.css-value-shapes.57")],
		]);
	},
	get overflow() {
		return opts([
			["visible", i18n.t("skinUi.css-value-shapes.58")],
			["hidden", i18n.t("skinUi.css-value-shapes.59")],
			["auto", i18n.t("skinUi.css-value-shapes.60")],
		]);
	},
	get "white-space"() {
		return opts([
			["normal", i18n.t("skinUi.css-value-shapes.61")],
			["nowrap", i18n.t("skinUi.css-value-shapes.62")],
			["pre", i18n.t("skinUi.css-value-shapes.63")],
			["pre-wrap", i18n.t("skinUi.css-value-shapes.64")],
		]);
	},
	get "text-overflow"() {
		return opts([
			["clip", i18n.t("skinUi.css-value-shapes.65")],
			["ellipsis", i18n.t("skinUi.css-value-shapes.66")],
		]);
	},
	get "text-decoration"() {
		return opts([
			["none", i18n.t("skinUi.css-value-shapes.67")],
			["underline", i18n.t("skinUi.css-value-shapes.68")],
			["line-through", i18n.t("skinUi.css-value-shapes.69")],
		]);
	},
	get "text-transform"() {
		return opts([
			["none", i18n.t("skinUi.css-value-shapes.70")],
			["uppercase", i18n.t("skinUi.css-value-shapes.71")],
			["lowercase", i18n.t("skinUi.css-value-shapes.72")],
		]);
	},
	get "vertical-align"() {
		return opts([
			["baseline", i18n.t("skinUi.css-value-shapes.73")],
			["top", i18n.t("skinUi.css-value-shapes.74")],
			["middle", i18n.t("skinUi.css-value-shapes.75")],
			["bottom", i18n.t("skinUi.css-value-shapes.76")],
		]);
	},
	get visibility() {
		return opts([
			["visible", i18n.t("skinUi.css-value-shapes.77")],
			["hidden", i18n.t("skinUi.css-value-shapes.78")],
		]);
	},
	get "box-sizing"() {
		return opts([
			["border-box", i18n.t("skinUi.css-value-shapes.79")],
			["content-box", i18n.t("skinUi.css-value-shapes.80")],
		]);
	},
	"border-style": BORDER_STYLES,
	get "mix-blend-mode"() {
		return opts([
			["normal", i18n.t("skinUi.css-value-shapes.81")],
			["multiply", i18n.t("skinUi.css-value-shapes.82")],
			["screen", i18n.t("skinUi.css-value-shapes.83")],
			["overlay", i18n.t("skinUi.css-value-shapes.84")],
		]);
	},
};

/** 常用属性的人话名。表里没有的属性照显属性名 —— 这张表只为好读,不限制能写什么。 */
export const PROP_LABELS: Readonly<Record<string, string>> = {
	get padding() {
		return i18n.t("skinUi.css-value-shapes.85");
	},
	get margin() {
		return i18n.t("skinUi.css-value-shapes.86");
	},
	get background() {
		return i18n.t("skinUi.css-value-shapes.87");
	},
	get "background-color"() {
		return i18n.t("skinUi.css-value-shapes.88");
	},
	get color() {
		return i18n.t("skinUi.css-value-shapes.89");
	},
	get "font-size"() {
		return i18n.t("skinUi.css-value-shapes.90");
	},
	get "font-weight"() {
		return i18n.t("skinUi.css-value-shapes.91");
	},
	get "font-style"() {
		return i18n.t("skinUi.css-value-shapes.92");
	},
	get "font-family"() {
		return i18n.t("skinUi.css-value-shapes.93");
	},
	get "line-height"() {
		return i18n.t("skinUi.css-value-shapes.94");
	},
	get "letter-spacing"() {
		return i18n.t("skinUi.css-value-shapes.95");
	},
	get "text-align"() {
		return i18n.t("skinUi.css-value-shapes.96");
	},
	get "text-decoration"() {
		return i18n.t("skinUi.css-value-shapes.97");
	},
	get "text-transform"() {
		return i18n.t("skinUi.css-value-shapes.98");
	},
	get "text-shadow"() {
		return i18n.t("skinUi.css-value-shapes.99");
	},
	get "text-overflow"() {
		return i18n.t("skinUi.css-value-shapes.100");
	},
	get "white-space"() {
		return i18n.t("skinUi.css-value-shapes.101");
	},
	get border() {
		return i18n.t("skinUi.css-value-shapes.102");
	},
	get "border-color"() {
		return i18n.t("skinUi.css-value-shapes.103");
	},
	get "border-width"() {
		return i18n.t("skinUi.css-value-shapes.104");
	},
	get "border-style"() {
		return i18n.t("skinUi.css-value-shapes.105");
	},
	get "border-radius"() {
		return i18n.t("skinUi.css-value-shapes.106");
	},
	get "box-shadow"() {
		return i18n.t("skinUi.css-value-shapes.107");
	},
	get width() {
		return i18n.t("skinUi.css-value-shapes.108");
	},
	get height() {
		return i18n.t("skinUi.css-value-shapes.109");
	},
	get "max-width"() {
		return i18n.t("skinUi.css-value-shapes.110");
	},
	get "min-width"() {
		return i18n.t("skinUi.css-value-shapes.111");
	},
	get "max-height"() {
		return i18n.t("skinUi.css-value-shapes.112");
	},
	get "min-height"() {
		return i18n.t("skinUi.css-value-shapes.113");
	},
	get gap() {
		return i18n.t("skinUi.css-value-shapes.114");
	},
	get opacity() {
		return i18n.t("skinUi.css-value-shapes.115");
	},
	get display() {
		return i18n.t("skinUi.css-value-shapes.116");
	},
	get position() {
		return i18n.t("skinUi.css-value-shapes.117");
	},
	get top() {
		return i18n.t("skinUi.css-value-shapes.118");
	},
	get right() {
		return i18n.t("skinUi.css-value-shapes.119");
	},
	get bottom() {
		return i18n.t("skinUi.css-value-shapes.120");
	},
	get left() {
		return i18n.t("skinUi.css-value-shapes.121");
	},
	get "z-index"() {
		return i18n.t("skinUi.css-value-shapes.122");
	},
	get "align-self"() {
		return i18n.t("skinUi.css-value-shapes.123");
	},
	get "justify-self"() {
		return i18n.t("skinUi.css-value-shapes.124");
	},
	get "align-items"() {
		return i18n.t("skinUi.css-value-shapes.125");
	},
	get "justify-content"() {
		return i18n.t("skinUi.css-value-shapes.126");
	},
	get "flex-direction"() {
		return i18n.t("skinUi.css-value-shapes.127");
	},
	get "flex-wrap"() {
		return i18n.t("skinUi.css-value-shapes.128");
	},
	get "object-fit"() {
		return i18n.t("skinUi.css-value-shapes.129");
	},
	get overflow() {
		return i18n.t("skinUi.css-value-shapes.130");
	},
	get "vertical-align"() {
		return i18n.t("skinUi.css-value-shapes.131");
	},
	get visibility() {
		return i18n.t("skinUi.css-value-shapes.132");
	},
	get "box-sizing"() {
		return i18n.t("skinUi.css-value-shapes.133");
	},
	get transform() {
		return i18n.t("skinUi.css-value-shapes.134");
	},
	get filter() {
		return i18n.t("skinUi.css-value-shapes.135");
	},
	get "backdrop-filter"() {
		return i18n.t("skinUi.css-value-shapes.136");
	},
	get "mix-blend-mode"() {
		return i18n.t("skinUi.css-value-shapes.137");
	},
};

/** 加声明时候选的常用属性(顺序就是候选顺序)。 */
export const COMMON_PROPS: readonly string[] = Object.keys(PROP_LABELS);

/** 属性的人话名;表里没有就是属性名本身。 */
export function propLabel(prop: string): string {
	return PROP_LABELS[prop] ?? prop;
}

function parseLen(raw: string): { n: number; unit: string } | null {
	const m = LEN_RE.exec(raw.trim());
	return m?.[1] !== undefined ? { n: Number(m[1]), unit: m[2] ?? "" } : null;
}

/**
 * 边框简写。CSS 里三段**不讲顺序**,按 token 分类;三段不齐就认不出 —— 缺的那段补默认值
 * 等于替作者做主(他可能正靠继承来的值)。
 */
function parseBorder(raw: string): { px: number; style: string; hex: string } | null {
	const v = raw.trim();
	if (v.toLowerCase() === "none") return { px: 0, style: "none", hex: "#000000" };
	let px: number | null = null;
	let style: string | null = null;
	let hex: string | null = null;
	for (const t of v.split(/\s+/)) {
		const len = parseLen(t);
		if (len && (len.unit === "px" || (len.unit === "" && len.n === 0))) {
			if (px !== null) return null;
			px = len.n;
			continue;
		}
		if (BORDER_STYLES.some((s) => s.value === t.toLowerCase())) {
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

/** 这个值该给什么控件。`!important` 那一截不在 `value` 里(读写层单独记着)。 */
export function shapeOf(prop: string, value: string): ValueShape {
	const v = value.trim();
	if (prop === "border") {
		const b = parseBorder(v);
		return b ? { kind: "border", ...b } : { kind: "text" };
	}
	const options = KEYWORD_OPTIONS[prop];
	if (options) {
		const lower = v.toLowerCase();
		return options.some((o) => o.value === lower)
			? { kind: "keyword", keyword: lower, options }
			: { kind: "text" };
	}
	if (HEX_RE.test(v)) return { kind: "color", hex: v };
	const len = parseLen(v);
	if (len) return { kind: "length", ...len };
	return { kind: "text" };
}

/** 控件改出来的形状 → 写进 CSS 的那一截。 */
export function formatShape(shape: Exclude<ValueShape, { kind: "text" }>): string {
	switch (shape.kind) {
		case "color":
			return shape.hex;
		case "length":
			// 0 也带单位(写 `0px`,不写 `0`)。控件没有自己的 state,每次渲染都从那段文本现推
			// shape:这里省掉单位,下一轮 `shapeOf("padding", "0")` 就推成 `{ n: 0, unit: "" }`,
			// 单位下拉静默变「无」,作者再把数字调回 8 写出来的是裸的 `padding: 8` —— 非法长度,
			// 浏览器整条丢弃,而清洗器不查单位,于是这条声明存得下、导得出、就是不生效。
			return `${shape.n}${shape.unit}`;
		case "keyword":
			return shape.keyword;
		case "border":
			return shape.style === "none" || shape.px === 0
				? "none"
				: `${shape.px}px ${shape.style} ${shape.hex}`;
	}
}
