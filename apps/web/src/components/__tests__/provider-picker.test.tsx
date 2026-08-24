// @vitest-environment jsdom

/**
 * 服务商候选卡 —— 它挂着 `option` / `option-active`,但选中态此前**只买到一半**:
 * 底色与那圈 2px 环写在 `style` 里(品牌色),而 inline 压过一切 author 样式、
 * 清洗层又会摘掉皮肤写的 `!important` —— 皮肤改得到圆角与未选中态,唯独改不动
 * 选中那一颗的底。整页换了装,这一排还是原来的六块品牌色。
 *
 * 修法不是把品牌色写死成 token(那等于让卡片说谎,同 Pill / StatsBar 那条),
 * 而是**把颜色和涂法拆开**:品牌色进 `--bn-tint` 这个自定义属性(inline 里只剩
 * 一个值,不再是一条 `background` 声明),涂法进 `@utility`。工具类落在
 * `@layer utilities`,而皮肤 CSS 是**无层**的 —— 无层恒压过任何分层,于是皮肤
 * 想重画选中底就画得动,不想画就仍是品牌色。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ProviderPicker } from "../provider-picker";

afterEach(cleanup);

function cardOf(label: string): HTMLElement {
	return screen.getByRole("button", { name: new RegExp(label) });
}

describe("服务商候选卡的选中态够得到皮肤", () => {
	it("选中那颗的底与环不在 inline 上 —— 皮肤才盖得动", () => {
		render(<ProviderPicker value="openrouter" onChange={() => {}} />);
		const card = cardOf("OpenRouter");
		expect(card.style.background).toBe("");
		expect(card.style.backgroundColor).toBe("");
		expect(card.style.boxShadow).toBe("");
	});

	it("品牌色改走 --bn-tint,而且逐家不同 —— 不是被抹成一个通用色", () => {
		render(<ProviderPicker value="openrouter" onChange={() => {}} />);
		const openrouter = cardOf("OpenRouter").style.getPropertyValue("--bn-tint");
		const silicon = cardOf("硅基流动").style.getPropertyValue("--bn-tint");
		expect(openrouter).not.toBe("");
		expect(silicon).not.toBe("");
		expect(openrouter).not.toBe(silicon);
	});

	it("涂法走工具类,只落在选中那一颗上", () => {
		render(<ProviderPicker value="openrouter" onChange={() => {}} />);
		expect(cardOf("OpenRouter").className).toContain("bn-tint-ring");
		expect(cardOf("硅基流动").className).not.toContain("bn-tint-ring");
	});

	/**
	 * className 断言有个盲点:类名拼错、或者 `@utility` 压根没写,测试照样绿而
	 * 页面上什么都不会发生。所以再钉一遍「这个类真的有定义」—— 同
	 * `color-token-conformance` 钉 `z-bn-*` 在表里真有那一档。
	 */
	it("用到的 bn-tint-* 工具类在 styles.css 里真有定义", () => {
		const webSrc = join(dirname(fileURLToPath(import.meta.url)), "../..");
		const css = readFileSync(join(webSrc, "styles.css"), "utf8");
		expect(css).toContain("@utility bn-tint-ring");
	});
});
