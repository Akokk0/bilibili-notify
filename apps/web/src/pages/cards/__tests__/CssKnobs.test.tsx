// @vitest-environment jsdom

/**
 * 常用旋钮那一排(ADR-0014 决策 21)。
 *
 * 决策把它定成「旋钮与高级 CSS 文本框**同写一段 CSS**」,所以这排控件没有自己的 state:
 * 每次渲染都从那段文本里读,拧一下就把改过的整段文本交回去。这里钉的正是那条线两头 ——
 * 读得对、写回去只动一条、以及**表示不了的值不许被悄悄改写**。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CssKnobs } from "../CssKnobs";

afterEach(cleanup);

function mount(css: string) {
	const onChange = vi.fn();
	render(<CssKnobs css={css} hook="self" onChange={onChange} />);
	return { onChange };
}

describe("常用旋钮", () => {
	it("读得出当前值 —— 面板显示的就是 CSS 里那个数", () => {
		mount('[data-bn="self"]{padding:12px}');
		expect((screen.getByLabelText("内边距") as HTMLInputElement).value).toBe("12");
	});

	it("拧一下,把改过的**整段 CSS** 交回去,别的声明原样", () => {
		const { onChange } = mount('[data-bn="self"]{padding:12px;color:red}');
		fireEvent.change(screen.getByLabelText("内边距"), { target: { value: "20" } });
		expect(onChange).toHaveBeenCalledWith('[data-bn="self"]{padding:20px;color:red}');
	});

	it("没写过的那条:拧了才写进去,不是一上来就把七条默认值灌满", () => {
		const { onChange } = mount("");
		// 一条都不该先斩后奏
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.change(screen.getByLabelText("圆角"), { target: { value: "8" } });
		expect(onChange).toHaveBeenCalledWith('[data-bn="self"]{border-radius:8px}');
	});

	it("旋钮表示不了的值:原文照显,而且**没有**那个会把它覆盖掉的输入框", () => {
		mount('[data-bn="self"]{padding:12px 16px}');
		expect(screen.getByText("12px 16px")).toBeTruthy();
		expect(screen.queryByLabelText("内边距")).toBeNull();
	});

	it("表示不了时给一个明确的接管入口 —— 按了才覆盖,不按就不动", () => {
		const { onChange } = mount('[data-bn="self"]{padding:12px 16px}');
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: /改用旋钮.*内边距|内边距.*改用旋钮/ }));
		expect(onChange).toHaveBeenCalled();
		expect(onChange.mock.calls[0]?.[0]).toContain("padding:");
		expect(onChange.mock.calls[0]?.[0]).not.toContain("12px 16px");
	});

	it("CSS 解析不了 → 整排退场并说明,不拿半份 AST 去改作者的文本", () => {
		mount('[data-bn="self"]{color:red}}');
		expect(screen.queryByLabelText("内边距")).toBeNull();
		expect(screen.getByText(/解析/)).toBeTruthy();
	});

	it("清掉一枚 = 把那条声明删掉,不是写一个 0", () => {
		const { onChange } = mount('[data-bn="self"]{padding:12px;color:red}');
		fireEvent.click(screen.getByRole("button", { name: /清掉内边距/ }));
		expect(onChange).toHaveBeenCalledWith('[data-bn="self"]{color:red}');
	});
});
