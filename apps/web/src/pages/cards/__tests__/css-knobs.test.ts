/**
 * 常用旋钮与 CSS 文本**同写一段**(ADR-0014 决策 21)。
 *
 * 决策里那句「不要旋钮值和 CSS 文本两份状态互相盖」是这一层存在的全部理由:旋钮不自己
 * 存值,它**读的就是那段 CSS,写回的也是那段 CSS**。于是这层的成败只有一个判据 ——
 * **改一枚旋钮,除了那一条声明,整段文本一个字节都不许动。**
 *
 * 所以这里不用「解析 → 改 AST → 重新 generate」那条路:css-tree 的 `generate` 出来的是
 * 规范化的紧凑形式,作者的换行、缩进、注释会被整段抹掉 —— 而他正对着一个文本框打字。
 * 改成**按位置做外科手术**:用 AST 找到那条声明在原文里的偏移,只换那一截。
 */

import { describe, expect, it } from "vite-plus/test";
import { readKnobs, setKnobDecl } from "../css-knobs";

const SELF = "self";

describe("readKnobs", () => {
	it("读得出 self 规则里那几条声明", () => {
		const got = readKnobs('[data-bn="self"]{padding:12px;color:#fff}', SELF);
		expect(got?.padding).toBe("12px");
		expect(got?.color).toBe("#fff");
	});

	it("没写的那条是 undefined,不是空串 —— 空串会被当成「作者写了个空值」", () => {
		const got = readKnobs('[data-bn="self"]{padding:12px}', SELF);
		expect(got?.["border-radius"]).toBeUndefined();
	});

	it("同一条写了两遍,读后写的那一条(CSS 就是后来者赢)", () => {
		const got = readKnobs('[data-bn="self"]{padding:4px;padding:16px}', SELF);
		expect(got?.padding).toBe("16px");
	});

	it("别的挂点的规则不串门", () => {
		const css = '[data-bn="glass"]{padding:99px}[data-bn="self"]{padding:12px}';
		expect(readKnobs(css, SELF)?.padding).toBe("12px");
		expect(readKnobs(css, "glass")?.padding).toBe("99px");
	});

	it("选择器写成单引号 / 带空格也认得出 —— 文本框里是作者的原样写法", () => {
		expect(readKnobs("[data-bn='self']{padding:8px}", SELF)?.padding).toBe("8px");
		expect(readKnobs('[data-bn="self"] { padding : 8px }', SELF)?.padding).toBe("8px");
	});

	it('复合选择器(`[data-bn="self"]:hover`)不算 —— 旋钮只管这一层自己', () => {
		expect(readKnobs('[data-bn="self"]:hover{padding:8px}', SELF)?.padding).toBeUndefined();
	});

	it("CSS 解析不了 → 回 null,让面板把旋钮禁掉而不是瞎猜", () => {
		// 例子要挑**真的**过不去的:css-tree 对「值没写完」是容错恢复的
		// (`{padding:` 照样解析成功),拿那种当例子等于这条守卫从来不会红。
		expect(readKnobs('[data-bn="self"]{color:red}}', SELF)).toBeNull();
		expect(readKnobs("a{b", SELF)).toBeNull();
	});

	it("值没写完不算解析不了 —— 作者正打字到一半,旋钮不该整排消失", () => {
		expect(readKnobs('[data-bn="self"]{padding:', SELF)).not.toBeNull();
	});

	it("空 CSS 也能读,只是什么都没有", () => {
		expect(readKnobs("", SELF)).toEqual({});
	});
});

describe("setKnobDecl —— 只动那一条,别的字节不许变", () => {
	it("改一条已有的:只换值,缩进 / 注释 / 别的声明原样", () => {
		const css = `[data-bn="self"] {
  padding: 12px;   /* 我调过 */
  color: red;
}
[data-bn="glass"] { padding: 99px }`;
		const out = setKnobDecl(css, SELF, "padding", "16px");
		expect(out).toBe(`[data-bn="self"] {
  padding: 16px;   /* 我调过 */
  color: red;
}
[data-bn="glass"] { padding: 99px }`);
	});

	it("规则在、这条不在:插进去,别的原样", () => {
		const css = '[data-bn="self"]{color:red}';
		expect(setKnobDecl(css, SELF, "padding", "16px")).toBe(
			'[data-bn="self"]{color:red;padding:16px}',
		);
	});

	it("规则都不在:在末尾补一条规则", () => {
		expect(setKnobDecl("", SELF, "padding", "16px")).toBe('[data-bn="self"]{padding:16px}');
		expect(setKnobDecl('[data-bn="glass"]{color:red}', SELF, "padding", "16px")).toBe(
			'[data-bn="glass"]{color:red}\n[data-bn="self"]{padding:16px}',
		);
	});

	it("传 null = 删掉这一条,连它的分号一起", () => {
		const css = '[data-bn="self"]{padding:12px;color:red}';
		expect(setKnobDecl(css, SELF, "padding", null)).toBe('[data-bn="self"]{color:red}');
	});

	it("删到规则空了,把空规则一起收走 —— 不留一地空壳", () => {
		expect(setKnobDecl('[data-bn="self"]{padding:12px}', SELF, "padding", null)).toBe("");
	});

	it("删一条不存在的 = 原样返回", () => {
		const css = '[data-bn="self"]{color:red}';
		expect(setKnobDecl(css, SELF, "padding", null)).toBe(css);
	});

	it("写了两遍时改后面那条 —— 与读一致,否则改了看不见", () => {
		const css = '[data-bn="self"]{padding:4px;padding:16px}';
		expect(setKnobDecl(css, SELF, "padding", "20px")).toBe(
			'[data-bn="self"]{padding:4px;padding:20px}',
		);
	});

	it("CSS 解析不了 → 原样返回,绝不拿半份 AST 去重写作者的文本", () => {
		const broken = '[data-bn="self"]{color:red}}';
		expect(setKnobDecl(broken, SELF, "padding", "16px")).toBe(broken);
	});

	it("往返一圈:读出来再原样写回去,文本不变", () => {
		const css = `[data-bn="self"] {
  padding: 12px 16px;
  background: linear-gradient(to right, #fff, #000);
}`;
		const got = readKnobs(css, SELF);
		// 读到的必须是**原文那一截**,不是 css-tree 规范化后的形式 —— 逗号后面那个空格
		// 就是判据:值一旦被规范化,往返一圈作者的写法就被悄悄改了。
		expect(got?.padding).toBe("12px 16px");
		expect(got?.background).toBe("linear-gradient(to right, #fff, #000)");
		let out = setKnobDecl(css, SELF, "padding", got?.padding ?? "");
		out = setKnobDecl(out, SELF, "background", got?.background ?? "");
		expect(out).toBe(css);
	});
});
