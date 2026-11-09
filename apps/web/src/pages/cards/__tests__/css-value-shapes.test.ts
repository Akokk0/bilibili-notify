/**
 * 值的形状 → 控件(ADR-0014 决策 21 的 2026-09-19 🔗:按值的形状判,不按属性名)。
 *
 * **CSS 的值域比控件宽**,这是这一层存在的全部原因:`padding` 能写四个数、`background` 能是
 * 渐变、`border` 能省略任意一段。认不出时回 `text` 是正常结果 —— 悄悄把 `12px 16px` 折成
 * `12px` 等于替作者把他写的东西删了,而他多半不会当场发现。
 */

import { beforeEach, describe, expect, it } from "vite-plus/test";
import { i18n } from "../../../i18n";
import {
	formatShape,
	KEYWORD_OPTIONS,
	LENGTH_UNITS,
	PROP_LABELS,
	shapeOf,
} from "../css-value-shapes";

beforeEach(() => i18n.set({ locale: "zh-CN", voice: "plain" }));

it.each([
	["en", "Border box", "Content box"],
	["ja", "枠線・余白込み", "内容のみ"],
	["zh-TW", "含邊框與內距", "僅計算內容"],
] as const)(
	"%s compact box sizing choices retain both CSS sizing modes",
	(locale, border, content) => {
		i18n.set({ locale, voice: "plain" });
		expect(KEYWORD_OPTIONS["box-sizing"]).toEqual([
			{ value: "border-box", label: border },
			{ value: "content-box", label: content },
		]);
	},
);

it.each([
	[
		"en",
		"Unitless",
		["Left", "Center", "Right", "Justify"],
		["Block", "Inline", "Inline block", "Flex", "Inline flex", "Grid", "Hidden"],
		["Cover", "Contain", "Stretch", "Original size"],
	],
	[
		"ja",
		"単位なし",
		["左揃え", "中央揃え", "右揃え", "両端揃え"],
		[
			"ブロック",
			"インライン",
			"インラインブロック",
			"フレックス",
			"インラインフレックス",
			"グリッド",
			"非表示",
		],
		["切り抜いて埋める", "全体を収める", "引き伸ばす", "元のサイズ"],
	],
	[
		"zh-TW",
		"無單位",
		["靠左", "置中", "靠右", "左右對齊"],
		["區塊", "行內", "行內區塊", "彈性", "行內彈性", "網格", "不顯示"],
		["裁切填滿", "完整放入", "拉伸", "原始大小"],
	],
] as const)(
	"%s keyword labels follow the current language while CSS keywords keep their meanings",
	(locale, unitless, align, display, fit) => {
		i18n.set({ locale, voice: "plain" });
		expect(LENGTH_UNITS.at(-1)).toEqual({ value: "", label: unitless });
		expect(KEYWORD_OPTIONS["text-align"]).toEqual([
			{ value: "left", label: align[0] },
			{ value: "center", label: align[1] },
			{ value: "right", label: align[2] },
			{ value: "justify", label: align[3] },
		]);
		expect(KEYWORD_OPTIONS.display).toEqual(
			["block", "inline", "inline-block", "flex", "inline-flex", "grid", "none"].map(
				(value, i) => ({ value, label: display[i] }),
			),
		);
		expect(KEYWORD_OPTIONS["object-fit"]).toEqual(
			["cover", "contain", "fill", "none"].map((value, i) => ({ value, label: fit[i] })),
		);
		const shape = shapeOf("text-align", "center");
		if (shape.kind !== "keyword") throw new Error("expected keyword control");
		expect(formatShape(shape)).toBe("center");
		expect(shapeOf("text-align", "var(--original)")).toEqual({ kind: "text" });
	},
);

it("已加载的候选表与属性名在读取时跟随当前语言，CSS值不改写", () => {
	const { locale, voice } = i18n.state();
	const labels = PROP_LABELS;
	const units = LENGTH_UNITS;
	try {
		i18n.set({ locale: "en", voice: "plain" });
		expect(labels.padding).toBe("Padding");
		expect(units.at(-1)).toEqual({ value: "", label: "Unitless" });
		expect(shapeOf("text-align", "center")).toMatchObject({
			kind: "keyword",
			keyword: "center",
			options: expect.arrayContaining([{ value: "center", label: "Center" }]),
		});
	} finally {
		i18n.set({ locale, voice });
	}
	expect(labels.padding).toBe("内边距");
});

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

	// 归 0 也把单位写出去(`0px`,不是 CSS 允许的那个省略写法 `0`)。省掉它在这一层是有害的:
	// 控件没有自己的 state,每次渲染都从那段文本现推 shape,`0` 会被 `shapeOf` 推成
	// `{ n: 0, unit: "" }` —— 单位下拉静默变「无」,作者下一次把数字调成 8,写出去的就是裸的
	// `padding: 8`,非法长度、浏览器整条丢弃,而清洗器不查单位,所以它存得下、导得出、就是不生效。
	it("format 出来的就是 CSS 里那个写法;0 也带单位", () => {
		expect(formatShape({ kind: "length", n: 12, unit: "px" })).toBe("12px");
		expect(formatShape({ kind: "length", n: 0, unit: "px" })).toBe("0px");
		expect(formatShape({ kind: "length", n: 1.5, unit: "" })).toBe("1.5");
	});

	it("归 0 再调回去,单位还在 —— 控件是从文本现推 shape 的", () => {
		// 判据:把 formatShape 的 length 分支改回 `n === 0 && unit !== "" ? "0" : ...`,这条必须红。
		// 模拟界面上那一跳:padding 12px --数字改成 0--> 写回文本 --重新 shapeOf--> 数字改成 8。
		const start = shapeOf("padding", "12px");
		expect(start).toEqual({ kind: "length", n: 12, unit: "px" });
		if (start.kind !== "length") throw new Error("unreachable");

		const zeroed = formatShape({ ...start, n: 0 });
		const reread = shapeOf("padding", zeroed);
		expect(reread).toEqual({ kind: "length", n: 0, unit: "px" });
		if (reread.kind !== "length") throw new Error("unreachable");

		expect(formatShape({ ...reread, n: 8 })).toBe("8px");
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
			// 0 的样本一条都不能少:互逆在 0 上最容易断(那正是「0 不带单位」曾经栽的地方)。
			["padding", "0px"],
			["width", "0%"],
			["line-height", "0"],
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
