// @vitest-environment jsdom
import { chooseSelect } from "../../../__tests__/select-controls";

/**
 * 结构化 CSS 编辑器(ADR-0014 决策 21 的 2026-09-19 🔗)。
 *
 * 它没有自己的文本 state:每次渲染从那段 CSS 现读,改一下就把改过的**整段文本**交回去。
 * 这里钉的是那条线两头 —— 读得对(规则 / 声明 / 注释各在其位、控件按值的形状给)、写回去
 * 只动一条(断言整段逐字相等)、认不出的值不许被悄悄改写、以及源码切换那一跳。
 */

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../../i18n";
import { CssEditor } from "../CssEditor";

// Existing scenarios choose Chinese explicitly; localized scenarios override it.
beforeEach(() => i18n.set({ locale: "zh-CN", voice: "plain" }));

afterEach(cleanup);

const HOOKS: Array<[string, string]> = [
	["self", "整块"],
	["avatar", "头像"],
];

function mount(css: string) {
	const onChange = vi.fn();
	render(
		<CssEditor
			css={css}
			hooks={HOOKS}
			hooksLabel="这个块的挂点"
			onChange={onChange}
			ariaLabel="这个块的 CSS"
		/>,
	);
	return { onChange };
}

const last = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.at(-1)?.[0] as string;
const input = (label: string | RegExp) => screen.getByLabelText(label) as HTMLInputElement;

it("切换语言与口吻保留未提交的CSS文本，并刷新字段名", () => {
	const { onChange } = mount('[data-bn="self"]{padding:12px 16px}');
	const field = input("内边距");
	fireEvent.change(field, { target: { value: "calc(100% - 8px)" } });
	const { voice, locale } = i18n.state();
	act(() => i18n.set({ voice: voice === "maid" ? "plain" : "maid" }));
	expect(input("内边距").value).toBe("calc(100% - 8px)");
	act(() => i18n.set({ locale: "en" }));
	expect(input("Padding").value).toBe("calc(100% - 8px)");
	expect(onChange).not.toHaveBeenCalled();
	act(() => i18n.set({ voice, locale }));
});

