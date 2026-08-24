// @vitest-environment jsdom

/**
 * tab 条上那颗小码(ScopeTabs 的「default」、AI 页的域名)。
 *
 * 它的字是**继承**来的,所以可读性顶多等于旁边的标签 —— 底只要偏离父底,就一定有
 * 一边被拉低。原先选中态盖着一层 25% 白纱,正是往错的方向偏:选中块是中等亮度的
 * 强调色,叠白只把底推向白字那一边。实测(默认粉底)旁边的标签 2.64:1,这颗小码
 * 2.08:1 —— 整条 tab 上最难认的偏偏是它。
 *
 * 皮肤把字色改深时,那层白纱又碰巧帮上忙(5.4:1)。所以任何固定方向的纱都只是在
 * 两种装扮之间挑一个来牺牲,而去掉底两边都回到「和旁边标签一样」。
 *
 * 未选中态的底留着:那时父底是页面色,浅底块是它与标签之间唯一的分隔。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { TabBar } from "../tab-bar";

afterEach(() => cleanup());

const items = [
	{ id: "a", label: "全局", code: "default" },
	{ id: "b", label: "咩栗", code: "9617619" },
] as const;

function mount(value: "a" | "b") {
	render(<TabBar items={items} value={value} onChange={() => {}} />);
}

describe("tab 上的小码", () => {
	it("选中那格不给底 —— 任何纱都只会把它压到比旁边的标签更难认", () => {
		mount("a");
		const chip = screen.getByText("default");

		// 认 `bg-` 而不是某个具体的类:换成别的底色一样会重新引入那个偏移。
		expect(chip.className).not.toMatch(/\bbg-/);
		// 前景也不许自带 —— 字继承父那一层,皮肤改 tab-active 的色它才跟得上。
		expect(chip.className).not.toMatch(/\btext-bn-(text-|pink\b|on-solid\b)/);
	});

	it("没选中那格照旧有底 —— 别把两态一起删了", () => {
		mount("a");

		// 那时父底是页面色,这块浅底是小码与标签之间唯一的分隔。
		expect(screen.getByText("9617619").className).toContain("bg-bn-code-bg");
	});

	it("换一格选中,让位的跟着换", () => {
		mount("b");

		expect(screen.getByText("9617619").className).not.toMatch(/\bbg-/);
		expect(screen.getByText("default").className).toContain("bg-bn-code-bg");
	});
});
