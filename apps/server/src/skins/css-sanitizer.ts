/**
 * 皮肤 CSS 清洗层 —— **白名单制**:只放行认识的选择器/属性/at-rule,不是过滤坏的。
 * 用 css-tree 真 parser 走 AST,不碰正则黑名单(那条路上次 grilling 已论证写不全)。
 *
 * 红线(二轮 grilling 定案):
 * - 选择器只准 `[data-bn="<hook>"]`(hook ∈ SKIN_CSS_HOOK_MAP)+ 伪类/伪元素/组合器
 * - 声明只放行视觉属性;position 禁 fixed/sticky;伪元素 content 只准空串/none;
 *   pointer-events / display / visibility 不开,宿主的 opacity 有下限
 *   ({@link HOST_OPACITY_FLOOR})—— 收的是「看不见却点得到」这一类。**注意这不是
 *   「皮肤无法欺骗」**:`background:transparent;color:transparent` 一样让按钮隐形,
 *   而那是主题系统的固有能力,拦不掉也不该拦。装皮肤 = 信任那套皮肤。
 * - 值里任何取网函数(url/image-set/element/src)→ 丢弃该声明;**值里出现反斜杠
 *   一律丢弃** —— 转义在 tokenizer 里先于 ident 判定解开,`\75 rl(` 就是 `url(`
 * - @keyframes 名必须 `skin-` 前缀(不撞内置 bn-* 动画);@media 递归清洗;其余 at-rule 丢弃
 *
 * 宽容模式:非法项逐条丢弃并出 warning(AI 生成常夹带一两条违禁,整包拒收太挫败);
 * 只有超体积才 error。输出是**重新序列化**的产物 —— 存盘的永远是清洗后的 CSS,
 * 且保留 hook 形式不翻译(翻译在 web 注入层做,内部选择器重构不固化进存量皮肤)。
 */

import { SKIN_CSS_HOOK_MAP, SKIN_LIMITS } from "@bilibili-notify/contract";
import type { Atrule, CssNode, Declaration, List, ListItem, Rule } from "css-tree";
// 走自包含 dist bundle,不走默认入口:默认入口的 lexer 数据层在运行时
// require('../data/patch.json') 读包内文件,内联进 server bundle 后必炸
// (assemble-server-bundle.test 拦到的正是它);dist 版数据全内联,无此雷。
import { clone, generate, parse } from "css-tree/dist/csstree.esm";

/**
 * 自定义 CSS 的上限,**按 UTF-8 字节算**。
 *
 * 别写成 `input.length` —— 那是 UTF-16 单元数,一个汉字才记 1。皮肤里的中文注释
 * 一多,64K「字符」落到盘上就是将近 192KB,写出去的量是这条闸声称拦住的三倍。
 */
export const MAX_SKIN_CSS_BYTES = SKIN_LIMITS.maxCssBytes;

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
	// 像素风皮肤的必需件:关掉浏览器对壁纸/头像的平滑插值,低分辨率点阵才有硬边。
	// 是白名单里**唯一继承的**属性 —— 写在 `page`(=body)上会传给整棵子树,而那
	// 正是它的正经用法(整站一起像素化)。不取网、不吃点击、不动布局,无安全面。
	"image-rendering",
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

/**
 * 宿主的透明度下限。低于它就是「看不见、但点得到」—— UI 欺骗的起手式,而
 * `visibility` / `display` 这些**更温和**的隐身法本来就不在白名单里,放行 opacity
 * 等于挡了安全的那个、开了危险的那个。
 *
 * 这道闸**不封闭**,也封不闭:`background:transparent;color:transparent` 同样让
 * 一颗按钮隐形,而那是主题系统的固有能力。这里堵的是最顺手的那条路,不是宣称
 * 「皮肤无法欺骗」。
 */
const HOST_OPACITY_FLOOR = 0.15;

/** 读得懂的字面透明度(`0.4` / `40%`);读不懂 → null。 */
function literalOpacity(raw: string): number | null {
	const m = /^(\d*\.?\d+)(%?)$/.exec(raw.trim());
	if (!m) return null;
	const n = Number(m[1]);
	if (!Number.isFinite(n)) return null;
	return m[2] === "%" ? n / 100 : n;
}

/**
 * 声明所处的位置 —— 两件事各有各的判据,不能共用一个布尔。
 *
 * `pseudo` 管 position(宿主的布局不归皮肤);`keyframes` 管透明度:一段
 * `@keyframes` 挂得到宿主身上,所以里面的 opacity 必须按宿主从严,哪怕
 * keyframe 块本身按「装饰」放行 position。
 */
interface DeclScope {
	pseudo: boolean;
	keyframes: boolean;
}

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
	return selector.children.some((node: CssNode) => node.type === "PseudoElementSelector");
}

/** css-tree 的 List 只有 `some`,没有 `every` —— 反着用一次,别在调用处铺双重否定。 */
function everyChild(list: List<CssNode>, pred: (node: CssNode) => boolean): boolean {
	return !list.some((node: CssNode) => !pred(node));
}

