/**
 * **自定义块的 HTML 清洗层**(ADR-0014 决策 11 / 12,2026-09-13「开放重写」那一版:
 * 标签白名单放宽到排版语义标签全集,见 {@link ALLOWED_TAGS};`style=""` 照旧走
 * 声明级过滤,而那一层的属性策略同日改成了黑名单)。
 *
 * 自定义块的内容是一个**受限 HTML 子集**:标签白名单 + 属性白名单 + `{a.b.c}` 占位符;
 * 内联 svg 走第二张白名单({@link SVG_TAGS} / {@link SVG_ATTRS}),按命名空间分表。
 * 清洗的做法是**按白名单重建节点树** —— 用 parse5 把输入解析成 fragment,再往一棵新的
 * fragment 里逐个搬认识的节点;不在名单里的标签**连整个子树一起丢**,不在名单里的属性
 * 丢掉。**不是正则过滤**:正则挡不住 `<img src=x onerror=alert(1)//>`、`<svg/onload=…>`
 * 这一类分隔符花活,而 parse5 是 spec 级的 HTML parser,浏览器怎么读它就怎么读。
 *
 * 🔴 硬底线(ADR-0014 决策 13):`<script>` / 事件属性 / 外部 URL 任何情况下不放行 ——
 * 出图的 puppeteer 是 `--no-sandbox` 跑在 server 旁边的,皮肤包又是要分享的。
 *
 * 用 parse5 **不用 jsdom**:server 是自包含 bundle,jsdom 运行时要用 `__dirname` 读包内
 * 的 `xhr-sync-worker.js`,内联进 bundle 后必炸,且构建全绿、只在运行期炸(见 CLAUDE.md)。
 * parse5 是纯 JS、零磁盘读。
 *
 * 转义不用自己写:序列化走 parse5 的 serializer,文本位置的 `<` `&`、属性位置的 `"`
 * 都由它按 spec 转义 —— 我们只负责决定**哪些节点能活下来**。
 */

import {
	CARD_SKIN_FIELDS,
	CARD_SKIN_LIMITS,
	type CardSkinFieldType,
	type CardSkinKind,
} from "@bilibili-notify/internal";
import {
	type DefaultTreeAdapterTypes,
	defaultTreeAdapter,
	html as htmlNs,
	parseFragment,
	serialize,
	type Token,
} from "parse5";
import { sanitizeDeclarationList } from "../skins/scoped-css.js";
import { CARD_DECL_OPTIONS } from "./css-sanitizer.js";

/**
 * 标签白名单 —— **排版语义标签全集**(ADR-0014 决策 11 的 🔗,2026-09-13「开放重写」)。
 *
 * 原来只有 12 个(排版壳 + 行内强调 + 换行 + 图),理由是「标题 / 列表 / 引用在卡片上
 * 没有用武之地」;主人推翻了那条判断 —— 卡片渲染是用户体验感知最大的那一面,能写什么
 * 不该由我们替作者猜。放宽的这一批全是**排版语义**:标题、列表、表格、分节、引用、代码、
 * 行内标注,一个都不带行为。
 *
 * 🔴 **不放**的那几类,理由各自不同、一条都没松:
 * - `script` / `style` / `link`:直接是执行面与外联取网面。
 * - `a`:出图是 PNG,链接点不了;但它是**分享出去的**皮肤包里最顺手的钓鱼面。
 * - `iframe` / `object` / `embed`:内嵌文档,等于把别人的页面拉进我们的浏览器。
 * - `form` 族(`form` / `input` / `button` / `select` / `textarea`):静态图上没有意义,
 *   却带一身提交与自动聚焦的行为。
 * - `video` / `audio`:取网面,且截图里只会留个空框。
 * - `svg`:**不在这张表里,但不是拒** —— 它是另一个命名空间,走 {@link SVG_TAGS} 那张
 *   自己的白名单(2026-09-14 补的最后一片)。
 *
 * 名单是**白名单**,所以上面这些不是靠「记得拦」活着的 —— 没写进来的一律连子树丢。
 */
