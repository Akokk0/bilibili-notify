// @vitest-environment jsdom

/**
 * 主题适配守卫(web 留守侧)—— forms 复合件不许出现「只在浅色下成立」的工具类。
 * 基础原子(Btn / Input / Section / Row / ModalShell)的同款守卫已随组件搬进
 * packages/ui(src/__tests__/theme-atoms.test.tsx)。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ArrayEditor, LogLevelPicker, Picker, TArea, TInput, TSelect } from "../forms";

const LIGHT_ONLY_CLASS_RE =
	/\b(?:bg-white(?:\/\d+)?|bg-gray-(?:50|100|200|300)|border-gray-(?:100|200|300)|text-gray-(?:600|700|800|900)|bg-amber-(?:50|100)|text-amber-(?:700|800|900)|hover:bg-black\/5|hover:bg-gray-50)\b/;

function expectNoLightOnlyClass(el: Element | null): void {
	expect(el).not.toBeNull();
	expect(el?.getAttribute("class") ?? "").not.toMatch(LIGHT_ONLY_CLASS_RE);
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("theme-aware form components", () => {
	it("form inputs and pickers use theme-aware surfaces", () => {
		render(
			<div>
				<TInput value="" onChange={() => {}} placeholder="输入" />
				<TArea value="" onChange={() => {}} placeholder="多行" />
				<TSelect value="a" onChange={() => {}} options={[{ value: "a", label: "A" }]} />
				<Picker value="a" onChange={() => {}} options={[{ value: "a", label: "A" }]} />
				<LogLevelPicker value={3} onChange={() => {}} allowInherit />
				<ArrayEditor value={["x"]} onChange={() => {}} />
			</div>,
		);

		for (const el of [
			screen.getByPlaceholderText("输入"),
			screen.getByPlaceholderText("多行"),
			screen.getByRole("combobox"),
			screen.getByRole("button", { name: "A" }),
			screen.getByText("L3 · 信息").parentElement,
			screen.getByRole("button", { name: "移除" }),
			screen.getByRole("button", { name: /添加一行/ }),
		]) {
			expectNoLightOnlyClass(el);
		}
	});
});
