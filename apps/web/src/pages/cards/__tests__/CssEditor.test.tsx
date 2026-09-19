// @vitest-environment jsdom

/**
 * 结构化 CSS 编辑器(ADR-0014 决策 21 的 2026-09-19 🔗)。
 *
 * 它没有自己的文本 state:每次渲染从那段 CSS 现读,改一下就把改过的**整段文本**交回去。
 * 这里钉的是那条线两头 —— 读得对(规则 / 声明 / 注释各在其位、控件按值的形状给)、写回去
 * 只动一条(断言整段逐字相等)、认不出的值不许被悄悄改写、以及源码切换那一跳。
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CssEditor } from "../CssEditor";

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

describe("结构视图 —— 读", () => {
	it("默认是结构视图:规则一节一条,选择器照原文,声明按值的形状给控件", () => {
		mount('[data-bn="self"] {\n\tpadding: 12px;\n\tcolor: #fff;\n\ttext-align: center;\n}');
		expect(input(/的选择器$/).value).toBe('[data-bn="self"]');
		expect(input("内边距").value).toBe("12");
		expect(input("内边距的单位").value).toBe("px");
		expect(input("对齐").value).toBe("center");
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
		expect(input("边框样式").value).toBe("solid");
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

	it("改数字 → 只换值", () => {
		const { onChange } = mount(CSS);
		fireEvent.change(input("内边距"), { target: { value: "20" } });
		expect(last(onChange)).toBe(CSS.replace("12px", "20px"));
	});

	it("改单位 → 只换值", () => {
		const { onChange } = mount(CSS);
		fireEvent.change(input("内边距的单位"), { target: { value: "em" } });
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