const ALLOWED_TAGS = new Set([
	// 排版壳与行内强调(原来那 12 个)
	"div",
	"span",
	"p",
	"b",
	"i",
	"strong",
	"em",
	"u",
	"s",
	"small",
	"br",
	"img",
	// 标题
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	// 列表与分隔
	"ul",
	"ol",
	"li",
	"hr",
	// 表格
	"table",
	"thead",
	"tbody",
	"tr",
	"th",
	"td",
	// 分节与图注
	"section",
	"header",
	"footer",
	"article",
	"figure",
	"figcaption",
	// 引用与代码
	"blockquote",
	"code",
	"pre",
	// 行内标注
	"sup",
	"sub",
	"mark",
	"del",
	"ins",
	"time",
	"abbr",
]);

/**
 * 内联 svg 的标签白名单(ADR-0014 决策 11 的 🔗,2026-09-14)。**按命名空间查**:HTML 标签
 * 在 svg 里出现(`<svg><b>`)parse5 会把它建成 SVG 命名空间的 `b`,对不上这张表就丢;
 * 反过来 `<svg>` 之外的 `<path>` 是 HTML 命名空间的未知标签,对不上 {@link ALLOWED_TAGS}
 * 也丢 —— 两张表互不串门。
 *
 * 收的是**画静态图要用的全部**:容器、形状、文字、渐变 / 图案、裁剪 / 蒙版 / 标记、
 * 滤镜整套(霓虹辉光就靠 `feGaussianBlur` + `feMerge`)。
 *
 * 🔴 **不放**的:
 * - `script` / `style` / `a`:与 HTML 那边同一条理由。
 * - `foreignObject`:把 HTML 再塞回 svg 的门 —— 放了它,HTML 那张白名单就得在这里再守一遍。
 * - `image` / `feImage`:svg 里的取图面(`href` 指外部文档)。要放图用 HTML 的 `<img>`。
 * - `animate` / `animateMotion` / `animateTransform` / `set` / `mpath`:能在渲染期把
 *   `href` 这类属性改成别的值(`<set attributeName="href" to="…">`),等于绕过属性闸;
 *   出图是一帧,动画本来也没意义。
 * - `use` 留下,但它的 `href` 只准 `#片段`(见 {@link FRAGMENT_REF_RE})。
 */
const SVG_TAGS = new Set([
	// 容器与结构
	"svg",
	"g",
	"defs",
	"symbol",
	"use",
	"title",
	"desc",
	// 形状
	"path",
	"rect",
	"circle",
	"ellipse",
	"line",
	"polyline",
	"polygon",
	// 文字
	"text",
	"tspan",
	"textPath",
	// 渐变与图案
	"linearGradient",
	"radialGradient",
	"stop",
	"pattern",
	// 裁剪 / 蒙版 / 标记
	"clipPath",
	"mask",
	"marker",
	// 滤镜
	"filter",
	"feBlend",
	"feColorMatrix",
	"feComponentTransfer",
	"feFuncR",
	"feFuncG",
	"feFuncB",
	"feFuncA",
	"feComposite",
	"feConvolveMatrix",
	"feDiffuseLighting",
	"feDisplacementMap",
	"feDistantLight",
	"feDropShadow",
	"feFlood",
	"feGaussianBlur",
	"feMerge",
	"feMergeNode",
	"feMorphology",
	"feOffset",
	"fePointLight",
	"feSpecularLighting",
	"feSpotLight",
	"feTile",
	"feTurbulence",
]);

/**
 * svg 元素共用的一张属性白名单:几何 + 表现 + 文字 + 渐变 / 图案 + 裁剪 / 蒙版 / 标记 +
 * 滤镜原语的参数。**不按标签分**(与 HTML 那边不同):svg 的属性面上百个,按标签分表
 * 只换来「`<rect>` 上写 `cx` 会被丢」这种作者自己就能看出来的错,不换来安全 ——
 * 危险面只在三处:`href`(取网)、`url()`(表现属性里指外部文档)、事件属性,前两处
 * 各有专门的闸,第三处 `on*` 根本不在表里。
 *
 * `class` / `style` / `id` / `href` 不在这里,各走各的检查。
 */
