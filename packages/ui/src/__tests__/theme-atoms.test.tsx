// @vitest-environment jsdom

/**
 * 主题适配守卫 —— 库内基础件不许出现「只在浅色下成立」的工具类
 * (bg-white / border-gray-* 这种),必须走语义化 token(bn-surface / bn-border …)。
 * forms 侧的同款守卫在 apps/web/src/components/__tests__/theme-components.test.tsx。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Btn, Input, Row, Section } from "../atoms";
import { ModalShell } from "../dialog";

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

describe("theme-aware ui atoms", () => {
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

	it("modal card uses theme-aware surface instead of fixed white", () => {
		render(
			<ModalShell width={320} onCancel={vi.fn()}>
				<div>弹窗内容</div>
			</ModalShell>,
		);

		expectNoLightOnlyClass(screen.getByRole("dialog"));
	});
});
