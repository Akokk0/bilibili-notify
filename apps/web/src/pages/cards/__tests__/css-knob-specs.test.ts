/**
 * 每枚常用旋钮「认不认得出作者写的那个值」(ADR-0014 决策 21)。
 *
 * 这一层只解决一个问题:**CSS 的值域比旋钮宽**。`padding` 可以写四个数、`background`
 * 可以是渐变、`border` 可以省略任意一段。旋钮表示不了的时候只有两种做法 ——
 *
 * - 悄悄折成旋钮能表示的形状(`12px 16px` → `12px`):**等于把作者写的东西吃掉**;
 * - 如实说「这条我表示不了」,原值照显,要改得他自己动手。
 *
 * 取后者。所以每枚旋钮都是一对 `parse` / `format`,而 `parse` 回 `null` 是**正常结果**,
 * 不是错误 —— 面板照它把那枚旋钮切到「复杂值」那一档。
 */

import { describe, expect, it } from "vite-plus/test";
import { KNOB_SPECS } from "../css-knob-specs";

const spec = (prop: string) => {
	const s = KNOB_SPECS.find((k) => k.prop === prop);
	if (!s) throw new Error(`没有 ${prop} 这枚旋钮`);
	return s;
};

describe("长度那一档(内边距 / 圆角 / 字号)", () => {
	it("认得出单个 px", () => {
		expect(spec("padding").parse("12px")).toEqual({ px: 12 });
		expect(spec("border-radius").parse("0px")).toEqual({ px: 0 });
		expect(spec("font-size").parse("13.5px")).toEqual({ px: 13.5 });
	});

	it("裸 0 也认 —— CSS 里 0 可以不带单位", () => {
		expect(spec("padding").parse("0")).toEqual({ px: 0 });
	});

	it("多值简写表示不了,如实回 null(别折成第一个数)", () => {
		expect(spec("padding").parse("12px 16px")).toBeNull();
		expect(spec("padding").parse("12px 16px 8px 4px")).toBeNull();
	});

	it("别的单位与计算式也表示不了", () => {
		expect(spec("padding").parse("1rem")).toBeNull();
		expect(spec("padding").parse("calc(100% - 4px)")).toBeNull();
		expect(spec("font-size").parse("var(--bn-knob-size)")).toBeNull();
	});

	it("format 出来的就是 CSS 里那个写法", () => {
		expect(spec("padding").format({ px: 16 })).toBe("16px");
		expect(spec("padding").format({ px: 0 })).toBe("0");
	});
});

describe("颜色那一档(字色 / 背景)", () => {
	it("认 hex,三位六位都要", () => {
		expect(spec("color").parse("#fff")).toEqual({ hex: "#fff" });
		expect(spec("color").parse("#07091A")).toEqual({ hex: "#07091A" });
	});

	it("背景是渐变 / 变量 / 图时表示不了 —— 这正是皮肤里最常见的写法", () => {
		expect(spec("background").parse("linear-gradient(to right, #fff, #000)")).toBeNull();
		expect(spec("background").parse("var(--bn-asset-grid) repeat, #07091a")).toBeNull();
	});

	it("颜色关键字也表示不了 —— 色块控件只吐 hex,收了 red 就得把它改写成 hex", () => {
		expect(spec("color").parse("red")).toBeNull();
	});
});

describe("对齐那一档", () => {
	it("认得出四个取值", () => {
		for (const v of ["left", "center", "right", "justify"]) {
			expect(spec("text-align").parse(v)).toEqual({ keyword: v });
		}
	});

	it("大小写不敏感 —— CSS 关键字本来就不区分", () => {
		expect(spec("text-align").parse("CENTER")).toEqual({ keyword: "center" });
	});

	it("表里没有的不认", () => {
		expect(spec("text-align").parse("start")).toBeNull();
	});
});

describe("边框那一档", () => {
	it("认得出「宽 样式 色」三段", () => {
		expect(spec("border").parse("1px solid #00b4d2")).toEqual({
			px: 1,
			style: "solid",
			hex: "#00b4d2",
		});
	});

	it("顺序换了照样认 —— CSS 的 border 简写本来就不讲顺序", () => {
		expect(spec("border").parse("solid #00b4d2 2px")).toEqual({
			px: 2,
			style: "solid",
			hex: "#00b4d2",
		});
	});

	it("`none` 认成「没有边框」,这是关掉边框的写法", () => {
		expect(spec("border").parse("none")).toEqual({ px: 0, style: "none", hex: "#000000" });
	});

	it("缺一段就表示不了 —— 补一个默认值等于替作者做主", () => {
		expect(spec("border").parse("1px solid")).toBeNull();
		expect(spec("border").parse("solid")).toBeNull();
	});

	it("format 回三段", () => {
		expect(spec("border").format({ px: 2, style: "dashed", hex: "#fff" })).toBe("2px dashed #fff");
		expect(spec("border").format({ px: 0, style: "none", hex: "#000000" })).toBe("none");
	});
});

describe("整套旋钮", () => {
	it("就是决策 21 点名的那七条,顺序即面板顺序", () => {
		expect(KNOB_SPECS.map((k) => k.prop)).toEqual([
			"padding",
			"background",
			"border-radius",
			"border",
			"text-align",
			"font-size",
			"color",
		]);
	});

	it("每枚都说得出自己叫什么 —— 面板上不许出现裸属性名", () => {
		for (const k of KNOB_SPECS) expect(k.label.length).toBeGreaterThan(0);
	});

	it("parse 与 format 互逆:认得出的值,format 回去再 parse 还是它", () => {
		const samples: Array<[string, string]> = [
			["padding", "12px"],
			["border-radius", "8px"],
			["font-size", "14px"],
			["color", "#07091A"],
			["background", "#fff"],
			["text-align", "center"],
			["border", "1px solid #00b4d2"],
			["border", "none"],
		];
		for (const [prop, raw] of samples) {
			const s = spec(prop);
			const parsed = s.parse(raw);
			expect(parsed, `${prop} 该认得出 ${raw}`).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: 上一行已断言不是 null
			expect(s.parse(s.format(parsed!)), `${prop} 往返`).toEqual(parsed);
		}
	});
});
