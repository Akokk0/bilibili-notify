// @vitest-environment jsdom

/**
 * LogLevelPicker 的刻画测试。
 *
 * 它其实就是 `Picker` 加一颗「跟随全局」,但整副外壳与按钮此前抄了一遍,抄的
 * 那份还漏了 `aria-pressed` —— 于是四颗日志等级钮对读屏器与测试都没有「选中」
 * 这件事。收编成 Picker 之前先把行为钉住:四档的文案与色、跟随全局回 null、
 * 不给 allowInherit 时那颗不出现。
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { LOG_LEVEL_TONE } from "../../config/log-levels";
import { i18n } from "../../i18n";
import { LogLevelPicker } from "../forms";

beforeEach(() => i18n.set({ locale: "zh-CN", voice: "plain" }));
afterEach(cleanup);

/** jsdom 会把 style 里的 hex 归一成 rgb(),两边同样过一遍才比得了。 */
function asRgb(color: string): string {
	const probe = document.createElement("div");
	probe.style.color = color;
	return probe.style.color;
}

describe("LogLevelPicker", () => {
	it("四档按 L1→L4 排,文案与配色取自共用色表", () => {
		render(<LogLevelPicker value={3} onChange={() => {}} />);
		const labels = screen.getAllByRole("button").map((b) => b.textContent);
		expect(labels).toEqual(["L1 · 错误", "L2 · 告警", "L3 · 信息", "L4 · 调试"]);
		// 选中那颗的字色是 inline 的语义色 —— 逐项动态,只有这一种颜色能落 inline。
		expect(screen.getByText("L3 · 信息").style.color).toBe(asRgb(LOG_LEVEL_TONE.info));
	});

	it("点某一档回传那一档的数值", () => {
		const onChange = vi.fn();
		render(<LogLevelPicker value={3} onChange={onChange} />);
		fireEvent.click(screen.getByText("L1 · 错误"));
		expect(onChange).toHaveBeenCalledWith(1);
	});

	it("allowInherit 才有「跟随全局」,点它回 null", () => {
		const onChange = vi.fn();
		const { unmount } = render(<LogLevelPicker value={2} onChange={onChange} />);
		expect(screen.queryByText("跟随全局")).toBeNull();
		unmount();

		render(<LogLevelPicker value={null} onChange={onChange} allowInherit />);
		fireEvent.click(screen.getByText("跟随全局"));
		expect(onChange).toHaveBeenCalledWith(null);
	});

	/** 收编后补上的:选中态得是可查询的事实,不能只体现在 class 串上。 */
	it("选中态挂 aria-pressed", () => {
		render(<LogLevelPicker value={2} onChange={() => {}} allowInherit />);
		expect(screen.getByText("L2 · 告警").getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByText("L4 · 调试").getAttribute("aria-pressed")).toBe("false");
		expect(screen.getByText("跟随全局").getAttribute("aria-pressed")).toBe("false");
	});

	it("value=null + allowInherit 时选中的是「跟随全局」", () => {
		render(<LogLevelPicker value={null} onChange={() => {}} allowInherit />);
		expect(screen.getByText("跟随全局").getAttribute("aria-pressed")).toBe("true");
	});

	it("外壳与 Picker 是同一副:一排里只有按钮,没有别的可聚焦元素", () => {
		render(<LogLevelPicker value={1} onChange={() => {}} allowInherit />);
		expect(screen.getAllByRole("button")).toHaveLength(5);
	});
});

it("log level labels follow the current language while numeric selection and inheritance remain unchanged", () => {
	i18n.set({ locale: "en", voice: "plain" });
	const onChange = vi.fn();
	render(<LogLevelPicker value={2} onChange={onChange} allowInherit />);
	for (const [locale, labels] of [
		["en", ["Inherit global", "L1 · Error", "L2 · Warning", "L3 · Info", "L4 · Debug"]],
		["ja", ["全体設定に従う", "L1 · エラー", "L2 · 警告", "L3 · 情報", "L4 · デバッグ"]],
		["zh-TW", ["跟隨全域", "L1 · 錯誤", "L2 · 警告", "L3 · 資訊", "L4 · 偵錯"]],
	] as const) {
		act(() => i18n.set({ locale }));
		expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(labels);
		expect(screen.getByRole("button", { name: labels[2] }).getAttribute("aria-pressed")).toBe(
			"true",
		);
		expect(onChange).not.toHaveBeenCalled();
	}
	fireEvent.click(screen.getByRole("button", { name: "跟隨全域" }));
	expect(onChange).toHaveBeenCalledWith(null);
	fireEvent.click(screen.getByRole("button", { name: "L4 · 偵錯" }));
	expect(onChange).toHaveBeenLastCalledWith(4);
	expect(onChange).toHaveBeenCalledTimes(2);
});
