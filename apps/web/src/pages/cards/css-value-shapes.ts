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
	{ value: "", label: "无" },
];

const BORDER_STYLES: ReadonlyArray<{ value: string; label: string }> = [
	{ value: "solid", label: "实线" },
	{ value: "dashed", label: "虚线" },
	{ value: "dotted", label: "点线" },
	{ value: "double", label: "双线" },
	{ value: "none", label: "无" },
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
	"text-align": opts([
		["left", "左"],
		["center", "居中"],
		["right", "右"],
		["justify", "两端"],
	]),
	"font-weight": opts([
		["normal", "常规"],
		["bold", "粗体"],
		["300", "300 细"],
		["400", "400"],
		["500", "500 中"],
		["600", "600 半粗"],
		["700", "700 粗"],
		["800", "800"],
		["900", "900 黑"],
	]),
	"font-style": opts([
		["normal", "常规"],
		["italic", "斜体"],
	]),
	display: opts([
		["block", "块"],
		["inline", "行内"],
		["inline-block", "行内块"],
		["flex", "弹性"],
		["inline-flex", "行内弹性"],
		["grid", "网格"],
		["none", "不显示"],
	]),
	position: opts([
		["static", "默认"],
		["relative", "相对"],
		["absolute", "绝对"],
	]),
	"align-self": opts([
		["auto", "跟父级"],
		["start", "起点"],
		["center", "居中"],
		["end", "终点"],
		["stretch", "拉满"],
	]),
	"justify-self": opts([
		["auto", "跟父级"],
		["start", "起点"],
		["center", "居中"],
		["end", "终点"],
		["stretch", "拉满"],
	]),
	"align-items": opts([
		["flex-start", "起点"],
		["center", "居中"],
		["flex-end", "终点"],
		["stretch", "拉满"],
		["baseline", "基线"],
	]),
	"justify-content": opts([
		["flex-start", "起点"],
		["center", "居中"],
		["flex-end", "终点"],
		["space-between", "两端分散"],
		["space-around", "环绕分散"],
	]),
	"flex-direction": opts([
		["row", "横排"],
		["column", "竖排"],
	]),
	"flex-wrap": opts([
		["nowrap", "不换行"],
		["wrap", "换行"],
	]),
	"object-fit": opts([
		["cover", "裁满"],
		["contain", "装下"],
		["fill", "拉伸"],
		["none", "原尺寸"],
	]),
	overflow: opts([
		["visible", "露出"],
		["hidden", "裁掉"],
		["auto", "自动"],
	]),
	"white-space": opts([
		["normal", "正常"],
		["nowrap", "不换行"],
		["pre", "保留"],
		["pre-wrap", "保留且换行"],
	]),
	"text-overflow": opts([
		["clip", "截断"],
		["ellipsis", "省略号"],
	]),
	"text-decoration": opts([
		["none", "无"],
		["underline", "下划线"],
		["line-through", "删除线"],
	]),
	"text-transform": opts([
		["none", "无"],
		["uppercase", "全大写"],
		["lowercase", "全小写"],
	]),
	"vertical-align": opts([
		["baseline", "基线"],
		["top", "顶"],
		["middle", "中"],
		["bottom", "底"],
	]),
	visibility: opts([
		["visible", "可见"],
		["hidden", "隐藏"],
	]),
	"box-sizing": opts([
		["border-box", "含边框"],
		["content-box", "只算内容"],
	]),
	"border-style": BORDER_STYLES,
	"mix-blend-mode": opts([
		["normal", "正常"],
		["multiply", "正片叠底"],
		["screen", "滤色"],
		["overlay", "叠加"],
	]),
};

/** 常用属性的人话名。表里没有的属性照显属性名 —— 这张表只为好读,不限制能写什么。 */
export const PROP_LABELS: Readonly<Record<string, string>> = {
	padding: "内边距",
	margin: "外边距",
	background: "背景",
	"background-color": "背景色",
	color: "字色",
	"font-size": "字号",
	"font-weight": "字重",
	"font-style": "字形",
	"font-family": "字体",
	"line-height": "行高",
	"letter-spacing": "字距",
	"text-align": "对齐",
	"text-decoration": "文字装饰",
	"text-transform": "大小写",
	"text-shadow": "文字阴影",
	"text-overflow": "截断",
	"white-space": "换行",
	border: "边框",
	"border-color": "边框色",
	"border-width": "边框宽",
	"border-style": "边框样式",
	"border-radius": "圆角",
	"box-shadow": "阴影",
	width: "宽",
	height: "高",
	"max-width": "最大宽",
	"min-width": "最小宽",
	"max-height": "最大高",
	"min-height": "最小高",
	gap: "间距",
	opacity: "不透明度",
	display: "显示方式",
	position: "定位",
	top: "上",
	right: "右",
	bottom: "下",
	left: "左",
	"z-index": "层次",
	"align-self": "纵向对齐",
	"justify-self": "横向对齐",
	"align-items": "子项纵向对齐",
	"justify-content": "子项横向分布",
	"flex-direction": "排列方向",
	"flex-wrap": "换行方式",
	"object-fit": "图片填充",
	overflow: "溢出",
	"vertical-align": "基线对齐",
	visibility: "可见性",
	"box-sizing": "盒模型",
	transform: "变换",
	filter: "滤镜",
	"backdrop-filter": "背景滤镜",
	"mix-blend-mode": "混合模式",
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
