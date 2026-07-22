/**
 * 回归测试 —— HTML 正文不得吃掉 class。
 *
 * UnoCSS 的默认 extractor 不解析 HTML,把整份文档当成一锅字符切词,于是一个落单
 * 的 `[` 会被当成任意值方括号的开头,一路吃到后面第一个 `]`,把中间的类名整段
 * 并成一个无效 token。触发它的两条路都很日常:Vue 给 Fragment(`<>…</>`、数组
 * children、`.map()`)插的 SSR 锚点注释 `<!--[-->`,以及 UP 自己取的名字。
 *
 * 阴险之处在于它**几乎不报错**:类名照样写在 HTML 里,构建 / 类型 / lint 全绿,
 * 被吞的类名只要在卡片别处复用过,规则就被别处带出来 —— 只有那些「全卡唯一」
 * 的类名会真的消失。锐评卡就这么中招:单人卡头像行的 `gap-[10px]` 和榜单卡
 * 标题行的 `justify-between` 各自是全卡唯一,于是头像贴着名字、标题挤在左边,
 * 而同一行的 `flex` / `items-center` 因为别处也用而看着「正常」。
 */

import { describe, expect, it } from "vite-plus/test";
import { renderCard } from "../render";
import { RoastBoardCard, RoastSoloCard } from "../templates/roast-card";

/** 取 `<style>` 里的 CSS —— 断言要看的是「规则生成了没有」,不是 HTML 里写了没有。 */
function cssOf(html: string): string {
	return html.slice(html.indexOf("<style>") + 7, html.indexOf("</style>"));
}

/** 紧跟第一个 Fragment 锚点的那个元素的 class 列表 —— 正是被吞的那一段。 */
function classesAfterAnchor(html: string): string[] {
	const m = html.match(/<!--\[--><[a-z]+[^>]*\sclass="([^"]*)"/);
	return m ? m[1].split(/\s+/).filter(Boolean) : [];
}

/** UnoCSS 输出里类名的特殊字符是反斜杠转义的:`gap-[10px]` → `.gap-\[10px\]{…}`。 */
function hasRule(css: string, cls: string): boolean {
	const selector = cls.replace(/[[\]().#%/:]/g, (c) => `\\${c}`);
	return new RegExp(`\\.${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[,{]`).test(css);
}

function soloHtml(over: Record<string, unknown> = {}): Promise<string> {
	return renderCard(
		RoastSoloCard,
		{
			days: 30,
			cardColorStart: "#A18CD1",
			cardColorEnd: "#FBC2EB",
			up: { name: "机智的党妹", color: "#bf7cff" },
			verdict: "一个月就发一条",
			score: 32,
			highlights: [],
			...over,
		},
		{ htmlWidth: 430 },
	);
}

describe("renderCard — HTML 正文不得吃掉 class", () => {
	it("单人锐评卡:头像行的每个类名都有对应 CSS 规则", async () => {
		const html = await soloHtml();
		const css = cssOf(html);
		const head = classesAfterAnchor(html);
		expect(head.length).toBeGreaterThan(0);
		for (const cls of head) {
			expect(hasRule(css, cls), `${cls} 的规则被 Fragment 锚点吞了`).toBe(true);
		}
	});

	it("UP 名字里的方括号不影响任何类名 —— 名字是用户自己取的,什么都可能有", async () => {
		// `bili-[酱]` 这种形状最毒:`-[` 紧贴,extractor 会从这里一路吃到后面
		// 第一个 `]`,把中途所有类名并成一个无效 token。
		const dirty = await soloHtml({ up: { name: "bili-[酱", color: "#bf7cff" } });
		const clean = await soloHtml({ up: { name: "普通名字", color: "#bf7cff" } });
		expect(cssOf(dirty)).toBe(cssOf(clean));
	});

	it("榜单周报卡:标题行靠 justify-between 把标题和副标题推开", async () => {
		const html = await renderCard(
			RoastBoardCard,
			{
				days: 30,
				cardColorStart: "#FF9A9E",
				cardColorEnd: "#FAD0C4",
				pigeon: { name: "甲", color: "#f00", reason: "鸽" },
				diligent: { name: "乙", color: "#0f0", reason: "勤" },
				roast: [],
				scores: [],
			},
			{ htmlWidth: 600 },
		);

		const css = cssOf(html);
		expect(css).toContain("justify-content:space-between");
		for (const cls of classesAfterAnchor(html)) {
			expect(hasRule(css, cls), `${cls} 的规则被 Fragment 锚点吞了`).toBe(true);
		}
	});
});
