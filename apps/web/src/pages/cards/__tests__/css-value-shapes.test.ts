/**
 * 值的形状 → 控件(ADR-0014 决策 21 的 2026-09-19 🔗:按值的形状判,不按属性名)。
 *
 * **CSS 的值域比控件宽**,这是这一层存在的全部原因:`padding` 能写四个数、`background` 能是
 * 渐变、`border` 能省略任意一段。认不出时回 `text` 是正常结果 —— 悄悄把 `12px 16px` 折成
 * `12px` 等于替作者把他写的东西删了,而他多半不会当场发现。
 */

import { describe, expect, it } from "vite-plus/test";
import { formatShape, KEYWORD_OPTIONS, PROP_LABELS, shapeOf } from "../css-value-shapes";

describe("长度", () => {
	it("认得出单个长度,单位照原文;裸数单位为空", () => {
		expect(shapeOf("padding", "12px")).toEqual({ kind: "length", n: 12, unit: "px" });
		expect(shapeOf("width", "50%")).toEqual({ kind: "length", n: 50, unit: "%" });
		expect(shapeOf("line-height", "1.5")).toEqual({ kind: "length", n: 1.5, unit: "" });
		expect(shapeOf("margin", "0")).toEqual({ kind: "length", n: 0, unit: "" });
		expect(shapeOf("top", "-4px")).toEqual({ kind: "length", n: -4, unit: "px" });
	});

	it("多值简写、计算式、变量都是文本行(别折成第一个数)", () => {
		expect(shapeOf("padding", "12px 16px").kind).toBe("text");
		expect(shapeOf("width", "calc(100% - 8px)").kind).toBe("text");
		expect(shapeOf("padding", "var(--bn-knob-pad)").kind).toBe("text");
	});

	it("format 出来的就是 CSS 里那个写法;0 不带单位", () => {
		expect(formatShape({ kind: "length", n: 12, unit: "px" })).toBe("12px");
		expect(formatShape({ kind: "length", n: 0, unit: "px" })).toBe("0");
		expect(formatShape({ kind: "length", n: 1.5, unit: "" })).toBe("1.5");
	});
});

describe("颜色", () => {
	it("认 hex,三位六位都要,不管挂在哪个属性上", () => {
		expect(shapeOf("color", "#fff")).toEqual({ kind: "color", hex: "#fff" });
		expect(shapeOf("background", "#ff00aa")).toEqual({ kind: "color", hex: "#ff00aa" });
		expect(shapeOf("border-color", "#123456").kind).toBe("color");
	});

	it("渐变 / 变量 / 关键字 / 带透明度的都是文本行 —— 色块控件只吐六位 hex", () => {
		expect(shapeOf("background", "linear-gradient(#fff,#000)").kind).toBe("text");
		expect(shapeOf("color", "var(--color-bn-pink)").kind).toBe("text");
		expect(shapeOf("color", "red").kind).toBe("text");
		expect(shapeOf("color", "#ff00aa80").kind).toBe("text");
		expect(shapeOf("color", "rgba(0,0,0,.5)").kind).toBe("text");
	});
});

describe("关键字", () => {
	it("表里有的属性、表里有的值 → 下拉;大小写不敏感", () => {
		const got = shapeOf("text-align", "Center");
		expect(got.kind).toBe("keyword");
		if (got.kind === "keyword") expect(got.keyword).toBe("center");
	});

	it("表里没有的值是文本行 —— 下拉不许把它吃掉", () => {
		expect(shapeOf("text-align", "start").kind).toBe("text");
		expect(shapeOf("display", "table").kind).toBe("text");
	});

	it("每张候选表都不为空,且值不重复", () => {
		for (const [prop, options] of Object.entries(KEYWORD_OPTIONS)) {
			expect(options.length, prop).toBeGreaterThan(0);
			expect(new Set(options.map((o) => o.value)).size, prop).toBe(options.length);
		}
	});
});

describe("边框", () => {
	it("认得出「宽 样式 色」三段,顺序换了照样认", () => {
		expect(shapeOf("border", "1px solid #ff0000")).toEqual({
			kind: "border",
			px: 1,
			style: "solid",
			hex: "#ff0000",
		});
		expect(shapeOf("border", "#ff0000 dashed 2px")).toEqual({
			kind: "border",
			px: 2,
			style: "dashed",
			hex: "#ff0000",
		});
	});

	it("`none` 认成「没有边框」;缺一段就是文本行 —— 补默认值等于替作者做主", () => {
		expect(shapeOf("border", "none")).toEqual({
			kind: "border",
			px: 0,
			style: "none",
			hex: "#000000",
		});
		expect(shapeOf("border", "1px solid").kind).toBe("text");
		expect(shapeOf("border", "1px solid var(--x)").kind).toBe("text");
	});

	it("format 回三段;无边框写 none", () => {
		expect(formatShape({ kind: "border", px: 2, style: "dashed", hex: "#abcdef" })).toBe(
			"2px dashed #abcdef",
		);
		expect(formatShape({ kind: "border", px: 0, style: "solid", hex: "#abcdef" })).toBe("none");
	});
});

describe("人话名", () => {
	it("旋钮时代那七条都在表里,而且不是裸属性名", () => {
		for (const p of [
			"padding",
			"background",
			"border-radius",
			"border",
			"text-align",
			"font-size",
			"color",
		]) {
			expect(PROP_LABELS[p], p).toBeTruthy();
			expect(PROP_LABELS[p], p).not.toBe(p);
		}
	});

	it("认得出的值 format 回去再认还是它(互逆)", () => {
		for (const [prop, raw] of [
			["padding", "12px"],
			["color", "#abcdef"],
			["text-align", "right"],
			["border", "3px dotted #000000"],
		] as const) {
			const shape = shapeOf(prop, raw);
			expect(shape.kind).not.toBe("text");
			if (shape.kind !== "text") expect(shapeOf(prop, formatShape(shape))).toEqual(shape);
		}
	});
});
