// @vitest-environment jsdom

/**
 * AddButton / AddCard —— 「这里还能再加一个」的虚线控件。
 *
 * 收编前站内九处手写,圆角在 `rounded-md/lg/xl/bn-sm/bn-pill` **五种**之间漂,
 * 字号 10.5 / 12 / 12.5 / 13px 四种,字重 medium / semibold / bold 三种,hover
 * 更是五种写法 —— 而语义只有一个:虚线=「空位」,指上去变粉=「点我」。
 *
 * 拆成两个而不是一个带 `variant` 的:`AddCard` 连内部结构(＋ / 标题 / 副标题)
 * 一起给,`AddButton` 收自由 children,塞进同一个组件只会得到一个两幅面孔的壳。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { AddButton, AddCard } from "../index";

afterEach(cleanup);

const btn = () => screen.getByRole("button");

/** 两个组件共用的语汇:虚线中性边 + 指上去变粉 + 皮肤挂点。 */
function expectAddLanguage(el: HTMLElement) {
	const cls = el.className.split(/\s+/);
	for (const c of [
		"border",
		"border-dashed",
		"border-bn-border",
		"hover:border-bn-pink",
		"transition",
	]) {
		expect([c, cls.includes(c)]).toEqual([c, true]);
	}
	expect(el.getAttribute("data-bn")).toBe("btn");
}

describe("AddButton", () => {
	it("默认行内档:药丸圆角,跟同排的胶囊一个形状", () => {
		render(<AddButton onClick={() => {}}>＋ 添加推送目标</AddButton>);
		expectAddLanguage(btn());
		expect(btn().className).toContain("rounded-bn-pill");
		expect(btn().className).toContain("inline-flex");
	});

	it("block 档占满一整行,换成卡片圆角 —— 整行的药丸不像话", () => {
		render(
			<AddButton block onClick={() => {}}>
				＋ 添加分条符
			</AddButton>,
		);
		expectAddLanguage(btn());
		expect(btn().className).toContain("w-full");
		expect(btn().className).toContain("rounded-lg");
		expect(btn().className).not.toContain("rounded-bn-pill");
	});

	it("字色平时是 secondary,指上去才变粉", () => {
		render(<AddButton onClick={() => {}}>＋</AddButton>);
		expect(btn().className).toContain("text-bn-text-secondary");
		expect(btn().className).toContain("hover:text-bn-pink");
	});

	it("点得动,禁用时点不动", () => {
		const onClick = vi.fn();
		const { unmount } = render(<AddButton onClick={onClick}>＋</AddButton>);
		fireEvent.click(btn());
		expect(onClick).toHaveBeenCalledTimes(1);
		unmount();
		render(
			<AddButton disabled onClick={onClick}>
				＋
			</AddButton>,
		);
		fireEvent.click(btn());
		expect(onClick).toHaveBeenCalledTimes(1);
	});
});

describe("AddCard", () => {
	it("＋ 与标题、副标题都由组件出 —— 调用方只给文字", () => {
		render(<AddCard label="添加 UP 主" hint="UID / 名称搜索" onClick={() => {}} />);
		expectAddLanguage(btn());
		expect(screen.getByText("＋")).toBeTruthy();
		expect(screen.getByText("添加 UP 主")).toBeTruthy();
		expect(screen.getByText("UID / 名称搜索")).toBeTruthy();
	});

	it("标题最重、副标题最轻 —— 三行的分量顺序不许倒", () => {
		render(<AddCard label="新建适配器" hint="连接实例" onClick={() => {}} />);
		expect(screen.getByText("新建适配器").className).toContain("text-bn-text-primary");
		expect(screen.getByText("连接实例").className).toContain("text-bn-text-tertiary");
		expect(screen.getByText("＋").className).toContain("text-bn-text-tertiary");
	});

	/** 它是网格里的一格,得跟着同行的卡片一起被拉高。 */
	it("撑满栅格给的高度", () => {
		render(<AddCard label="x" hint="y" onClick={() => {}} />);
		expect(btn().className).toContain("h-full");
	});

	it("className 只追加不冲突的(底色、最小高度、焦点环),接在本体之后", () => {
		render(<AddCard label="x" hint="y" className="min-h-22 bg-bn-surface" onClick={() => {}} />);
		expect(btn().className.endsWith("min-h-22 bg-bn-surface")).toBe(true);
	});

	it("禁用时点不动", () => {
		const onClick = vi.fn();
		render(<AddCard label="x" hint="y" disabled onClick={onClick} />);
		fireEvent.click(btn());
		expect(onClick).not.toHaveBeenCalled();
	});
});