/** 装饰层那两句硬规矩的 AST —— 解析结果恒定,没必要每条规则重跑一遍 parser。 */
const DECORATION_DECLS: readonly Declaration[] = ["pointer-events:none", "z-index:-1"].map(
	(text) => parse(text, { context: "declaration" }) as Declaration,
);

/** 这两句由本层说了算,块里皮肤自己写的同名声明一律先摘掉。 */
const DECORATION_PROPS: ReadonlySet<string> = new Set(
	DECORATION_DECLS.map((d) => d.property.toLowerCase()),
);

/**
 * 往声明块尾部塞上装饰层的两句硬规矩:`pointer-events:none` + `z-index:-1`。
 *
 * 在**过滤之后**才塞,而且**先摘掉块里已有的同名声明**:两句都是这一层说了算,
 * 皮肤写的 `z-index:99` 也好 `pointer-events:auto` 也好,一概不留。
 *
 * 为什么是摘掉而不是「排在它后面靠后到者赢」(原来的做法):**存盘的是清洗后的
 * 产物**,下次保存还要再过一遍这里。`pointer-events` 不在白名单、过滤会先把上一轮
 * 那条删掉,所以它恒为一条;而 `z-index` 在白名单里、过滤放行,于是每保存一次就
 * 多攒一条 —— 真机上「超天酱 · 像素窗口」攒到了 84 条(12 处伪元素 × 7 轮)。
 * CSS 行为上无害(同名后者覆盖前者,值还都一样),但文件在无限长胖,而主人翻
 * 「本模式 CSS」看到的是一屏垃圾。摘掉之后这一层就是幂等的。
 *
 * 为什么 `z-index:-1` 也是硬规矩:装饰性伪元素带 `position:absolute` 时会画进「定位
 * 后代」那一层,也就是压在宿主所有非定位内容**之上**。真机上撞的(2026-08-19
 * 「樱墨 · Sakura Ink」):一层再标准不过的卡面高光糊住了顶栏和每张卡的文字与按钮,
 * 主人看到的是「像蒙了一层,很虚」。装饰就该在内容之下,这不是设计选择。
 */
function forceDecorationBehindContent(rule: Rule): void {
	const block = rule.block;
	if (!block) return;
	const stale: ListItem<CssNode>[] = [];
	block.children.forEach((node: CssNode, item) => {
		if (node.type === "Declaration" && DECORATION_PROPS.has(node.property.toLowerCase())) {
			stale.push(item);
		}
	});
	for (const item of stale) block.children.remove(item);
	// 每条装饰规则都要这两句,而两句本身是常量 —— 解析一次留着,用时 clone。
	// 直接共享节点的话,同一个 AST 对象会挂在多处子树上,谁改它就一起变。
	for (const decl of DECORATION_DECLS) block.children.push(clone(decl));
}

/**
 * 单个 Selector(逗号列表的一支)是否全由白名单件组成,**且真的挂着 hook**。
 *
 * 后半句是硬要求:光问「每个节点是不是白名单里的件」的话,`:hover` / `::before`
 * 这种一个 hook 都没有的选择器会全票通过 —— 而它命中的是页面上**每一个**元素,
 * 整个 hook 契约当场绕开(2026-08-19 审计实测放行)。
 */
function isAllowedSelector(selector: CssNode): boolean {
	if (selector.type !== "Selector") return false;
	let ok = true;
	let parts = 0;
	let hooks = 0;
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
				} else {
					hooks += 1;
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
	return ok && parts > 0 && hooks > 0;
}

/**
 * 声明级过滤;返回 null = 放行,字符串 = 丢弃原因。
 *
 * `scope.pseudo` = 这条规则瞄的是伪元素。宿主的 `position` 一律拒收(理由见
 * {@link filterRuleList} 上方那段),伪元素自己的照旧放行。
 */
