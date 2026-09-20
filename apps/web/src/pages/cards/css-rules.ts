/**
 * 结构化 CSS 编辑器的读写层(ADR-0014 决策 21 的 2026-09-19 🔗)。
 *
 * 七枚旋钮那条规矩推广到全部读写:**文本是唯一真源,每个操作只碰它该碰的那一截**,作者的
 * 换行、缩进、注释原样留着。所以这里仍然**不走** `generate`(它会把整段重排成规范形式),
 * css-tree 只用来定位 —— `positions: true` 给出每个节点在原文里的偏移,改动落成切片拼接。
 *
 * 两处 css-tree 帮不上、得自己来的:
 * - **注释不进 AST**(现查过,`parse` 直接丢掉 `Comment`),而注释正是女仆给人看的解释,
 *   结构视图要把它们当说明行摆出来。所以这里按原文自己扫 `/* … *​/` 的范围(跳过字符串里
 *   的),再按偏移分到「规则前面」与「块里面」两处。
 * - **值的偏移带尾随空白**(`color: #fff !important` 里 Value 的范围是 `#fff `),显示与
 *   替换都按去掉尾随空白的那一截算。
 */

import type { CssNode } from "css-tree";
import { parse, walk } from "css-tree/dist/csstree.esm";

interface Span {
	start: number;
	end: number;
}

export interface CssDecl {
	prop: string;
	/** 原文那一截(去掉尾随空白),不是规范形式。 */
	value: string;
	important: boolean;
	/** 整条声明(属性名到值 / `!important` 末尾,不含分号)。 */
	whole: Span;
	/** 值那一截(去掉尾随空白)。 */
	valueSpan: Span;
}

/** 块里的一样东西。`at` 是它在原文里的偏移 —— 位置就是身份,面板拿它当 key。 */
export type CssRuleItem =
	| { kind: "decl"; decl: CssDecl; at: number }
	| { kind: "comment"; text: string; at: number };

export interface CssRule {
	/** `{` 前面那一截原文(去掉首尾空白)。 */
	selector: string;
	/** 它套在哪个 at 规则里(`@media (…)`),顶层的没有。 */
	atRule?: string;
	/** 规则前面的注释(上一条规则 / 文件头到它之间)。 */
	notes: string[];
	/** 块里的东西,按位置排:声明与夹在中间的注释。 */
	items: CssRuleItem[];
	/** 只有声明,按位置排 —— 写操作按这里的下标找。 */
	decls: CssDecl[];
	rule: Span;
	prelude: Span;
	/** `{` 与 `}`(含两个花括号)。 */
	block: Span;
}

function locOf(node: CssNode): Span | null {
	const loc = node.loc;
	return loc ? { start: loc.start.offset, end: loc.end.offset } : null;
}

function parseOrNull(css: string): CssNode | null {
	try {
		return parse(css, {
			positions: true,
			onParseError: (e: unknown) => {
				throw e;
			},
		});
	} catch {
		return null;
	}
}

/**
 * 原文里所有注释的范围。跳过字符串里的 `/*`(`content:"/* 不是注释 *​/"`);转义在装包门
 * 就被拒了,这里不用管。
 */
function commentSpans(css: string): Array<Span & { text: string }> {
	const out: Array<Span & { text: string }> = [];
	let i = 0;
	while (i < css.length) {
		const ch = css[i];
		if (ch === '"' || ch === "'") {
			const close = css.indexOf(ch, i + 1);
			i = close === -1 ? css.length : close + 1;
			continue;
		}
		if (ch === "/" && css[i + 1] === "*") {
			const close = css.indexOf("*/", i + 2);
			const end = close === -1 ? css.length : close + 2;
			out.push({ start: i, end, text: css.slice(i + 2, close === -1 ? css.length : close).trim() });
			i = end;
			continue;
		}
		i++;
	}
	return out;
}

function trimEndSpan(css: string, span: Span): Span {
	let end = span.end;
	while (end > span.start && /\s/.test(css[end - 1] as string)) end--;
	return { start: span.start, end };
}

/**
 * 读出这段 CSS 的全部规则(含 at 规则里的),按出现顺序。`null` = 解析不了 —— 面板据此把
 * 结构视图让位给源码,而不是拿半份 AST 上算出来的偏移去切作者的文本。
 */
