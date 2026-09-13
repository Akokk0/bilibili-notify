/**
 * **自定义块的 HTML 清洗层**(ADR-0014 决策 11 / 12)。
 *
 * 自定义块的内容是一个**受限 HTML 子集**:标签白名单 + 属性白名单 + `{a.b.c}` 占位符。
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

/** 标签白名单:排版壳 + 行内强调 + 换行 + 图。列表 / 标题 / 表格在卡片上没有用武之地。 */
const ALLOWED_TAGS = new Set([
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
]);

/** 所有标签共用的属性。`id` 不在里面 —— 卡片 DOM 的 id 归渲染器,皮肤不许占坑。 */
const COMMON_ATTRS = new Set(["class", "style"]);
/** `img` 额外多的两个。`srcset` / `loading` / `crossorigin` 一律不给。 */
const IMG_ATTRS = new Set(["src", "alt"]);

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
	| { ok: true; html: string; warnings: string[] }
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

/** 过滤一个元素的属性;返回 null = 这个元素整个丢掉。 */
function filterAttrs(el: Element, ctx: Ctx): Token.Attribute[] | null {
	const tag = el.tagName;
	const allowed = tag === "img" ? IMG_ATTRS : null;
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
			const tokens = attr.value.split(/\s+/).filter((t) => t !== "");
			if (tokens.length === 0 || !tokens.every((t) => CLASS_TOKEN_RE.test(t))) {
				ctx.warnings.push(`<${tag}> 的 class「${attr.value}」含不合法的 token,整个属性丢弃`);
				continue;
			}
			out.push({ name, value: tokens.join(" ") });
			continue;
		}
		// style:交给 CSS 那一层的声明级过滤 —— 同一份属性白名单、`url()` 拒、
		// `position` 拒(内联样式没有伪元素,「装饰」那一档整个不适用)。
		const cleaned = sanitizeDeclarationList(attr.value, { hostOpacityFloor: null });
		if (!cleaned) {
			ctx.warnings.push(`<${tag}> 的 style 解析不动,整个属性丢弃`);
			continue;
		}
		for (const w of cleaned.warnings) ctx.warnings.push(`<${tag}> 的 style: ${w}`);
		if (cleaned.css.trim() === "") continue;
		out.push({ name, value: cleaned.css });
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
		if (node.namespaceURI !== htmlNs.NS.HTML || !ALLOWED_TAGS.has(tag)) {
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
	return { ok: true, html, warnings: ctx.warnings };
}
