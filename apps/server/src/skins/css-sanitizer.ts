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

import {
	SKIN_CSS_EXACT_PROPS,
	SKIN_CSS_HOOK_MAP,
	SKIN_CSS_PROP_PREFIXES,
	SKIN_LIMITS,
} from "@bilibili-notify/contract";
import type { Atrule, CssNode, Declaration, List, ListItem, Rule } from "css-tree";
// 走自包含 dist bundle,不走默认入口:默认入口的 lexer 数据层在运行时
// require('../data/patch.json') 读包内文件,内联进 server bundle 后必炸
// (assemble-server-bundle.test 拦到的正是它);dist 版数据全内联,无此雷。
import { generate, parse } from "css-tree/dist/csstree.esm";

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

/**
 * 属性白名单查表用的 Set —— 名单本身在契约里({@link SKIN_CSS_EXACT_PROPS}),
 * 两份造皮肤的提示词照同一份数据生成说明。这里只是把它转成 O(1) 的形状。
 */
const EXACT_PROPS = new Set<string>(SKIN_CSS_EXACT_PROPS);

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
	return EXACT_PROPS.has(p) || SKIN_CSS_PROP_PREFIXES.some((prefix) => p.startsWith(prefix));
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
 * 「装饰」的判定(能不能淡、能不能定位、pointer-events 怎么处置)都从这里起步;
 * 压在内容之下、不吃点击那两句硬规矩由注入层补(web `decorationGuardCss`),不落盘。
 */
function targetsPseudoElement(selector: CssNode): boolean {
	if (selector.type !== "Selector") return false;
	return selector.children.some((node: CssNode) => node.type === "PseudoElementSelector");
}

/** css-tree 的 List 只有 `some`,没有 `every` —— 反着用一次,别在调用处铺双重否定。 */
function everyChild(list: List<CssNode>, pred: (node: CssNode) => boolean): boolean {
	return !list.some((node: CssNode) => !pred(node));
}

/**
 * 单个 Selector(逗号列表的一支)是否全由白名单件组成,**且每一段都挂着 hook**。
 *
 * 后半句是硬要求,而且「每一段」这三个字是要紧的:
 *
 * - 光问「每个节点是不是白名单里的件」的话,`:hover` / `::before` 这种一个 hook
 *   都没有的选择器会全票通过 —— 它命中的是页面上**每一个**元素(2026-08-19 审计
 *   实测放行)。
 * - 只问「整支里有没有 hook」也不够:hook 管的只是它自己那一段,组合器一跨,后面
 *   那段就自由了。`[data-bn="page"] :hover` 有 hook、件件白名单,而 `page` 映射
 *   到 `body` —— 这条同样命中每一个元素,跟裸 `:hover` 一模一样(2026-08-24 审计
 *   实测放行)。
 *
 * 所以判据是**逐段**问:每个复合段(组合器切开的那一截)里都得有至少一个 hook。
 */
function isAllowedSelector(selector: CssNode): boolean {
	if (selector.type !== "Selector") return false;
	let ok = true;
	let parts = 0;
	/** 当前这一段(上一个组合器之后)里数到的 hook 数。 */
	let hooksHere = 0;
	let everySegmentHooked = true;
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
					hooksHere += 1;
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
				// 一段到此为止 —— 结账,重新开一段。
				if (hooksHere === 0) everySegmentHooked = false;
				hooksHere = 0;
				break;
			default:
				ok = false;
		}
	});
	if (hooksHere === 0) everySegmentHooked = false; // 最后一段
	return ok && parts > 0 && everySegmentHooked;
}

/**
 * 声明级过滤;返回 null = 放行,字符串 = 丢弃原因。
 *
 * `scope.pseudo` = 这条规则瞄的是伪元素,`scope.keyframes` = 它在 @keyframes 里。
 * 「装饰」= 伪元素**且不在** keyframes 里;宿主的 `position` 与低 `opacity` 一律
 * 拒收(理由见 {@link filterRuleList} 上方那段),装饰自己的照旧放行。
 */
