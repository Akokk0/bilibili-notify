/**
 * **皮肤压得过的那条线**(ADR-0014 决策 13 的 🔗)。
 *
 * 清洗器一律摘 `!important`,所以**只要属性写在 inline style 上,皮肤就永远压不过它**。
 * 一步半那轮把内置块里 33 处颜色改成了「值留 inline 的 `--bn-*` 变量、属性写在 class 上」,
 * 留了两处没改(2026-09-14 记在 ADR 的欠账里):九宫格 `+N` 那层的文字投影、专栏正文拼进
 * `innerHTML` 的标题与「已省略」灰字。这份钉的是它们现在的形状。
 *
 * 两头都要断言:**inline 里没有了**(不然皮肤压不过),**CSS 规则真生成了**(不然那句样式
 * 静悄悄消失 —— UnoCSS 的切词按分隔符走,类名进不了产物是构建全绿的那种坏法)。
 */

import { describe, expect, it } from "vite-plus/test";
import { CARD_FIXTURES } from "./fixtures/card-fixtures";
import { renderViaSkin } from "./fixtures/skin-render";

/** `<style>` 里那段 CSS —— 要看的是「规则生成了没有」,不是 HTML 里写了没有。 */
function cssOf(html: string): string {
	return html.slice(html.indexOf("<style>") + 7, html.indexOf("</style>"));
}

async function renderFixture(name: string): Promise<string> {
	const fixture = CARD_FIXTURES.find((f) => f.name === name);
	if (!fixture) throw new Error(`夹具表里没有 ${name}`);
	return await renderViaSkin(fixture, await fixture.build());
}

describe("九宫格 +N 那层的文字投影", () => {
	it("属性在 class 上、值在变量里 —— inline 里不留 text-shadow", async () => {
		const html = await renderFixture("dynamic-draw");
		expect(html).toContain("--bn-pics-more-shadow:");
		expect(html).not.toMatch(/style="[^"]*\btext-shadow\s*:/);
	});

	it("那条规则真生成了 —— 类名被切词吃掉的话投影会静悄悄消失", async () => {
		const css = cssOf(await renderFixture("dynamic-draw"));
		expect(css).toContain("text-shadow:var(--bn-pics-more-shadow)");
	});
});

describe("专栏正文拼进 innerHTML 的那两处", () => {
	it("标题与「已省略」灰字都不再 inline", async () => {
		const html = await renderFixture("dynamic-article");
		expect(html).not.toContain('style="color:#999"');
		expect(html).not.toContain('style="font-size:18px');
	});

	it("它们的规则真生成了", async () => {
		const html = await renderFixture("dynamic-article");
		const css = cssOf(html);
		// 标题:字号 / 字重 / 下边距三条
		expect(css).toContain("font-size:18px");
		expect(css).toContain("margin-bottom:8px");
		// 灰字与非专栏那条路同一个类,两条路的可染性一致
		expect(html).toContain('class="text-[#999]"');
	});
});