describe("结构视图 —— 读", () => {
	it.each([
		[
			"en",
			"Structure",
			"Source",
			"Cannot parse this CSS. Check for unmatched brackets in Source and fix the CSS to make Structure available again.",
			"No rules yet. Choose a hook below to create one.",
		],
		[
			"ja",
			"構造",
			"ソース",
			"このCSSを解析できません。ソースで括弧の対応などを修正すると、構造ビューを再び使えます。",
			"ルールはまだありません。下のフックを選ぶと作成できます。",
		],
		[
			"zh-TW",
			"結構",
			"原始碼",
			"無法剖析此 CSS。請在原始碼中檢查括號是否成對並修正，即可重新使用結構檢視。",
			"尚無規則。請選取下方掛點建立一條規則。",
		],
	] as const)(
		"%s switches views and explains invalid or empty CSS without rewriting source",
		(locale, structure, source, invalid, empty) => {
			const original = '/* Original 原文 */[data-bn="self"]{--raw:var(--original)}';
			const { onChange } = mount(original);
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(onChange).not.toHaveBeenCalled();
			fireEvent.click(screen.getByRole("button", { name: source }));
			expect((screen.getByLabelText("这个块的 CSS") as HTMLTextAreaElement).value).toBe(original);
			fireEvent.click(screen.getByRole("button", { name: structure }));
			expect(input("--raw").value).toBe("var(--original)");
			cleanup();
			const broken = mount('[data-bn="self"]{color:red}}');
			expect(screen.getByText(invalid)).toBeTruthy();
			expect((screen.getByLabelText("这个块的 CSS") as HTMLTextAreaElement).value).toBe(
				'[data-bn="self"]{color:red}}',
			);
			expect(broken.onChange).not.toHaveBeenCalled();
			cleanup();
			const blank = mount("");
			expect(screen.getByText(empty)).toBeTruthy();
			expect(blank.onChange).not.toHaveBeenCalled();
		},
	);
	it("默认是结构视图:规则一节一条,选择器照原文,声明按值的形状给控件", () => {
		mount('[data-bn="self"] {\n\tpadding: 12px;\n\tcolor: #fff;\n\ttext-align: center;\n}');
		expect(input(/的选择器$/).value).toBe('[data-bn="self"]');
		expect(input("内边距").value).toBe("12");
		expect(input("内边距的单位").textContent).toBe("px");
		expect(input("对齐").textContent).toBe("居中");
		expect(screen.getByLabelText("字色")).toBeTruthy();
		// 源码框没在:结构与源码是切换,不同摆。
		expect(screen.queryByLabelText("这个块的 CSS")).toBeNull();
	});

	it("认不出形状的值是文本行:原文照显,没有会把它折掉的数字框", () => {
		mount('[data-bn="self"]{padding:12px 16px;background:linear-gradient(#fff,#000)}');
		expect(input("内边距").value).toBe("12px 16px");
		expect(screen.queryByLabelText("内边距的单位")).toBeNull();
		expect(input("背景").value).toBe("linear-gradient(#fff,#000)");
	});

	it("边框三段认得出就给三个控件,认不出退文本行", () => {
		mount('[data-bn="self"]{border:1px solid #ff0000}');
		expect(input("边框宽度").value).toBe("1");
		expect(input("边框样式").textContent).toBe("实线");
		cleanup();
		mount('[data-bn="self"]{border:1px solid var(--x)}');
		expect(input("边框").value).toBe("1px solid var(--x)");
	});

	it("注释当灰字说明行摆出来,!important 挂徽章,@media 里的规则带上它在哪", () => {
		mount(
			'/* 整块的底 */\n[data-bn="self"] {\n\t/* 留白 */\n\tpadding: 8px !important;\n}\n@media (min-width: 1px){[data-bn="self"] img{width:50%}}',
		);
		expect(screen.getByText("整块的底")).toBeTruthy();
		expect(screen.getByText("留白")).toBeTruthy();
		expect(screen.getByText("!important")).toBeTruthy();
		expect(screen.getByText("@media (min-width: 1px)")).toBeTruthy();
	});

	it("空的 CSS:没有规则也没有控件 —— 不预先灌默认值", () => {
		mount("");
		expect(screen.getByText(/还没有规则/)).toBeTruthy();
		expect(screen.queryByLabelText("内边距")).toBeNull();
	});

	it("解析不了:结构让位、说一句,源码框顶上", () => {
		mount('[data-bn="self"]{color:red}}');
		expect(screen.getByText(/解析不了/)).toBeTruthy();
		expect(screen.getByLabelText("这个块的 CSS")).toBeTruthy();
		expect(screen.queryByLabelText(/的选择器$/)).toBeNull();
	});
});

