/**
 * 常用旋钮读写的那一段 CSS(ADR-0014 决策 21)。
 *
 * 决策里那句「**不要旋钮值和 CSS 文本两份状态互相盖**」定死了做法:旋钮不自己存值,
 * 读的写的都是同一段文本。于是这一层只有一个判据 —— **改一枚旋钮,除了那一条声明,
 * 整段文本一个字节都不许动。**
 *
 * 所以**不走**「解析 → 改 AST → `generate` 重排」那条路:generate 出来的是规范化的紧凑
 * 形式,作者的换行、缩进、注释会被整段抹掉,而他正对着一个文本框打字。这里用 css-tree
 * 只为**定位**(`positions: true` 给出每个节点在原文里的偏移),改动落成对原字符串的切片
 * 拼接 —— 与服务端那份清洗器(它就是要规范化,所以用 generate)是两种目的、两种写法。
 */

import type { CssNode } from "css-tree";
import { parse, walk } from "css-tree/dist/csstree.esm";

/**
 * 旋钮管的那几条(决策 21 点名的「内边距 / 背景 / 圆角 / 边框 / 对齐 / 字号字色」)。
 * 顺序就是面板上的顺序。
 */
export const KNOB_PROPS = [
	"padding",
	"background",
	"border-radius",
	"border",
	"text-align",
	"font-size",
	"color",
] as const;

export type KnobProp = (typeof KNOB_PROPS)[number];

/** 读出来的值:键是属性名,值是**原文里那一截**(不是 generate 的规范形式)。 */
export type KnobReadout = Partial<Record<KnobProp, string>>;

interface Located {
	start: number;
	end: number;
}

interface FoundRule {
	/** 整条规则在原文里的范围。 */
	rule: Located;
	/** `{` 与 `}` 之间(含两个花括号)的范围。 */
	block: Located;
	/** 这条规则里的声明,按出现顺序。 */
	decls: Array<{ prop: string; whole: Located; value: Located }>;
}

function locOf(node: CssNode): Located | null {
	const loc = node.loc;
	return loc ? { start: loc.start.offset, end: loc.end.offset } : null;
}

/**
 * 这条选择器是不是**恰好**那一个挂点。
 *
 * 刻意严:只认「单独一条选择器 + 单独一个 `[data-bn=<挂点>]`」。`[data-bn="self"]:hover`
 * 与 `[data-bn="self"], [data-bn="glass"]` 都不算 —— 旋钮改的是「这一层自己在常态下
 * 长什么样」,顺手改掉 hover 或者另一个挂点都不是按下那枚旋钮的意思。
 */
function selectorIsHook(prelude: CssNode, hook: string): boolean {
	if (prelude.type !== "SelectorList") return false;
	const selectors = prelude.children.toArray();
	if (selectors.length !== 1) return false;
	const sel = selectors[0];
	if (!sel || sel.type !== "Selector") return false;
	const parts = sel.children.toArray();
	if (parts.length !== 1) return false;
	const attr = parts[0];
	if (!attr || attr.type !== "AttributeSelector") return false;
	if (attr.name.name !== "data-bn" || attr.matcher !== "=") return false;
	const v = attr.value;
	if (!v) return false;
	const text = v.type === "String" ? v.value : v.type === "Identifier" ? v.name : null;
	return text === hook;
}

/** 解析并找到**最后一条**指向这个挂点的规则(后来者赢,与 CSS 的层叠一致)。 */
function findRule(
	css: string,
	hook: string,
): { ok: true; found: FoundRule | null } | { ok: false } {
	let ast: CssNode;
	try {
		ast = parse(css, {
			positions: true,
			onParseError: (e: unknown) => {
				throw e;
			},
		});
	} catch {
		return { ok: false };
	}

	let found: FoundRule | null = null;
	walk(ast, {
		visit: "Rule",
		enter(node: CssNode) {
			if (node.type !== "Rule") return;
			if (!selectorIsHook(node.prelude, hook)) return;
			const rule = locOf(node);
			const block = locOf(node.block);
			if (!rule || !block) return;
			const decls: FoundRule["decls"] = [];
			for (const child of node.block.children.toArray()) {
				if (child.type !== "Declaration") continue;
				const whole = locOf(child);
				const value = locOf(child.value);
				if (!whole || !value) continue;
				decls.push({ prop: child.property.toLowerCase(), whole, value });
			}
			// 不 break:要的是**最后一条**匹配的规则。
			found = { rule, block, decls };
		},
	});
	return { ok: true, found };
}

