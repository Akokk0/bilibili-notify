/**
 * 皮肤 CSS 清洗层 —— **白名单制**:只放行认识的选择器/属性/at-rule,不是过滤坏的。
 * 用 css-tree 真 parser 走 AST,不碰正则黑名单(那条路上次 grilling 已论证写不全)。
 *
 * 红线(二轮 grilling 定案):
 * - 选择器只准 `[data-bn="<hook>"]`(hook ∈ SKIN_CSS_HOOK_MAP)+ 伪类/伪元素/组合器
 * - 声明只放行视觉属性;position 禁 fixed/sticky;伪元素 content 只准空串/none;
 *   pointer-events / display / visibility 等欺骗面不开
 * - 值里任何取网函数(url/image-set/element/src)→ 丢弃该声明
 * - @keyframes 名必须 `skin-` 前缀(不撞内置 bn-* 动画);@media 递归清洗;其余 at-rule 丢弃
 *
 * 宽容模式:非法项逐条丢弃并出 warning(AI 生成常夹带一两条违禁,整包拒收太挫败);
 * 只有超体积才 error。输出是**重新序列化**的产物 —— 存盘的永远是清洗后的 CSS,
 * 且保留 hook 形式不翻译(翻译在 web 注入层做,内部选择器重构不固化进存量皮肤)。
 */

import { SKIN_CSS_HOOK_MAP } from "@bilibili-notify/contract";
import type { Atrule, CssNode, Declaration, Rule } from "css-tree";
// 走自包含 dist bundle,不走默认入口:默认入口的 lexer 数据层在运行时
// require('../data/patch.json') 读包内文件,内联进 server bundle 后必炸
// (assemble-server-bundle.test 拦到的正是它);dist 版数据全内联,无此雷。
import { generate, parse } from "css-tree/dist/csstree.esm";

export const MAX_SKIN_CSS_BYTES = 64 * 1024;

export type SanitizeCssResult =
	| { ok: true; css: string; warnings: string[] }
	| { ok: false; errors: string[] };

const HOOKS = new Set(Object.keys(SKIN_CSS_HOOK_MAP));

const PSEUDO_CLASSES = new Set([
	"hover",
	"focus",
	"focus-visible",
	"focus-within",
	"active",
	"first-child",
	"last-child",
	"nth-child",
	"nth-of-type",
]);
const PSEUDO_ELEMENTS = new Set(["before", "after"]);

/** 精确属性白名单(视觉层)。 */
const EXACT_PROPS = new Set([
	"background",
	"color",
	"opacity",
	"box-shadow",
	"text-shadow",
	"filter",
	"backdrop-filter",
	"-webkit-backdrop-filter",
	"mix-blend-mode",
	"clip-path",
	"transform",
	"transform-origin",
	"rotate",
	"scale",
	"translate",
	"inset",
	"top",
	"right",
	"bottom",
	"left",
	"width",
	"height",
	"min-width",
	"min-height",
	"max-width",
	"max-height",
	"position",
	"z-index",
	"content",
	"transition",
	"animation",
	"border",
	"outline",
	"border-radius",
]);
/** 家族前缀白名单(border-* / background-* / …)。 */
const PROP_PREFIXES = ["background-", "border-", "outline-", "transition-", "animation-"];

/** 值里的取网/执行面函数 —— 出现即丢该声明。 */
const FORBIDDEN_VALUE = ["url(", "image-set(", "element(", "expression(", "src("];

const POSITION_VALUES = new Set(["static", "relative", "absolute"]);
const KEYFRAMES_NAME_RE = /^skin-[a-z0-9_-]+$/i;

function isAllowedProp(prop: string): boolean {
	const p = prop.toLowerCase();
	return EXACT_PROPS.has(p) || PROP_PREFIXES.some((prefix) => p.startsWith(prefix));
}