export function readRules(css: string): CssRule[] | null {
	const ast = parseOrNull(css);
	if (!ast) return null;
	const comments = commentSpans(css);
	const rules: CssRule[] = [];
	const atStack: string[] = [];
	walk(ast, {
		enter(node: CssNode) {
			if (node.type === "Atrule") {
				const preludeLoc = node.prelude ? locOf(node.prelude) : null;
				const head = preludeLoc ? css.slice(preludeLoc.start, preludeLoc.end).trim() : "";
				atStack.push(`@${node.name}${head ? ` ${head}` : ""}`);
				return;
			}
			if (node.type !== "Rule") return;
			const rule = locOf(node);
			const prelude = locOf(node.prelude);
			const block = locOf(node.block);
			if (!rule || !prelude || !block) return;
			const decls: CssDecl[] = [];
			for (const child of node.block.children.toArray()) {
				if (child.type !== "Declaration") continue;
				const whole = locOf(child);
				const value = locOf(child.value);
				if (!whole || !value) continue;
				const valueSpan = trimEndSpan(css, value);
				decls.push({
					prop: child.property.toLowerCase(),
					value: css.slice(valueSpan.start, valueSpan.end),
					important: child.important !== false,
					whole: trimEndSpan(css, whole),
					valueSpan,
				});
			}
			const inside = comments.filter((c) => c.start > block.start && c.end < block.end);
			const items: CssRuleItem[] = [
				...decls.map((decl) => ({ kind: "decl" as const, decl, at: decl.whole.start })),
				...inside.map((c) => ({ kind: "comment" as const, text: c.text, at: c.start })),
			].sort((a, b) => a.at - b.at);
			const entry: CssRule = {
				selector: css.slice(prelude.start, prelude.end).trim(),
				notes: [],
				items,
				decls,
				rule,
				prelude,
				block,
			};
			const at = atStack[atStack.length - 1];
			if (at !== undefined) entry.atRule = at;
			rules.push(entry);
		},
		leave(node: CssNode) {
			if (node.type === "Atrule") atStack.pop();
		},
	});
	// 规则前面的注释:从上一条规则结束(或文件头)到这条规则开始之间的。块里的已经分给
	// 它们所在的规则,这里只看规则外面的。
	let cursor = 0;
	for (const r of rules) {
		r.notes = comments.filter((c) => c.start >= cursor && c.end <= r.rule.start).map((c) => c.text);
		cursor = Math.max(cursor, r.rule.end);
	}
	return rules;
}

function ruleAt(css: string, ruleIndex: number): CssRule | null {
	return readRules(css)?.[ruleIndex] ?? null;
}

/** 改一条声明的值,只换值那一截(属性名、分号、行尾注释、`!important` 全留着)。 */
export function setDeclValue(
	css: string,
	ruleIndex: number,
	declIndex: number,
	value: string,
): string {
	const decl = ruleAt(css, ruleIndex)?.decls[declIndex];
	if (!decl) return css;
	return css.slice(0, decl.valueSpan.start) + value + css.slice(decl.valueSpan.end);
}

/** `from` 起(含)往前找到这一行的行首。 */
function lineStart(css: string, from: number): number {
	const nl = css.lastIndexOf("\n", from - 1);
	return nl === -1 ? 0 : nl + 1;
}

/** `from` 起(含)往后找到这一行的行尾(`\n` 的下标,没有就是文末)。 */
function lineEnd(css: string, from: number): number {
	const nl = css.indexOf("\n", from);
	return nl === -1 ? css.length : nl;
}

/** 这一行开头的缩进(空格 / 制表符)。 */
function indentOf(css: string, at: number): string {
	const start = lineStart(css, at);
	return /^[ \t]*/.exec(css.slice(start, at))?.[0] ?? "";
}

/**
 * 加一条声明,跟着这一块的写法走:多行块另起一行、缩进照最后一条声明,插在它那一行
 * (含行尾注释)之后;单行块紧贴最后一条补在后面。缺分号的先补上。
 *
 * **整段只 parse 一遍**:空的多行块那一支还要借别的规则的缩进,从前它自己再 parse 一次,
 * 于是一次「加上」最多要把同一段 CSS(上限 16KB)解析三遍,而三遍的结果逐字节相同。
 */