const SVG_ATTRS = new Set([
	// 视口 / 几何 / 变换
	"viewBox",
	"width",
	"height",
	"x",
	"y",
	"preserveAspectRatio",
	"transform",
	"transform-origin",
	"d",
	"cx",
	"cy",
	"r",
	"rx",
	"ry",
	"x1",
	"y1",
	"x2",
	"y2",
	"points",
	"pathLength",
	// 表现
	"opacity",
	"visibility",
	"display",
	"overflow",
	"fill",
	"fill-opacity",
	"fill-rule",
	"stroke",
	"stroke-width",
	"stroke-opacity",
	"stroke-linecap",
	"stroke-linejoin",
	"stroke-miterlimit",
	"stroke-dasharray",
	"stroke-dashoffset",
	"color",
	"paint-order",
	"vector-effect",
	"shape-rendering",
	"mix-blend-mode",
	"isolation",
	"color-interpolation",
	"color-interpolation-filters",
	// 文字
	"font-family",
	"font-size",
	"font-weight",
	"font-style",
	"font-variant",
	"letter-spacing",
	"word-spacing",
	"text-anchor",
	"dominant-baseline",
	"alignment-baseline",
	"baseline-shift",
	"text-decoration",
	"text-rendering",
	"writing-mode",
	"dx",
	"dy",
	"rotate",
	"textLength",
	"lengthAdjust",
	"startOffset",
	"method",
	"spacing",
	"side",
	// 渐变 / 图案
	"gradientUnits",
	"gradientTransform",
	"spreadMethod",
	"offset",
	"stop-color",
	"stop-opacity",
	"fx",
	"fy",
	"fr",
	"patternUnits",
	"patternContentUnits",
	"patternTransform",
	// 裁剪 / 蒙版 / 标记
	"clip-path",
	"clip-rule",
	"clipPathUnits",
	"mask",
	"maskUnits",
	"maskContentUnits",
	"marker-start",
	"marker-mid",
	"marker-end",
	"markerWidth",
	"markerHeight",
	"markerUnits",
	"refX",
	"refY",
	"orient",
	// 滤镜
	"filter",
	"filterUnits",
	"primitiveUnits",
	"in",
	"in2",
	"result",
	"stdDeviation",
	"edgeMode",
	"mode",
	"type",
	"values",
	"tableValues",
	"slope",
	"intercept",
	"amplitude",
	"exponent",
	"k1",
	"k2",
	"k3",
	"k4",
	"operator",
	"radius",
	"flood-color",
	"flood-opacity",
	"lighting-color",
	"surfaceScale",
	"specularConstant",
	"specularExponent",
	"diffuseConstant",
	"kernelMatrix",
	"order",
	"divisor",
	"bias",
	"targetX",
	"targetY",
	"kernelUnitLength",
	"azimuth",
	"elevation",
	"pointsAtX",
	"pointsAtY",
	"pointsAtZ",
	"limitingConeAngle",
	"z",
	"scale",
	"xChannelSelector",
	"yChannelSelector",
	"baseFrequency",
	"numOctaves",
	"seed",
	"stitchTiles",
]);

/**
 * svg 元素的 `id`:渐变 / 裁剪 / 滤镜都靠 `url(#id)` 引用,没有 id 这些东西就画不出来,
 * 所以 svg 这边放行(HTML 那边照旧不给)。形状限死成 CSS 标识符的保守子集。
 *
 * ⚠️ id 在整张卡的 DOM 里是同一个命名空间:两个自定义块都写 `id="g"`,浏览器只认第一个。
 * 清洗器一次只看一个块,查不了跨块重名 —— 作者自己给 id 起个带前缀的名字。
 */
