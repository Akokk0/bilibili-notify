// @vitest-environment jsdom

/**
 * 直播总结模板「可用变量」速查面板回归测试。该面板曾停留在 koishi 旧版的 `-dmc` 写法,
 * 与默认模板(globals.ts 的 `{dmc}`)及渲染器主写法割裂;此测试钉住新的 `{}` 写法,
 * 防止再退回 legacy `-key`。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { SummaryVariableHints } from "../sections";

afterEach(cleanup);

describe("SummaryVariableHints", () => {
	it("advertises the brace-style summary variables", () => {
		render(<SummaryVariableHints />);
		for (const code of ["{dmc}", "{mdn}", "{dca}", "{un1..5}", "{dc1..5}"]) {
			expect(screen.getByText(code)).toBeTruthy();
		}
	});

	it("does not show legacy dash-prefixed placeholders", () => {
		const { container } = render(<SummaryVariableHints />);
		// legacy 渲染器仍兼容 `-key`,但 UI 不再宣传它,以免与默认模板/文档矛盾。
		expect(container.textContent).not.toContain("-dmc");
		expect(container.textContent).not.toContain("-un1");
	});
});
