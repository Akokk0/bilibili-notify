/**
 * 结构化 CSS 编辑器的读写层(ADR-0014 决策 21 的 2026-09-19 🔗)。
 *
 * 七枚旋钮那条「改一枚旋钮,除了那一条声明,整段文本一个字节都不许动」在这里推广成
 * 全部读写的唯一判据:每个操作只碰它该碰的那一截,作者的换行、缩进、注释原样留着。
 * 所以断言几乎全是**整段文本逐字相等** —— 只比「值改了没」的话,把 generate 重排塞进来
 * 照样绿。
 */

import { describe, expect, it } from "vite-plus/test";
import {
	addDecl,
	addRule,
	readRules,
	removeDecl,
	removeRule,
	setDeclValue,
	setSelector,
} from "../css-rules";

const MULTI = `/* 整块的底 */
[data-bn="self"] {
	/* 留白说明 */
	padding: 12px 16px; /* 行尾也算 */
	color: #fff !important;
}

[data-bn="avatar"]{border-radius:50%}
`;

describe("readRules —— 读出规则、声明与注释", () => {
	it("规则按出现顺序,选择器与值都是原文那一截(值去掉尾随空白)", () => {
		const rules = readRules(MULTI);
		expect(rules?.map((r) => r.selector)).toEqual(['[data-bn="self"]', '[data-bn="avatar"]']);
		expect(rules?.[0]?.decls.map((d) => [d.prop, d.value, d.important])).toEqual([
			["padding", "12px 16px", false],
			["color", "#fff", true],
		]);
		expect(rules?.[1]?.decls[0]?.value).toBe("50%");
	});

	it("注释:规则前面的挂在规则头上,块里的按位置夹在声明之间,行尾的跟着那条声明", () => {
		const rules = readRules(MULTI);
		expect(rules?.[0]?.notes).toEqual(["整块的底"]);
		expect(
			rules?.[0]?.items.map((i) => (i.kind === "comment" ? `#${i.text}` : i.decl.prop)),
		).toEqual(["#留白说明", "padding", "#行尾也算", "color"]);
		expect(rules?.[1]?.notes).toEqual([]);
	});

	it("@media 里的规则也列出来,并带上它在哪个 at 规则下", () => {
		const rules = readRules('@media (min-width: 1px){[data-bn="self"] img{width:50%}}');
		expect(rules?.[0]?.selector).toBe('[data-bn="self"] img');
		expect(rules?.[0]?.atRule).toBe("@media (min-width: 1px)");
	});

	it("解析不了 → null,让面板把结构视图让位,不拿半份 AST 去切作者的文本", () => {
		expect(readRules('[data-bn="self"]{color:red}}')).toBeNull();
		expect(readRules("a{b")).toBeNull();
	});

	it("值没写完不算解析不了 —— 作者正打字到一半", () => {
		expect(readRules('[data-bn="self"]{padding:')).not.toBeNull();
	});

	it("字符串里的 /* 不当注释", () => {
		const rules = readRules('[data-bn="self"]{content:"/* 不是注释 */"}');
		expect(rules?.[0]?.items.every((i) => i.kind === "decl")).toBe(true);
		expect(rules?.[0]?.decls[0]?.value).toBe('"/* 不是注释 */"');
	});
});

describe("setDeclValue —— 只换值那一截", () => {
	it("多行块:属性名、分号、行尾注释、!important 全留着", () => {
		expect(setDeclValue(MULTI, 0, 1, "#000")).toBe(
			MULTI.replace("#fff !important", "#000 !important"),
		);
		expect(setDeclValue(MULTI, 0, 0, "8px")).toBe(MULTI.replace("12px 16px", "8px"));
	});

	it("单行块同样只动那一截", () => {
		expect(setDeclValue('[data-bn="self"]{padding:12px;color:red}', 0, 0, "4px")).toBe(
			'[data-bn="self"]{padding:4px;color:red}',
		);
	});

	it("解析不了 / 下标越界 → 原样返回", () => {
		expect(setDeclValue("a{b", 0, 0, "x")).toBe("a{b");
		expect(setDeclValue(MULTI, 5, 0, "x")).toBe(MULTI);
		expect(setDeclValue(MULTI, 0, 9, "x")).toBe(MULTI);
	});
});