const SVG_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
/** `href` 在 svg 里唯一放行的形状:同文档的片段引用。`#` 后面必须是一个 {@link SVG_ID_RE}。 */
const FRAGMENT_REF_RE = /^#([A-Za-z][A-Za-z0-9_-]*)$/;
/** 表现属性里出现了 `url(` 时,整个值必须恰好是一个片段引用。 */
const URL_FRAGMENT_RE = /^url\(\s*#([A-Za-z][A-Za-z0-9_-]*)\s*\)$/;
const HAS_URL_RE = /url\s*\(/i;

/** 所有标签共用的属性。`id` 不在里面 —— 卡片 DOM 的 id 归渲染器,皮肤不许占坑。 */
const COMMON_ATTRS = new Set(["class", "style"]);
/** `img` 额外多的两个。`srcset` / `loading` / `crossorigin` 一律不给。 */
const IMG_ATTRS = new Set(["src", "alt"]);
/** `td` / `th` 额外多的两个。值域见 {@link SPAN_RE}。 */
const CELL_ATTRS = new Set(["colspan", "rowspan"]);
/**
 * 每个标签独有的那几格属性。名单是**按标签查**的,不是「有这个属性名就行」——
 * `<div colspan="2">` 一样得丢,不然属性白名单就从「这个标签能有什么」松成「全集」。
 */
const EXTRA_ATTRS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["img", IMG_ATTRS],
	["td", CELL_ATTRS],
	["th", CELL_ATTRS],
]);

/**
 * `colspan` / `rowspan` 的值:**正整数**,没有前导零之外的花样。
 *
 * `0` 在 HTML 里有「铺满整个列组」的特殊含义,负数与小数各家容错不同 —— 画出来的表
 * 跟作者以为的不是一回事,不如整格丢掉,让它退回普通单元格。
 */
const SPAN_RE = /^[1-9][0-9]*$/;

/** class 的每个 token。`{` `.` `:` 都进不来,所以占位符写进 class 会让整个属性被丢。 */
const CLASS_TOKEN_RE = /^[A-Za-z0-9_-]+$/;

