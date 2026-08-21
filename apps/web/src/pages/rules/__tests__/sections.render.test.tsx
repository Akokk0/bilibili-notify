// @vitest-environment jsdom

/**
 * 直播总结模板「可用变量」速查面板回归测试。该面板曾停留在 koishi 旧版的 `-dmc` 写法,
 * 与默认模板(globals.ts 的 `{dmc}`)及渲染器主写法割裂;此测试钉住新的 `{}` 写法,
 * 防止再退回 legacy `-key`。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { StopWordsHint, SummaryVariableHints } from "../sections";

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

/**
 * 提示条的**标题色必须是派生的**。
 *
 * 站里两条提示条(紫的「可用变量」、青的「词云停用词」)长得一模一样,但只有前者把三处
 * 颜色都从一个 accent `color-mix` 出来。后者三个色是手挑的字面量,其中标题那枚
 * `#076e94` 是深青 —— 亮色下压在 10% 青底上正合适,暗色下页面本身就是黑的,那层半透明
 * 底根本挡不住,深青字直接糊进背景。同一个病 `#946800` 已经在别处犯过一次了。
 *
 * 派生式(`color-mix(… , var(--color-bn-text-primary))`)天生免疫:亮色下往黑里调、
 * 暗色下往白里调,accent 换成什么色都跟得住。
 */
describe("提示条标题色", () => {
	const titleColor = (node: HTMLElement) =>
		(node.querySelector("span.font-bold") as HTMLElement | null)?.style.color ?? "";

	it("词云停用词条的标题色是派生的,不是写死的深色", () => {
		const { container } = render(<StopWordsHint />);
		const color = titleColor(container);
		expect(color).toContain("color-mix");
		// 往正文色里调 —— 这一步就是暗色下自动提亮的来源。
		expect(color).toContain("--color-bn-text-primary");
	});

	it("和「可用变量」条走同一套派生 —— 两条提示条不许各挑各的色", () => {
		const stop = render(<StopWordsHint />).container;
		const vars = render(<SummaryVariableHints />).container;
		const shape = (c: string) => c.replace(/var\(--color-bn-[a-z-]+\)|#[0-9a-fA-F]{3,8}/g, "@");
		expect(shape(titleColor(stop))).toBe(shape(titleColor(vars)));
	});

	it("底与边也跟着 accent 走,不写死 hex", () => {
		const { container } = render(<StopWordsHint />);
		const bar = container.firstElementChild as HTMLElement;
		expect(bar.style.background).toContain("color-mix");
		expect(bar.style.borderColor).toContain("color-mix");
	});
});