describe("addDecl —— 新声明跟着这一块的写法走", () => {
	it("多行块:另起一行、缩进照最后一条声明,放在它后面", () => {
		expect(addDecl(MULTI, 0, "margin", "0")).toBe(
			MULTI.replace("\tcolor: #fff !important;\n", "\tcolor: #fff !important;\n\tmargin: 0;\n"),
		);
	});

	it("单行块:紧贴着补在最后一条后面,补上它缺的分号", () => {
		expect(addDecl('[data-bn="avatar"]{border-radius:50%}', 0, "width", "40px")).toBe(
			'[data-bn="avatar"]{border-radius:50%;width:40px}',
		);
		expect(addDecl('[data-bn="avatar"]{border-radius:50%;}', 0, "width", "40px")).toBe(
			'[data-bn="avatar"]{border-radius:50%;width:40px;}',
		);
	});

	it("空块:多行空块补一行带缩进的,单行空块贴着花括号", () => {
		expect(addDecl('[data-bn="self"] {\n}', 0, "padding", "8px")).toBe(
			'[data-bn="self"] {\n\tpadding: 8px;\n}',
		);
		expect(addDecl('[data-bn="self"]{}', 0, "padding", "8px")).toBe(
			'[data-bn="self"]{padding:8px}',
		);
	});

	it("最后一条声明后面有行尾注释:新行插在注释之后,不把注释挤到别的声明身上", () => {
		const css = '[data-bn="self"] {\n\tpadding: 8px; /* 说明 */\n}';
		expect(addDecl(css, 0, "color", "red")).toBe(
			'[data-bn="self"] {\n\tpadding: 8px; /* 说明 */\n\tcolor: red;\n}',
		);
	});
});

describe("removeDecl —— 连它那一行 / 那个分号一起带走", () => {
	it("多行块:整行删掉,不留空行;它的行尾注释一起走,别的注释留着", () => {
		expect(removeDecl(MULTI, 0, 0)).toBe(
			MULTI.replace("\tpadding: 12px 16px; /* 行尾也算 */\n", ""),
		);
		expect(removeDecl(MULTI, 0, 1)).toBe(MULTI.replace("\tcolor: #fff !important;\n", ""));
	});

	it("单行块:把分号一起吃掉,不剩 `{;` 或 `;}`", () => {
		expect(removeDecl('[data-bn="self"]{padding:12px;color:red}', 0, 0)).toBe(
			'[data-bn="self"]{color:red}',
		);
		expect(removeDecl('[data-bn="self"]{padding:12px;color:red}', 0, 1)).toBe(
			'[data-bn="self"]{padding:12px}',
		);
	});

	it("删到块空了,规则留着(删规则是另一个动作)", () => {
		expect(removeDecl('[data-bn="self"] {\n\tpadding: 8px;\n}', 0, 0)).toBe(
			'[data-bn="self"] {\n}',
		);
	});
});

describe("addRule / removeRule / setSelector", () => {
	it("加规则:空文本直接放,已有内容时空一行再放,块是多行空块", () => {
		expect(addRule("", '[data-bn="self"]')).toBe('[data-bn="self"] {\n}');
		expect(addRule('[data-bn="self"]{padding:8px}\n', '[data-bn="avatar"]')).toBe(
			'[data-bn="self"]{padding:8px}\n\n[data-bn="avatar"] {\n}',
		);
	});

	it("删规则:连它前面那条空行一起收,前面的说明注释留着(那是作者写的字)", () => {
		expect(removeRule(MULTI, 1)).toBe(
			`/* 整块的底 */\n[data-bn="self"] {\n\t/* 留白说明 */\n\tpadding: 12px 16px; /* 行尾也算 */\n\tcolor: #fff !important;\n}\n`,
		);
		expect(removeRule(MULTI, 0)).toBe('/* 整块的底 */\n\n[data-bn="avatar"]{border-radius:50%}\n');
	});

	it("改选择器:只换 `{` 前面那一截", () => {
		expect(setSelector(MULTI, 1, '[data-bn="avatar"]:hover')).toBe(
			MULTI.replace('[data-bn="avatar"]{', '[data-bn="avatar"]:hover{'),
		);
	});
});