function rejectDeclaration(decl: Declaration, scope: DeclScope): string | null {
	const prop = decl.property.toLowerCase();
	// **谁算「装饰」,只准有这一处口径**(下方 position/opacity 那几支同用;来历见
	// 那边的注释 —— 抄第二遍就是它破的方式)。
	const decoration = scope.pseudo && !scope.keyframes;
	// `pointer-events` 恒在白名单外,**这一层也不替装饰补它**:硬规矩(none + z-index:-1)
	// 由注入层独挑(web `decorationGuardCss`,带 !important,存量皮肤也压得住)。曾经
	// 是清洗时补进产物 —— 于是存盘/导出的 CSS 里躺着一句白名单外的声明,下一轮清洗
	// 对着自己上一轮的笔迹刷「已丢弃」(2026-08-25 主人导入自家导出的包,12 条)。
	// 不落盘,警告才永远指向作者真写了的东西。
	if (!isAllowedProp(prop)) return `属性 ${prop} 不在白名单`;
	const value = generate(decl.value).toLowerCase();
	// 反斜杠 = CSS 转义,而转义在 tokenizer 里**先于**ident 判定解开:`\75 rl(` 到
	// 浏览器手上就是 `url(`,下面那圈子串匹配一个字都看不见。白名单里没有哪个属性
	// 需要转义,整条拒掉最省事 —— schema.ts 的值校验一直是这个口径,这一层补上。
	if (value.includes("\\")) return `属性 ${prop} 的值含转义写法(反斜杠)`;
	for (const bad of FORBIDDEN_VALUE) {
		if (value.includes(bad)) return `属性 ${prop} 的值含 ${bad.slice(0, -1)}()`;
	}
	// 「装饰」的判定在函数顶部(唯一口径)。装饰层随便淡、随便定位 —— 它
	// pointer-events:none 且压在内容之下,骗不到人。keyframes 不算装饰:同一段
	// 动画挂得到宿主身上,而动画来源的声明优先级还压着普通作者声明。
	//
	// 这个判断以前在下面 position 那支被抄成了 `!scope.pseudo`(漏掉 keyframes),
	// 于是 `@keyframes skin-x{0%{position:relative}}` + 挂到 header 上,顶栏的
	// `position:sticky` 照样被顶掉 —— 正是这道闸要拦的那件事。抄第二遍就是它破的
	// 方式,所以收成一个变量。
	if (!decoration) {
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
		if (!decoration) {
			return scope.keyframes
				? `position 不准写进 @keyframes —— 那段动画挂得到宿主身上,会顶掉它的布局`
				: `position 只归宿主本身的布局管,皮肤改不了(装饰层写在伪元素上)`;
		}
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
		// `pseudo: true` 只是免掉「这条瞄的是谁」那一问(keyframe 块没有选择器);
		// 一并带上 `keyframes: true`,它才是决定「不算装饰」的那一位 —— 这段动画
		// 挂得到宿主身上,宿主那几条闸一条都不能松。
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
	const css = generate(ast);
	// **上限量的是存盘那份。** 入口那道只是粗筛(别把超大输入送进解析器);存盘的
	// 是产物。清洗如今只删不加(硬规矩不落盘),产物不会比原文长 —— 这道闸于是
	// 只防御「未来某个变换会膨胀」,常态下入口过了这里必过。
	if (Buffer.byteLength(css, "utf8") > MAX_SKIN_CSS_BYTES) {
		return {
			ok: false,
			errors: [`清洗后的 CSS 超过 ${MAX_SKIN_CSS_BYTES / 1024}KB 上限`],
		};
	}
	return { ok: true, css, warnings };
}

/**
 * 摘掉清洗层旧版烙进存盘产物的两句硬规矩(`pointer-events:none` / `z-index:-1`)。
 *
 * 烙印的签名是**成对**:当年两句一起补进同一条装饰规则,而保存路径过的是已洗
 * 内存,盘上残留不会只剩半句。所以 `z-index:-1` 只在同规则还有 `pointer-events:
 * none` 时才算笔迹 —— 落单的它是作者升级后自己的声明,摘了就是让主人的字凭空
 * 消失。`pointer-events` 不在白名单、作者经编辑器写不进来,单独出现也摘。
 *
 * v0.7.0 及之前,这两句由清洗层补进产物再落盘;它们在白名单外(pointer-events),
 * 于是每次再清洗都对着自己上一轮的笔迹刷「已丢弃」警告。硬规矩挪去注入层之后,
 * 存量文件里的烙印靠这里在**读盘进索引时**摘掉 —— 内存与导出立即干净,磁盘在
 * 下一次保存时自然升级,不主动回写(与 active.json 旧格式迁移同一套哲学)。
 *
 * 摘不动(解析失败等)就原样返回:这是清洁工,不是守门员 —— 拦截是清洗层的事。
 */
export function stripDecorationResidue(css: string): string {
	if (!css.includes("pointer-events") && !css.includes("z-index")) return css;
	let ast: CssNode;
	try {
		ast = parse(css, { parseCustomProperty: false });
	} catch {
		return css;
	}
	if (ast.type !== "StyleSheet") return css;
	let changed = false;
	const stripIn = (list: List<CssNode>, inKeyframes: boolean): void => {
		list.forEach((node: CssNode) => {
			if (node.type === "Atrule") {
				const block = node.block;
				if (block) stripIn(block.children, node.name.toLowerCase() === "keyframes");
				return;
			}
			if (node.type !== "Rule" || inKeyframes) return;
			const prelude = node.prelude;
			// 与过滤层同一口径(everyChild + targetsPseudoElement):烙印当年就是按这个
			// 判定落进去的,摘的时候差一个字就漏。
			const pseudo =
				prelude.type === "SelectorList" && everyChild(prelude.children, targetsPseudoElement);
			if (!pseudo || !node.block) return;
			let hasBrandPair = false;
			node.block.children.forEach((decl: CssNode) => {
				if (decl.type !== "Declaration") return;
				if (
					decl.property.toLowerCase() === "pointer-events" &&
					generate(decl.value).trim().toLowerCase() === "none"
				) {
					hasBrandPair = true;
				}
			});
			const drop: ListItem<CssNode>[] = [];
			node.block.children.forEach((decl: CssNode, item) => {
				if (decl.type !== "Declaration") return;
				const prop = decl.property.toLowerCase();
				const value = generate(decl.value).trim().toLowerCase();
				if (
					(prop === "pointer-events" && value === "none") ||
					(prop === "z-index" && value === "-1" && hasBrandPair)
				) {
					drop.push(item);
				}
			});
			for (const item of drop) node.block.children.remove(item);
			if (drop.length > 0) changed = true;
		});
	};
	stripIn((ast as CssNode & { children: List<CssNode> }).children, false);
	return changed ? generate(ast) : css;
}
