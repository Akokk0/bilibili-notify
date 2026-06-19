// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Btn, Input, Row, Section } from "../atoms";
import { ModalShell } from "../dialog";
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

describe("theme-aware shared components", () => {
	it("button variants use semantic surfaces instead of light-only utilities", () => {
		render(
			<div>
				<Btn variant="outline">outline</Btn>
				<Btn variant="ghost">ghost</Btn>
				<Btn variant="danger">danger</Btn>
			</div>,
		);

		expectNoLightOnlyClass(screen.getByRole("button", { name: "outline" }));
		expectNoLightOnlyClass(screen.getByRole("button", { name: "ghost" }));
		expectNoLightOnlyClass(screen.getByRole("button", { name: "danger" }));
	});

	it("atom input, section and row use theme-aware field and border utilities", () => {
		render(
			<div>
				<Input value="" onChange={() => {}} placeholder="搜索" />
				<Section label="基础">
					<Row label="一行" />
				</Section>
			</div>,
		);

		expectNoLightOnlyClass(screen.getByPlaceholderText("搜索").parentElement);
		expectNoLightOnlyClass(screen.getByText("一行").closest(".flex"));
		expect(
			screen.getByText("一行").closest(".rounded-lg")?.getAttribute("class") ?? "",
		).not.toMatch(LIGHT_ONLY_CLASS_RE);
	});

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

	it("modal card uses theme-aware surface instead of fixed white", () => {
		render(
			<ModalShell width={320} onCancel={vi.fn()}>
				<div>弹窗内容</div>
			</ModalShell>,
		);

		expectNoLightOnlyClass(screen.getByRole("dialog"));
	});
});