/**
 * 读出这个挂点那条规则里的旋钮值。
 *
 * - `null` = 这段 CSS 解析不了 —— 面板据此把旋钮整排禁掉,而不是拿半份 AST 瞎猜;
 * - `{}` = 解析得了,但没有这条规则(或规则里一条旋钮管的声明都没有)。
 *
 * 值是**原文那一截**:`12px 16px` 这种旋钮表示不了的形状也照原样回,由面板决定怎么显示
 * —— 悄悄折成 `12px` 就等于把作者写的东西吃掉了。
 */
export function readKnobs(css: string, hook: string): KnobReadout | null {
	const r = findRule(css, hook);
	if (!r.ok) return null;
	const out: KnobReadout = {};
	if (!r.found) return out;
	for (const d of r.found.decls) {
		if ((KNOB_PROPS as readonly string[]).includes(d.prop)) {
			// 后写的盖前面的,与 CSS 一致。
			out[d.prop as KnobProp] = css.slice(d.value.start, d.value.end).trim();
		}
	}
	return out;
}

/** 从 `from` 起跳过空白,回第一个非空白字符的下标(越界回 `-1`)。 */
function skipSpaceForward(css: string, from: number): number {
	let i = from;
	while (i < css.length && /\s/.test(css[i] as string)) i++;
	return i < css.length ? i : -1;
}

/** 从 `from - 1` 往回跳过空白,回第一个非空白字符的下标(越界回 `-1`)。 */
function skipSpaceBackward(css: string, from: number): number {
	let i = from - 1;
	while (i >= 0 && /\s/.test(css[i] as string)) i--;
	return i;
}

/**
 * 改(或删)这个挂点那条规则里的一条声明,**只动那一截**。
 *
 * `value` 传 `null` 就是删掉这一条;删到规则空了连规则一起收走(不留一地空壳)。解析不了
 * 时**原样返回** —— 半份 AST 上算出来的偏移会把作者的文本切坏,那比不生效糟得多。
 */
export function setKnobDecl(
	css: string,
	hook: string,
	prop: KnobProp,
	value: string | null,
): string {
	const r = findRule(css, hook);
	if (!r.ok) return css;

	if (!r.found) {
		if (value === null) return css;
		const rule = `[data-bn="${hook}"]{${prop}:${value}}`;
		return css.trim() === "" ? rule : `${css}\n${rule}`;
	}

	const { rule, block, decls } = r.found;
	const mine = [...decls].reverse().find((d) => d.prop === prop);

	if (value !== null) {
		if (mine) {
			// 只换值那一截 —— 属性名、冒号、后面的注释与分号全留着。
			return css.slice(0, mine.value.start) + value + css.slice(mine.value.end);
		}
		// 这条不在:插在最后一条声明之后(没有声明就贴着 `{`)。
		const last = decls[decls.length - 1];
		const at = last ? last.whole.end : block.start + 1;
		const sep = last ? ";" : "";
		return `${css.slice(0, at)}${sep}${prop}:${value}${css.slice(at)}`;
	}

	if (!mine) return css;

	// 删:连它那个分号一起带走 —— 先看后面有没有,没有再吃前面那个,否则会剩下
	// `{;color:red}` 或 `{color:red;}`。
	let start = mine.whole.start;
	let end = mine.whole.end;
	const after = skipSpaceForward(css, end);
	if (after !== -1 && css[after] === ";") {
		end = after + 1;
	} else {
		const before = skipSpaceBackward(css, start);
		if (before >= 0 && css[before] === ";") start = before;
	}

	// 这是最后一条声明 → 整条规则没意义了,一起收走。
	if (decls.length === 1) {
		let ruleEnd = rule.end;
		if (css[ruleEnd] === "\n") ruleEnd += 1;
		return (css.slice(0, rule.start) + css.slice(ruleEnd)).trimEnd();
	}
	return css.slice(0, start) + css.slice(end);
}
