// @vitest-environment jsdom

/**
 * ArrayEditor / QuietHoursEditor 的刻画测试。
 *
 * 这两个编辑器逐字共用三段行内装饰(行号徽标、移除钮、添加钮),收编成局部件
 * 之前先把**行为**钉住:行号从 1 起、移除只删那一行、添加追加的默认值是什么、
 * 免扰时段那两个下拉各 24 个整点。类名不在这里断言 —— 那是 theme-components
 * 的活,也正是重构会动的部分。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ArrayEditor, QuietHoursEditor } from "../forms";

afterEach(cleanup);

describe("ArrayEditor", () => {
	it("行号从 1 起,每行一个输入框", () => {
		render(<ArrayEditor value={["a", "b", "c"]} onChange={() => {}} />);
		expect(screen.getAllByRole("textbox").map((el) => (el as HTMLInputElement).value)).toEqual([
			"a",
			"b",
			"c",
		]);
		for (const n of ["1", "2", "3"]) expect(screen.getByText(n)).toBeTruthy();
	});

	it("移除只删掉那一行", () => {
		const onChange = vi.fn();
		render(<ArrayEditor value={["a", "b", "c"]} onChange={onChange} />);
		const removes = screen.getAllByRole("button", { name: "移除" });
		expect(removes).toHaveLength(3);
		fireEvent.click(removes[1]);
		expect(onChange).toHaveBeenCalledWith(["a", "c"]);
	});

	it("添加一行追加空串,提示语带上 placeholder", () => {
		const onChange = vi.fn();
		render(<ArrayEditor value={["a"]} onChange={onChange} placeholder="关键词" />);
		const add = screen.getByRole("button", { name: /添加一行/ });
		expect(add.textContent).toContain("关键词");
		fireEvent.click(add);
		expect(onChange).toHaveBeenCalledWith(["a", ""]);
	});

	it("改某一行只写回那一格", () => {
		const onChange = vi.fn();
		render(<ArrayEditor value={["a", "b"]} onChange={onChange} />);
		fireEvent.change(screen.getAllByRole("textbox")[1], { target: { value: "B" } });
		expect(onChange).toHaveBeenCalledWith(["a", "B"]);
	});
});

/**
 * 两个编辑器共用行内装饰之后的不变量。这条不是照着实现回抄的:它断的是
 * 「两处必须一致」,谁哪天在其中一处 fork 一份改样式,这里就红。
 */
describe("两个行编辑器的行内装饰保持同一份", () => {
	it("移除钮与添加钮的样式两处逐字一致", () => {
		const { unmount } = render(<ArrayEditor value={["a"]} onChange={() => {}} />);
		const arr = {
			remove: screen.getByRole("button", { name: "移除" }).className,
			add: screen.getByRole("button", { name: /添加一行/ }).className,
			index: screen.getByText("1").className,
		};
		unmount();
		render(<QuietHoursEditor value={[{ start: 23, end: 7 }]} onChange={() => {}} />);
		expect(screen.getByRole("button", { name: "移除" }).className).toBe(arr.remove);
		expect(screen.getByRole("button", { name: /添加免扰时段/ }).className).toBe(arr.add);
		expect(screen.getByText("1").className).toBe(arr.index);
	});
});

describe("QuietHoursEditor", () => {
	it("每行两个整点下拉,各 24 项", () => {
		render(<QuietHoursEditor value={[{ start: 23, end: 7 }]} onChange={() => {}} />);
		const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
		expect(selects).toHaveLength(2);
		expect(selects[0].options).toHaveLength(24);
		expect(selects[0].options[0].textContent).toBe("00:00");
		expect(selects[0].value).toBe("23");
		expect(selects[1].value).toBe("7");
	});

	it("start > end 标为跨次日,start === end 标为区间为空", () => {
		render(
			<QuietHoursEditor
				value={[
					{ start: 23, end: 7 },
					{ start: 5, end: 5 },
				]}
				onChange={() => {}}
			/>,
		);
		expect(screen.getByText("(跨次日)")).toBeTruthy();
		expect(screen.getByText("区间为空")).toBeTruthy();
	});

	it("改起点只动那一行的 start", () => {
		const onChange = vi.fn();
		render(
			<QuietHoursEditor
				value={[
					{ start: 23, end: 7 },
					{ start: 1, end: 2 },
				]}
				onChange={onChange}
			/>,
		);
		const selects = screen.getAllByRole("combobox");
		fireEvent.change(selects[2], { target: { value: "9" } });
		expect(onChange).toHaveBeenCalledWith([
			{ start: 23, end: 7 },
			{ start: 9, end: 2 },
		]);
	});

	it("移除只删那一行,添加追加 23→7", () => {
		const onChange = vi.fn();
		render(
			<QuietHoursEditor
				value={[
					{ start: 23, end: 7 },
					{ start: 1, end: 2 },
				]}
				onChange={onChange}
			/>,
		);
		fireEvent.click(screen.getAllByRole("button", { name: "移除" })[0]);
		expect(onChange).toHaveBeenLastCalledWith([{ start: 1, end: 2 }]);
		fireEvent.click(screen.getByRole("button", { name: /添加免扰时段/ }));
		expect(onChange).toHaveBeenLastCalledWith([
			{ start: 23, end: 7 },
			{ start: 1, end: 2 },
			{ start: 23, end: 7 },
		]);
	});
});