function valueOfAttr(value: CssNode | null): string | null {
	if (!value) return null;
	if (value.type === "String") return value.value.replace(/^["']|["']$/g, "");
	if (value.type === "Identifier") return value.name;
	return null;
}

/**
 * 这一支选择器瞄的是伪元素吗。
 *
 * 装饰性伪元素永远在内容之下、永远不吃点击(见 {@link forceDecorationBehindContent}),这个
 * 判断是那道保险的触发条件。
 */
function targetsPseudoElement(selector: CssNode): boolean {
	if (selector.type !== "Selector") return false;
	let hit = false;
	selector.children.forEach((node: CssNode) => {
		if (node.type === "PseudoElementSelector") hit = true;
	});
	return hit;
}

/**
 * 往声明块尾部塞上装饰层的两句硬规矩:`pointer-events:none` + `z-index:-1`。
 *
 * 在**过滤之后**才塞:两句都是这一层说了算 —— `pointer-events` 不在白名单里(过滤
 * 会把皮肤想抢回来的 `auto` 丢掉),`z-index` 在白名单里但皮肤写的那个值排在前面,
 * 被后到的这句压掉。
 *
 * 为什么 `z-index:-1` 也是硬规矩:装饰性伪元素带 `position:absolute` 时会画进「定位
 * 后代」那一层,也就是压在宿主所有非定位内容**之上**。真机上撞的(2026-08-19
 * 「樱墨 · Sakura Ink」):一层再标准不过的卡面高光糊住了顶栏和每张卡的文字与按钮,
 * 主人看到的是「像蒙了一层,很虚」。装饰就该在内容之下,这不是设计选择。
 */
function forceDecorationBehindContent(rule: Rule): void {
	const block = rule.block;
	if (!block) return;
	for (const text of ["pointer-events:none", "z-index:-1"]) {
		const decl = parse(text, { context: "declaration" }) as CssNode;
		if (decl.type === "Declaration") block.children.push(decl);
	}
}

/** 单个 Selector(逗号列表的一支)是否全由白名单件组成。 */
function isAllowedSelector(selector: CssNode): boolean {
	if (selector.type !== "Selector") return false;
	let ok = true;
	let parts = 0;
	selector.children.forEach((node: CssNode) => {
		parts += 1;
		switch (node.type) {
			case "AttributeSelector": {
				const hook = valueOfAttr(node.value);
				if (
					node.name.name !== "data-bn" ||
					(node.matcher !== "=" && node.matcher !== "~=") ||
					hook === null ||
					!HOOKS.has(hook)
				) {
					ok = false;
				}
				break;
			}
			case "PseudoClassSelector":
				if (!PSEUDO_CLASSES.has(node.name.toLowerCase())) ok = false;
				break;
			case "PseudoElementSelector":
				if (!PSEUDO_ELEMENTS.has(node.name.toLowerCase())) ok = false;
				break;
			case "Combinator":
				break;
			default:
				ok = false;
		}
	});
	return ok && parts > 0;
}

/**
 * 声明级过滤;返回 null = 放行,字符串 = 丢弃原因。
 *
 * `isPseudo` = 这条规则瞄的是伪元素。宿主的 `position` 一律拒收(理由见
 * {@link filterRuleList} 上方那段),伪元素自己的照旧放行。
 */
function rejectDeclaration(decl: Declaration, isPseudo: boolean): string | null {
	const prop = decl.property.toLowerCase();
	if (!isAllowedProp(prop)) return `属性 ${prop} 不在白名单`;
	const value = generate(decl.value).toLowerCase();
	for (const bad of FORBIDDEN_VALUE) {
		if (value.includes(bad)) return `属性 ${prop} 的值含 ${bad.slice(0, -1)}()`;
	}
	if (prop === "position") {
		if (!isPseudo) return `position 只归宿主本身的布局管,皮肤改不了(装饰层写在伪元素上)`;
		if (!POSITION_VALUES.has(value.trim())) return `position 只准 static/relative/absolute`;
	}
	if (prop === "content") {
		const v = value.trim();
		if (v !== `""` && v !== `''` && v !== "none") return `content 只准空串或 none`;
	}
	return null;
}

/** 过滤一个声明块:非法声明剔除。返回保留数。 */
function filterBlock(
	rule: Rule | Atrule,
	path: string,
	warnings: string[],
	isPseudo: boolean,
): number {
	const block = rule.block;
	if (!block) return 0;
	let kept = 0;
	const drop: CssNode[] = [];
	block.children.forEach((node: CssNode) => {
		if (node.type !== "Declaration") {
			drop.push(node);
			return;
		}
		const reason = rejectDeclaration(node, isPseudo);
		if (reason) {
			warnings.push(`${path}: ${reason},已丢弃`);
			drop.push(node);
		} else {
			kept += 1;
		}
	});
	for (const node of drop) {
		block.children.forEach((child, item) => {
			if (child === node) block.children.remove(item);
		});
	}
	return kept;
}

/** keyframes 内部:每个 keyframe 块只过声明白名单(from/to/百分比选择器无风险)。 */
function filterKeyframes(atrule: Atrule, path: string, warnings: string[]): void {
	atrule.block?.children.forEach((node: CssNode) => {
		// keyframe 块里没有宿主/装饰之分,position 照旧只按值域判。
		if (node.type === "Rule") filterBlock(node, path, warnings, true);
	});
}

/**
 * 顶层/媒体块的规则清单:就地过滤,返回是否还剩内容。
 *
 * **宿主与装饰的分界**在这里划:一条规则要么瞄宿主本身,要么瞄它的伪元素。
 * 宿主的布局(尤其 `position`)不归皮肤管 —— 顶栏是 `.bn-glass-strong` + Tailwind
 * 的 `sticky`,而皮肤 CSS 是**无层** author 样式、层的比较又发生在特异性之前,
 * 皮肤随手一句 `position:relative` 就能把 `position:sticky` 顶掉。装饰层要的定位
 * 祖先由注入层在 `@layer components` 里给(见 web 的 composeSkinCss),那一层排在
 * utilities 之前,工具类照旧赢。
 */
function filterRuleList(
	parent: { children: import("css-tree").List<CssNode> },
	warnings: string[],
): boolean {
	const drop: CssNode[] = [];
	parent.children.forEach((node: CssNode) => {
		if (node.type === "Rule") {
			const prelude = node.prelude;
			const selectorText = generate(prelude);
			let allOk = prelude.type === "SelectorList";
			if (prelude.type === "SelectorList") {
				prelude.children.forEach((sel: CssNode) => {
					if (!isAllowedSelector(sel)) allOk = false;
				});
			}
			if (!allOk) {
				warnings.push(`选择器「${selectorText}」不在 hook 白名单,整条丢弃`);
				drop.push(node);
				return;
			}
			// 逗号列表里**每一支**都瞄伪元素才算装饰规则。混着写的
			// (`[data-bn="glass"],[data-bn="glass"]::before`)按宿主算 —— 否则那两句
			// 硬规矩会连宿主一起钉死,整张卡当场点不动。
			let pseudo = false;
			if (prelude.type === "SelectorList") {
				pseudo = true;
				prelude.children.forEach((sel: CssNode) => {
					if (!targetsPseudoElement(sel)) pseudo = false;
				});
			}
			if (filterBlock(node, selectorText, warnings, pseudo) === 0) {
				drop.push(node);
				return;
			}
			if (pseudo) forceDecorationBehindContent(node);
			return;
		}
		if (node.type === "Atrule") {
			const name = node.name.toLowerCase();
			if (name === "keyframes") {
				const kfName = node.prelude ? generate(node.prelude).trim() : "";
				if (!KEYFRAMES_NAME_RE.test(kfName)) {
					warnings.push(`@keyframes 名「${kfName}」必须以 skin- 开头,整段丢弃`);
					drop.push(node);
					return;
				}
				filterKeyframes(node, `@keyframes ${kfName}`, warnings);
				return;
			}
			if (name === "media") {
				if (!node.block || !filterRuleList(node.block, warnings)) {
					drop.push(node);
				}
				return;
			}
			warnings.push(`@${name} 不在白名单,整段丢弃`);
			drop.push(node);
			return;
		}
		// Raw(语法碎片)等其他节点:静默丢弃 —— parser 已尽力恢复,碎渣不进产物。
		drop.push(node);
	});
	for (const node of drop) {
		parent.children.forEach((child, item) => {
			if (child === node) parent.children.remove(item);
		});
	}
	return !parent.children.isEmpty;
}

export function sanitizeSkinCss(input: string): SanitizeCssResult {
	if (input.length > MAX_SKIN_CSS_BYTES) {
		return { ok: false, errors: [`自定义 CSS 超过 ${MAX_SKIN_CSS_BYTES / 1024}KB 上限`] };
	}
	if (input.trim() === "") return { ok: true, css: "", warnings: [] };

	let ast: CssNode;
	try {
		ast = parse(input, { parseCustomProperty: false });
	} catch (e) {
		return { ok: false, errors: [`CSS 解析失败:${(e as Error).message}`] };
	}
	if (ast.type !== "StyleSheet") return { ok: false, errors: ["CSS 顶层结构异常"] };

	const warnings: string[] = [];
	filterRuleList(ast, warnings);
	return { ok: true, css: generate(ast), warnings };
}