export function addDecl(css: string, ruleIndex: number, prop: string, value: string): string {
	const rules = readRules(css);
	const rule = rules?.[ruleIndex];
	if (!rules || !rule) return css;
	const { block, decls } = rule;
	const inner = css.slice(block.start + 1, block.end - 1);
	const multiline = inner.includes("\n");
	const last = decls[decls.length - 1];

	if (!multiline) {
		if (!last)
			return `${css.slice(0, block.start + 1)}${prop}:${value}${css.slice(block.start + 1)}`;
		const after = css.slice(last.whole.end).match(/^\s*;/);
		const at = last.whole.end + (after ? after[0].length : 0);
		const sep = after ? "" : ";";
		const tail = after ? ";" : "";
		return `${css.slice(0, at)}${sep}${prop}:${value}${tail}${css.slice(at)}`;
	}

	if (!last) {
		// 空的多行块:缩进跟着别的规则走,没有别的就一个制表符。
		const sibling = rules.find((r) => r.decls.length > 0)?.decls[0];
		const indent = sibling ? indentOf(css, sibling.whole.start) : "\t";
		return `${css.slice(0, block.start + 1)}\n${indent}${prop}: ${value};${css.slice(block.start + 1)}`;
	}
	// 先补分号(没有的话),再插在这一行的行尾之后 —— 行尾注释留在原来那条身上。
	let text = css;
	const after = text.slice(last.whole.end).match(/^\s*;/);
	if (!after) text = `${text.slice(0, last.whole.end)};${text.slice(last.whole.end)}`;
	const end = lineEnd(text, last.whole.end);
	const indent = indentOf(text, last.whole.start);
	return `${text.slice(0, end)}\n${indent}${prop}: ${value};${text.slice(end)}`;
}

/**
 * 删一条声明:多行块整行带走(含行尾注释),单行块连分号一起吃掉。删到块空了规则留着 ——
 * 删规则是另一个动作。
 */
export function removeDecl(css: string, ruleIndex: number, declIndex: number): string {
	const rule = ruleAt(css, ruleIndex);
	const decl = rule?.decls[declIndex];
	if (!rule || !decl) return css;
	const inner = css.slice(rule.block.start + 1, rule.block.end - 1);
	const ownLine =
		inner.includes("\n") &&
		css.slice(lineStart(css, decl.whole.start), decl.whole.start).trim() === "" &&
		rule.decls.every(
			(d) => d === decl || lineStart(css, d.whole.start) !== lineStart(css, decl.whole.start),
		);
	if (ownLine) {
		const start = lineStart(css, decl.whole.start);
		const end = lineEnd(css, decl.whole.end);
		return css.slice(0, start) + css.slice(end === css.length ? end : end + 1);
	}
	let start = decl.whole.start;
	let end = decl.whole.end;
	const after = css.slice(end).match(/^\s*;/);
	if (after) end += after[0].length;
	else {
		const before = css.slice(0, start).match(/;\s*$/);
		if (before) start -= before[0].length;
	}
	return css.slice(0, start) + css.slice(end);
}

/** 加一条空规则(多行空块),已有内容时空一行再放。 */
export function addRule(css: string, selector: string): string {
	const rule = `${selector} {\n}`;
	const head = css.replace(/\s+$/, "");
	return head === "" ? rule : `${head}\n\n${rule}`;
}

/** 删一条规则,连它前面那条空行一起收;前面的说明注释留着(那是作者写的字)。 */
export function removeRule(css: string, ruleIndex: number): string {
	const rule = ruleAt(css, ruleIndex);
	if (!rule) return css;
	let end = rule.rule.end;
	if (css[end] === "\n") end++;
	let out = css.slice(0, rule.rule.start) + css.slice(end);
	// 挖掉之后剩下的连着的空行压成一条;文末不留空行。
	out = out.replace(/\n{3,}/g, "\n\n").replace(/\n{2,}$/, "\n");
	return out;
}

/** 改选择器,只换 `{` 前面那一截。 */
export function setSelector(css: string, ruleIndex: number, selector: string): string {
	const rule = ruleAt(css, ruleIndex);
	if (!rule) return css;
	const span = trimEndSpan(css, rule.prelude);
	return css.slice(0, span.start) + selector + css.slice(span.end);
}