/** 文本 / alt 里的占位符。与 `CARD_SKIN_FIELDS` 的路径形状同一套规矩。 */
const PLACEHOLDER_RE = /\{([a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+)\}/g;
/** `src` 那一档:**整个值**恰好是一个占位符才算数(ADR-0014 决策 12)。 */
const WHOLE_PLACEHOLDER_RE = /^\{([a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+)\}$/;
/** 包内资产的引用前缀。 */
const ASSET_PREFIX = "asset:";

export interface SanitizeCardHtmlOptions {
	kind: CardSkinKind;
	/** 包内资产名。`src="asset:<名>"` 必须落在这里面。 */
	assets: ReadonlySet<string>;
}

export type SanitizeCardHtmlResult =
	| {
			ok: true;
			html: string;
			warnings: string[];
			/**
			 * 留在产物里的 svg `id`,按出现顺序。清洗器一次只看一个块,**查不了跨块重名** ——
			 * 而整张卡渲染出来是一份文档,`id` 是全卡一个命名空间。所以这里只负责如实报出来,
			 * 汇总与判重归 package 那一层(只有它同时看得见一张卡的所有块)。
			 */
			ids: string[];
	  }
	| { ok: false; errors: string[] };

type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;

interface Ctx {
	kind: CardSkinKind;
	assets: ReadonlySet<string>;
	fields: Map<string, CardSkinFieldType>;
	warnings: string[];
	/** 指向不存在字段的占位符路径 —— 这是 error 面,攒齐一次报全。 */
	unknownPaths: Set<string>;
	/** 留下来的 svg `id`,按出现顺序(判重归 package 层,见 {@link SanitizeCardHtmlResult})。 */
	ids: string[];
}

/**
 * 文本 / `alt` 里的占位符对表。
 *
 * 缺字段是 **error(整块拒收)**,不是丢弃也不是原样保留:出图给空串的话,写错的皮肤
 * 会带着一个空洞被推到群里;原样留 `{xxx}` 更糟,推出去的是一行大括号(ADR-0014 决策 12)。
 * `{` 后面不是路径形状的(`{ margin }`、`{1}`)照字面保留 —— 那是作者真想写的花括号。
 */
function checkPlaceholders(text: string, ctx: Ctx): void {
	for (const m of text.matchAll(PLACEHOLDER_RE)) {
		const path = m[1] as string;
		if (!ctx.fields.has(path)) ctx.unknownPaths.add(path);
	}
}

/**
 * `img` 的 `src` 只准两种值,其余一律丢掉整个 `<img>`:
 *
 * 1. `asset:<资产名>` —— 名字必须真在包里(装包时拷进来的那份清单);
 * 2. **恰好一个**占位符 `{a.b.c}`,且该字段在这张卡的契约里是 `image` 类型。
 *
 * 第 2 条的类型闸是要紧的:`{live.title}` 是文本,塞进 `src` 出图时会变成一个对
 * 「直播标题」发起的请求 —— 既画不出图,又把标题当 URL 送了出去。
 *
 * 返回 null = 放行(值已归一化),字符串 = 丢弃原因。
 */
function checkSrc(raw: string, ctx: Ctx): { value: string } | { reason: string } {
	const value = raw.trim();
	if (value.startsWith(ASSET_PREFIX)) {
		const name = value.slice(ASSET_PREFIX.length);
		if (!ctx.assets.has(name)) return { reason: `src 指向的资产「${name}」不在包里` };
		return { value };
	}
	const m = WHOLE_PLACEHOLDER_RE.exec(value);
	if (!m) {
		return {
			reason: `src「${value}」只准写 ${ASSET_PREFIX}<资产名> 或一个图片类型的字段占位符`,
		};
	}
	const path = m[1] as string;
	const type = ctx.fields.get(path);
	if (type === undefined)
		return { reason: `src 的占位符「{${path}}」不在 ${ctx.kind} 卡的字段表里` };
	if (type !== "image") {
		return { reason: `src 的占位符「{${path}}」是 ${type} 类型,只有 image 类型能当图` };
	}
	return { value };
}

/** `class`:HTML 与 svg 同一条规矩。返回 null = 丢掉这个属性(warning 已记)。 */
function cleanClass(tag: string, value: string, ctx: Ctx): Token.Attribute | null {
	const tokens = value.split(/\s+/).filter((t) => t !== "");
	if (tokens.length === 0 || !tokens.every((t) => CLASS_TOKEN_RE.test(t))) {
		ctx.warnings.push(`<${tag}> 的 class「${value}」含不合法的 token,整个属性丢弃`);
		return null;
	}
	return { name: "class", value: tokens.join(" ") };
}

/**
 * `style`:交给 CSS 那一层的声明级过滤 —— 同一份属性黑名单、`url()` 拒、`position` 只准
 * static / relative / absolute(内联样式没有伪元素,「装饰」那一档整个不适用)。
 * svg 元素同一条:`style="fill:url(#g)"` 会被拒,要用属性写 `fill="url(#g)"`。
 */
function cleanStyle(tag: string, value: string, ctx: Ctx): Token.Attribute | null {
	const cleaned = sanitizeDeclarationList(value, CARD_DECL_OPTIONS);
	if (!cleaned) {
		ctx.warnings.push(`<${tag}> 的 style 解析不动,整个属性丢弃`);
		return null;
	}
	for (const w of cleaned.warnings) ctx.warnings.push(`<${tag}> 的 style: ${w}`);
	if (cleaned.css.trim() === "") return null;
	return { name: "style", value: cleaned.css };
}

/**
 * svg 元素的属性。三道闸各管一处危险面:
 * - `href`(含 `xlink:href`,归一成 `href`)只准 `#片段`;
 * - 表现属性里出现 `url(` 时整个值必须恰好是 `url(#id)`;
 * - 带命名空间前缀的其它属性(`xml:space` / `xmlns:xlink`)与不在 {@link SVG_ATTRS} 的一律丢。
 */
function filterSvgAttrs(el: Element, ctx: Ctx): Token.Attribute[] {
	const tag = el.tagName;
	const out: Token.Attribute[] = [];
	let hasHref = false;
	for (const attr of el.attrs) {
		const name = attr.name;
		// 命名空间声明**静静丢掉**:`xmlns` / `xmlns:xlink` 是每一份从设计工具复制出来的
		// svg 都带的,而在 HTML 里它们本来就不起作用(解析器按标签名就把 `<svg>` 放进 svg
		// 命名空间)。为它们各报一条,等于让作者第一次贴 svg 就先吃两条看不懂的红字,然后
		// 学会不看警告栏 —— 而警告栏里真该看的是「你那个 `<image>` 被丢了」。
		// parse5 把 `xmlns` 存成 name="xmlns" + prefix=""(空串,不是 undefined)。
		if (name === "xmlns" || attr.prefix === "xmlns") continue;
		// parse5 把 `xlink:href` 存成 name="href" + prefix="xlink";别的前缀一律不认。
		if (attr.prefix !== undefined && !(attr.prefix === "xlink" && name === "href")) {
			// 前缀是空串时别拼出一个 `:name` 来 —— 报出去的名字得是作者写的那个。
			const shown = attr.prefix ? `${attr.prefix}:${name}` : name;
			ctx.warnings.push(`<${tag}> 的属性 ${shown} 不在白名单,已丢弃`);
			continue;
		}
		if (name === "href") {
			const value = attr.value.trim();
			if (!FRAGMENT_REF_RE.test(value)) {
				ctx.warnings.push(`<${tag}> 的 href「${attr.value}」不是 #片段引用,已丢弃`);
				continue;
			}
			if (hasHref) continue;
			hasHref = true;
			out.push({ name: "href", value });
			continue;
		}
		if (name === "id") {
			if (!SVG_ID_RE.test(attr.value)) {
				ctx.warnings.push(`<${tag}> 的 id「${attr.value}」不是合法标识符,已丢弃`);
				continue;
			}
			ctx.ids.push(attr.value);
			out.push({ name, value: attr.value });
			continue;
		}
		if (name === "class") {
			const cleaned = cleanClass(tag, attr.value, ctx);
			if (cleaned) out.push(cleaned);
			continue;
		}
		if (name === "style") {
			const cleaned = cleanStyle(tag, attr.value, ctx);
			if (cleaned) out.push(cleaned);
			continue;
		}
		if (!SVG_ATTRS.has(name)) {
			ctx.warnings.push(`<${tag}> 的属性 ${name} 不在白名单,已丢弃`);
			continue;
		}
		if (HAS_URL_RE.test(attr.value)) {
			const m = URL_FRAGMENT_RE.exec(attr.value.trim());
			if (!m) {
				ctx.warnings.push(`<${tag}> 的 ${name}「${attr.value}」里的 url() 只准指向 #片段,已丢弃`);
				continue;
			}
			out.push({ name, value: `url(#${m[1]})` });
			continue;
		}
		out.push({ name, value: attr.value });
	}
	return out;
}

/** 过滤一个 HTML 元素的属性;返回 null = 这个元素整个丢掉。 */
function filterAttrs(el: Element, ctx: Ctx): Token.Attribute[] | null {
	const tag = el.tagName;
	const allowed = EXTRA_ATTRS.get(tag) ?? null;
	/** `src` 先判:它不合格时整个 `<img>` 就没了,后面的属性连看都不用看。 */
	let srcValue: string | null = null;
	if (tag === "img") {
		const src = el.attrs.find((a) => a.name === "src");
		if (!src) {
			ctx.warnings.push("<img> 没有 src,整个丢弃");
			return null;
		}
		const verdict = checkSrc(src.value, ctx);
		if ("reason" in verdict) {
			ctx.warnings.push(`<img> 的 ${verdict.reason},整个丢弃`);
			return null;
		}
		srcValue = verdict.value;
	}

	const out: Token.Attribute[] = [];
	for (const attr of el.attrs) {
		const name = attr.name;
		// 有命名空间的属性(`xlink:href` 那一类)连名字都对不上白名单,顺带被这一问拦下。
		if (!COMMON_ATTRS.has(name) && !(allowed?.has(name) ?? false)) {
			ctx.warnings.push(`<${tag}> 的属性 ${name} 不在白名单,已丢弃`);
			continue;
		}
		if (name === "colspan" || name === "rowspan") {
			if (!SPAN_RE.test(attr.value.trim())) {
				ctx.warnings.push(`<${tag}> 的 ${name}「${attr.value}」不是正整数,已丢弃`);
				continue;
			}
			out.push({ name, value: attr.value.trim() });
			continue;
		}
		if (name === "src") {
			out.push({ name, value: srcValue as string });
			continue;
		}
		if (name === "alt") {
			checkPlaceholders(attr.value, ctx);
			out.push({ name, value: attr.value });
			continue;
		}
		if (name === "class") {
			const cleaned = cleanClass(tag, attr.value, ctx);
			if (cleaned) out.push(cleaned);
			continue;
		}
		const cleaned = cleanStyle(tag, attr.value, ctx);
		if (cleaned) out.push(cleaned);
	}
	return out;
}

/** 往新树里逐个搬认识的节点;不认识的标签**连子树一起**留在原地不搬。 */
function rebuild(nodes: readonly ChildNode[], parent: ParentNode, ctx: Ctx): void {
	for (const node of nodes) {
		if (defaultTreeAdapter.isTextNode(node)) {
			checkPlaceholders(node.value, ctx);
			defaultTreeAdapter.insertText(parent, node.value);
			continue;
		}
		// 注释 / doctype:静默丢弃(不是威胁,也没有保留的理由)。
		if (!defaultTreeAdapter.isElementNode(node)) continue;
		const tag = node.tagName;
		const ns = node.namespaceURI;
		// 两张白名单按命名空间各查各的;MathML 这种第三个命名空间没有表,整个丢。
		if (ns === htmlNs.NS.SVG && SVG_TAGS.has(tag)) {
			const el = defaultTreeAdapter.createElement(tag, ns, filterSvgAttrs(node, ctx));
			defaultTreeAdapter.appendChild(parent, el);
			rebuild(node.childNodes, el, ctx);
			continue;
		}
		if (ns !== htmlNs.NS.HTML || !ALLOWED_TAGS.has(tag)) {
			ctx.warnings.push(`<${tag}> 不在标签白名单,连同里面的内容一起丢弃`);
			continue;
		}
		const attrs = filterAttrs(node, ctx);
		if (attrs === null) continue;
		const el = defaultTreeAdapter.createElement(tag, htmlNs.NS.HTML, attrs);
		defaultTreeAdapter.appendChild(parent, el);
		rebuild(node.childNodes, el, ctx);
	}
}

/**
 * 清洗一个自定义块的 HTML。
 *
 * 宽容模式与 CSS 那一层同哲学:非法标签 / 属性 / 声明**逐项丢弃并出 warning**。
 * `ok:false` 只有三种:超 {@link CARD_SKIN_LIMITS.maxHtmlBytes}、占位符指向不存在的
 * 字段、清洗后为空 —— 前两种是作者一定想知道的,第三种说明这个块画出来什么都没有。
 */
export function sanitizeCardBlockHtml(
	input: string,
	opts: SanitizeCardHtmlOptions,
): SanitizeCardHtmlResult {
	const max = CARD_SKIN_LIMITS.maxHtmlBytes;
	// 按 UTF-8 字节算,不是 `input.length` —— 那是 UTF-16 单元数,一个汉字才记 1。
	if (Buffer.byteLength(input, "utf8") > max) {
		return { ok: false, errors: [`自定义 HTML 超过 ${max / 1024}KB 上限`] };
	}

	const ctx: Ctx = {
		kind: opts.kind,
		assets: opts.assets,
		fields: new Map(CARD_SKIN_FIELDS[opts.kind].map((f) => [f.path, f.type])),
		warnings: [],
		unknownPaths: new Set(),
		ids: [],
	};

	const source = parseFragment(input);
	const out = defaultTreeAdapter.createDocumentFragment();
	rebuild(source.childNodes, out, ctx);

	if (ctx.unknownPaths.size > 0) {
		return {
			ok: false,
			errors: [...ctx.unknownPaths].map((p) => `占位符「{${p}}」不在 ${opts.kind} 卡的字段表里`),
		};
	}

	const html = serialize(out);
	if (html.trim() === "") return { ok: false, errors: ["清洗后这个块什么都不剩"] };
	// 上限量的也是**存盘那份**:转义会让文本变长(`&` → `&amp;`),所以产物得自己再过一次闸。
	if (Buffer.byteLength(html, "utf8") > max) {
		return { ok: false, errors: [`清洗后的 HTML 超过 ${max / 1024}KB 上限`] };
	}
	return { ok: true, html, warnings: ctx.warnings, ids: ctx.ids };
}