describe("结构视图 —— 写(整段只动那一截)", () => {
	const CSS = '[data-bn="self"] {\n\tpadding: 12px; /* 留白 */\n\tcolor: #ffffff;\n}';

	it.each([
		[
			"en",
			"Display",
			"Grid",
			"Image fit",
			"Contain",
			"Text alignment",
			"Center",
			"Font family",
			"Width",
		],
		[
			"ja",
			"表示方式",
			"グリッド",
			"画像の収め方",
			"全体を収める",
			"文字揃え",
			"中央揃え",
			"フォント",
			"幅",
		],
		["zh-TW", "顯示方式", "網格", "圖片填入方式", "完整放入", "文字對齊", "置中", "字型", "寬度"],
	] as const)(
		"%s property labels and keyword choices edit only CSS values and retain pending font text across a language switch",
		(locale, display, grid, fit, contain, align, center, font, width) => {
			const original =
				'[data-bn="self"]{display:block;object-fit:cover;text-align:left;font-family:"Original Font";width:12px}';
			const { onChange } = mount(original);
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(input(width).value).toBe("12");
			expect(input(font).value).toBe('"Original Font"');
			expect(onChange).not.toHaveBeenCalled();
			chooseSelect(input(display), grid);
			expect(last(onChange)).toBe(
				'[data-bn="self"]{display:grid;object-fit:cover;text-align:left;font-family:"Original Font";width:12px}',
			);
			chooseSelect(input(fit), contain);
			expect(last(onChange)).toBe(
				'[data-bn="self"]{display:block;object-fit:contain;text-align:left;font-family:"Original Font";width:12px}',
			);
			chooseSelect(input(align), center);
			expect(last(onChange)).toBe(
				'[data-bn="self"]{display:block;object-fit:cover;text-align:center;font-family:"Original Font";width:12px}',
			);
			onChange.mockClear();
			fireEvent.change(input(font), { target: { value: '"Original Font 原文"' } });
			act(() => i18n.set({ locale: "zh-CN", voice: "plain" }));
			expect(input("字体").value).toBe('"Original Font 原文"');
			expect(onChange).not.toHaveBeenCalled();
			fireEvent.blur(input("字体"));
			expect(last(onChange)).toBe(
				'[data-bn="self"]{display:block;object-fit:cover;text-align:left;font-family:"Original Font 原文";width:12px}',
			);
		},
	);

	it.each([
		["en", "Padding", "Padding unit", "Border width", "Border style", "Border color", "Dashed"],
		["ja", "内側の余白", "内側の余白の単位", "枠線の幅", "枠線のスタイル", "枠線の色", "破線"],
		["zh-TW", "內距", "內距的單位", "邊框寬度", "邊框樣式", "邊框色彩", "虛線"],
	] as const)(
		"%s typed controls translate without changing CSS units, styles or color syntax",
		(locale, padding, unit, width, style, color, dashed) => {
			const original = '[data-bn="self"]{padding:12px;border:1px solid #ff0000}';
			const { onChange } = mount(original);
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(input(padding).value).toBe("12");
			expect(onChange).not.toHaveBeenCalled();
			chooseSelect(input(unit), "em");
			expect(last(onChange)).toBe('[data-bn="self"]{padding:12em;border:1px solid #ff0000}');
			fireEvent.change(input(width), { target: { value: "2" } });
			expect(last(onChange)).toBe('[data-bn="self"]{padding:12px;border:2px solid #ff0000}');
			chooseSelect(input(style), dashed);
			expect(last(onChange)).toBe('[data-bn="self"]{padding:12px;border:1px dashed #ff0000}');
			fireEvent.change(input(color), { target: { value: "#abcdef" } });
			expect(last(onChange)).toBe('[data-bn="self"]{padding:12px;border:1px solid #abcdef}');
		},
	);

	it.each([
		[
			"en",
			'Selector for [data-bn="self"]',
			"Property to add",
			"Value to add",
			"Add",
			"Property suggestions",
			"Remove --raw",
			'Remove rule [data-bn="self"]',
			"Add a rule:",
		],
		[
			"ja",
			'[data-bn="self"]のセレクター',
			"追加するプロパティ",
			"追加する値",
			"追加",
			"プロパティ候補",
			"--rawを削除",
			'ルール [data-bn="self"]を削除',
			"ルールを追加：",
		],
		[
			"zh-TW",
			'[data-bn="self"] 的選擇器',
			"新增屬性",
			"新增值",
			"加入",
			"屬性候選",
			"刪除--raw",
			'刪除規則 [data-bn="self"]',
			"新增規則：",
		],
	] as const)(
		"%s rule and declaration controls preserve selectors, comments and original values",
		(locale, selector, prop, value, add, suggestions, removeDeclLabel, removeRuleLabel, addRuleLabel) => {
			const original = '/* Original 原文 */\n[data-bn="self"] {\n\t--raw: var(--original);\n}';
			const { onChange } = mount(original);
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(screen.getByText(addRuleLabel)).toBeTruthy();
			expect(onChange).not.toHaveBeenCalled();
			fireEvent.change(input(selector), { target: { value: '[data-bn="self"]:hover' } });
			fireEvent.blur(input(selector));
			expect(last(onChange)).toBe(
				'/* Original 原文 */\n[data-bn="self"]:hover {\n\t--raw: var(--original);\n}',
			);
			fireEvent.change(input(prop), { target: { value: "bo" } });
			fireEvent.click(
				within(screen.getByRole("group", { name: suggestions })).getByText("border-radius"),
			);
			fireEvent.change(input(value), { target: { value: "4px" } });
			fireEvent.click(screen.getByRole("button", { name: add }));
			expect(last(onChange)).toBe(
				'/* Original 原文 */\n[data-bn="self"] {\n\t--raw: var(--original);\n\tborder-radius: 4px;\n}',
			);
			fireEvent.click(within(screen.getByLabelText("这个块的挂点")).getByText("头像"));
			expect(last(onChange)).toBe(`${original}\n\n[data-bn="avatar"] {\n}`);
			cleanup();
			const simple = mount('[data-bn="self"]{--raw:var(--original)}');
			fireEvent.click(screen.getByRole("button", { name: removeDeclLabel }));
			expect(last(simple.onChange)).toBe('[data-bn="self"]{}');
			fireEvent.click(screen.getByRole("button", { name: removeRuleLabel }));
			expect(last(simple.onChange)).toBe("");
		},
	);

	it("改数字 → 只换值", () => {
		const { onChange } = mount(CSS);
		fireEvent.change(input("内边距"), { target: { value: "20" } });
		expect(last(onChange)).toBe(CSS.replace("12px", "20px"));
	});

	it("改单位 → 只换值", () => {
		const { onChange } = mount(CSS);
		chooseSelect(input("内边距的单位"), "em");
		expect(last(onChange)).toBe(CSS.replace("12px", "12em"));
	});

	it("改颜色 → 只换值", () => {
		const { onChange } = mount(CSS);
		fireEvent.change(input("字色"), { target: { value: "#000000" } });
		expect(last(onChange)).toBe(CSS.replace("#ffffff", "#000000"));
	});

	it("文本行失焦 / 回车才提交,Esc 退回;打到一半不提交", () => {
		const css = '[data-bn="self"]{background:linear-gradient(#fff,#000)}';
		const { onChange } = mount(css);
		const box = input("背景");
		fireEvent.change(box, { target: { value: "linear-gradient(" } });
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.keyDown(box, { key: "Escape" });
		expect(box.value).toBe("linear-gradient(#fff,#000)");
		fireEvent.change(box, { target: { value: "#fff" } });
		fireEvent.keyDown(box, { key: "Enter" });
		expect(last(onChange)).toBe('[data-bn="self"]{background:#fff}');
	});

	it("删一条声明:那一行整个走,注释在别人身上的留着", () => {
		const { onChange } = mount(CSS);
		fireEvent.click(screen.getByRole("button", { name: "删掉字色" }));
		expect(last(onChange)).toBe('[data-bn="self"] {\n\tpadding: 12px; /* 留白 */\n}');
	});

	it("加一条声明:属性 + 值,回车或「加上」,跟着这块的写法另起一行", () => {
		const { onChange } = mount(CSS);
		fireEvent.change(input("要加的属性"), { target: { value: "margin" } });
		fireEvent.change(input("要加的值"), { target: { value: "0" } });
		fireEvent.keyDown(input("要加的值"), { key: "Enter" });
		expect(last(onChange)).toBe(CSS.replace("#ffffff;\n", "#ffffff;\n\tmargin: 0;\n"));
	});

	it("加声明时给常用属性候选,点一下填进去", () => {
		mount(CSS);
		fireEvent.change(input("要加的属性"), { target: { value: "bo" } });
		const chips = screen.getByLabelText("属性候选");
		fireEvent.click(within(chips).getByText("圆角"));
		expect(input("要加的属性").value).toBe("border-radius");
	});

	it("改选择器 / 删规则 / 点挂点加规则", () => {
		const { onChange } = mount(CSS);
		const sel = input(/的选择器$/);
		fireEvent.change(sel, { target: { value: '[data-bn="self"]:hover' } });
		fireEvent.blur(sel);
		expect(last(onChange)).toBe(CSS.replace('[data-bn="self"] {', '[data-bn="self"]:hover {'));

		fireEvent.click(within(screen.getByLabelText("这个块的挂点")).getByText("头像"));
		expect(last(onChange)).toBe(`${CSS}\n\n[data-bn="avatar"] {\n}`);

		fireEvent.click(screen.getByRole("button", { name: /^删掉规则/ }));
		expect(last(onChange)).toBe("");
	});
});

describe("源码视图", () => {
	it("切过去是同一段文本,改了交回整段;切回来结构跟着新文本走", () => {
		const { onChange } = mount('[data-bn="self"]{padding:12px}');
		fireEvent.click(screen.getByRole("button", { name: "源码" }));
		const box = screen.getByLabelText("这个块的 CSS") as HTMLTextAreaElement;
		expect(box.value).toBe('[data-bn="self"]{padding:12px}');
		fireEvent.change(box, { target: { value: '[data-bn="self"]{padding:4px}' } });
		expect(last(onChange)).toBe('[data-bn="self"]{padding:4px}');
	});
});
