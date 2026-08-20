// @vitest-environment jsdom

/**
 * 主题适配守卫 —— 库内基础件不许出现「只在浅色下成立」的工具类
 * (bg-white / border-gray-* 这种),必须走语义化 token(bn-surface / bn-border …)。
 * forms 侧的同款守卫在 apps/web/src/components/__tests__/theme-components.test.tsx。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Btn, Input, Row, Section, Toggle } from "../atoms";
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

/**
 * 开关是**全站铺得最开**的一件,而它有两处够不到皮肤:
 *
 * ① 关闭态的轨道写死 `#d8d8d8` —— 同一个函数里,开启态的注释已经写明「走 token
 *    而不是字面值」,关闭态却自己破了例;
 * ② 圆角写在 **inline style** 上。inline 压过一切 author 样式,皮肤把 radius.pill
 *    调到 0 也掰不直它 —— 与 TabButton 那次(选中态渐变写在 inline 上)同一个模式,
 *    这已经是第三回。
 *
 * 真机症状:像素风皮肤整站硬直角,唯独每一颗开关还是圆的、还是那个灰。
 */
describe("Toggle 够得到皮肤", () => {
	it("轨道两态都走 token,不写死颜色", () => {
		const { rerender } = render(<Toggle value={false} onChange={() => {}} ariaLabel="开关" />);
		expect(screen.getByLabelText("开关").style.background).toContain("var(");
		rerender(<Toggle value={true} onChange={() => {}} ariaLabel="开关" />);
		expect(screen.getByLabelText("开关").style.background).toContain("var(");
	});

	it("圆角走 pill 轴的 class,不落在 inline style 上", () => {
		render(<Toggle value={false} onChange={() => {}} ariaLabel="开关" />);
		const track = screen.getByLabelText("开关");
		expect(track.style.borderRadius).toBe("");
		expect(track.className).toContain("rounded-bn-pill");
		// 滑块同理 —— 只掰直轨道的话,方轨道里滚着个圆球。
		const knob = track.querySelector("span");
		expect(knob?.className ?? "").toContain("rounded-bn-pill");
	});
});