function rejectDeclaration(decl: Declaration, scope: DeclScope): string | null {
	const prop = decl.property.toLowerCase();
	if (!isAllowedProp(prop)) return `属性 ${prop} 不在白名单`;
	const value = generate(decl.value).toLowerCase();
	// 反斜杠 = CSS 转义,而转义在 tokenizer 里**先于**ident 判定解开:`\75 rl(` 到
	// 浏览器手上就是 `url(`,下面那圈子串匹配一个字都看不见。白名单里没有哪个属性
	// 需要转义,整条拒掉最省事 —— schema.ts 的值校验一直是这个口径,这一层补上。
	if (value.includes("\\")) return `属性 ${prop} 的值含转义写法(反斜杠)`;
	for (const bad of FORBIDDEN_VALUE) {
		if (value.includes(bad)) return `属性 ${prop} 的值含 ${bad.slice(0, -1)}()`;
	}
	// 装饰层随便淡 —— 它 pointer-events:none 且压在内容之下,淡到看不见也骗不到人。
	// keyframes 不算装饰:同一段动画挂得到宿主身上。
	if (!(scope.pseudo && !scope.keyframes)) {
		if (prop === "opacity") {
			const n = literalOpacity(value);
			if (n === null || n < HOST_OPACITY_FLOOR) {
				return `宿主的 opacity 只准写不低于 ${HOST_OPACITY_FLOOR} 的字面值(看不见却点得到 = UI 欺骗)`;
			}
		}
		// filter:opacity() 是同一把锁的另一把钥匙,漏掉它上面那道闸一绕就过。
		// **每一个**都要问 —— filter 的函数是相乘的,`opacity(1) opacity(0)` 结果
		// 还是 0,只读第一个等于没读(2026-08-19 审计实测穿过)。
		if (prop === "filter") {
			for (const m of value.matchAll(/opacity\(([^)]*)\)/g)) {
				const n = literalOpacity(m[1] ?? "");
				if (n === null || n < HOST_OPACITY_FLOOR) {
					return `宿主的 filter:opacity() 只准写不低于 ${HOST_OPACITY_FLOOR} 的字面值(同上)`;
				}
			}
		}
	}
	if (prop === "position") {
		if (!scope.pseudo) return `position 只归宿主本身的布局管,皮肤改不了(装饰层写在伪元素上)`;
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
	scope: DeclScope,
): number {
	const block = rule.block;
	if (!block) return 0;
	let kept = 0;
	// 收 item 而不是 node:`forEach` 的第二个参数就是能直接 remove 的链表句柄,
	// 收 node 的话收尾还得为每个丢弃项把整条 children 重扫一遍去找它。
	const drop: ListItem<CssNode>[] = [];
	block.children.forEach((node: CssNode, item) => {
		if (node.type !== "Declaration") {
			drop.push(item);
			return;
		}
		const reason = rejectDeclaration(node, scope);
		if (reason) {
			warnings.push(`${path}: ${reason},已丢弃`);
			drop.push(item);
		} else {
			// `!important` 一律摘掉,只留声明本身。装饰层那两句硬规矩是**追加**在块
			// 尾部的,靠「后到者赢」压过皮肤写的值 —— 而 !important 不吃这一套:
			// 实测 `z-index:99 !important` 让后面的 `z-index:-1` 完全失效,装饰照旧
			// 糊在内容之上(「樱墨」那次的症状)。皮肤 CSS 本来就是 author 层、本来
			// 就生效,!important 在这里没有正当用途,只会把布局的账搅乱。
			if (node.important) {
				node.important = false;
				warnings.push(`${path}: 属性 ${node.property.toLowerCase()} 的 !important 已摘掉`);
			}
			kept += 1;
		}
	});
	for (const item of drop) block.children.remove(item);
	return kept;
}

/** keyframes 内部:每个 keyframe 块只过声明白名单(from/to/百分比选择器无风险)。 */
function filterKeyframes(atrule: Atrule, path: string, warnings: string[]): void {
	atrule.block?.children.forEach((node: CssNode) => {
		// keyframe 块里没有宿主/装饰之分,position 照旧只按值域判。
		if (node.type === "Rule") filterBlock(node, path, warnings, { pseudo: true, keyframes: true });
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
function filterRuleList(parent: { children: List<CssNode> }, warnings: string[]): boolean {
	const drop: ListItem<CssNode>[] = [];
	parent.children.forEach((node: CssNode, item) => {
		if (node.type === "Rule") {
			const prelude = node.prelude;
			const selectorText = generate(prelude);
			if (prelude.type !== "SelectorList" || !everyChild(prelude.children, isAllowedSelector)) {
				warnings.push(`选择器「${selectorText}」不在 hook 白名单,整条丢弃`);
				drop.push(item);
				return;
			}
			// 逗号列表里**每一支**都瞄伪元素才算装饰规则。混着写的
			// (`[data-bn="glass"],[data-bn="glass"]::before`)按宿主算 —— 否则那两句
			// 硬规矩会连宿主一起钉死,整张卡当场点不动。
			const pseudo = everyChild(prelude.children, targetsPseudoElement);
			if (filterBlock(node, selectorText, warnings, { pseudo, keyframes: false }) === 0) {
				drop.push(item);
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
					drop.push(item);
					return;
				}
				filterKeyframes(node, `@keyframes ${kfName}`, warnings);
				return;
			}
			if (name === "media") {
				if (!node.block || !filterRuleList(node.block, warnings)) {
					drop.push(item);
				}
				return;
			}
			warnings.push(`@${name} 不在白名单,整段丢弃`);
			drop.push(item);
			return;
		}
		// Raw(语法碎片)等其他节点:静默丢弃 —— parser 已尽力恢复,碎渣不进产物。
		drop.push(item);
	});
	for (const item of drop) parent.children.remove(item);
	return !parent.children.isEmpty;
}

export function sanitizeSkinCss(input: string): SanitizeCssResult {
	if (Buffer.byteLength(input, "utf8") > MAX_SKIN_CSS_BYTES) {
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
