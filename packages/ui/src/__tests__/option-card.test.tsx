// @vitest-environment jsdom

/**
 * OptionCard —— 一张可选的卡。方块可选、说明可选,两种形态是同一件:拓展设置表单里
 * 「哪一种桥」那排(左边一枚方块 + 名字)、备份弹窗的完整/脱敏与覆盖/合并(标题 + 小字)。
 *
 * 合并前是两份各写各的(备份那份叫 ChoiceCard),这里钉住合并时定下的规矩。
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { OptionCard } from "../atoms";

afterEach(cleanup);

describe("OptionCard", () => {
	/**
	 * 选中的粉只落一处:有方块 → 方块变粉、名字留在正文色;没方块 → 标题自己变粉。
	 * 两处都粉就是一张卡上说了两遍「选中」,一处都不粉又认不出哪张被选了。
	 */
	it("没有方块:选中的粉落在标题上", () => {
		const { container } = render(<OptionCard active label="覆盖" onSelect={() => {}} />);
		expect(container.querySelector("[aria-hidden], img")).toBeNull();
		expect(screen.getByText("覆盖").className).toContain("text-bn-pink");
	});

	it("没有方块、没选中:标题是正文色,不带粉", () => {
		render(<OptionCard active={false} label="覆盖" onSelect={() => {}} />);
		const title = screen.getByText("覆盖").className;
		expect(title).toContain("text-bn-text-primary");
		expect(title).not.toContain("text-bn-pink");
	});

	it("有方块:选中的粉落在方块上,名字留在正文色", () => {
		render(<OptionCard active label="koishi" mark="koishi" onSelect={() => {}} />);
		expect(screen.getByText("ko").style.color).toBe("var(--color-bn-pink)");
		const title = screen.getByText("koishi").className;
		expect(title).toContain("text-bn-text-primary");
		expect(title).not.toContain("text-bn-pink");
	});

	/** 字号跟行数走:标题下带一行说明的两行卡,标题用 base;只有一行的用 sm。 */
	it("带说明:卡里多一行小字、标题用 base;单行卡的标题用 sm", () => {
		render(
			<>
				<OptionCard
					active={false}
					label="完整备份"
					description="含机密 · 用于灾备还原"
					onSelect={() => {}}
				/>
				<OptionCard active={false} label="koishi" mark="koishi" onSelect={() => {}} />
			</>,
		);
		const card = screen.getByRole("button", { name: /完整备份/ });
		expect(within(card).getByText("含机密 · 用于灾备还原")).toBeTruthy();
		const twoLine = screen.getByText("完整备份").className;
		expect(twoLine).toContain("text-bn-base");
		expect(twoLine).not.toContain("text-bn-sm");
		expect(screen.getByText("koishi").className).toContain("text-bn-sm");
	});
});
