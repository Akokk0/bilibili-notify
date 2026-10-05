/**
 * 正文富文本的渲染(`renderRichText`,输入是 `Post.richText` 的五种片段)。
 *
 * 两块:
 *
 * 1. **回归守护 — P0-B:专栏(`isArticle`)路径必须全文 HTML 转义。**
 *    关键不变量:专栏片段的 `text` / `title`(以及表情的 `text`)均来自 B 站 API(攻击者可控)。它们最终进入
 *    `<div innerHTML={fullHtml}/>`,**必须**经 escapeHtml 转义 —— 注入的 <script>/<iframe>/onerror/属性
 *    breakout/@import 一律变纯文本,不得在 puppeteer 截图页内被解析执行(否则旁路 image SSRF 白名单)。
 *    复发点:任何人去掉 escapeHtml、改回 `acc + node.text` 裸拼,本套立刻挂。
 *    断言落在返回 VNode 的 props.innerHTML(安全攸关字符串本身,非 SSR 产物)。
 *    表情图的地址从前也要转义;现在 `emoji` 片段只有 `text`、翻译层根本不带地址
 *    (`packages/dynamic` 的 `post-from-dynamic.test.ts` 有「breakout 地址进不了 Post」那条)。
 * 2. **不画小图标与表情图**(ADR-0021 决策 22 的 2026-10-05 🔗):`link.icon` / `emoji.image` 只收图库引用,
 *    B 站的要到 3a 才存进图库。目前链接只画文字(颜色照旧),表情当文字画它的 `text`(「[doge]」)。
 */

import type { RichText } from "@bilibili-notify/internal";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import { createSSRApp, type VNode } from "vue";
import { renderRichText } from "../rich-text";

const text = (t: string) => ({ kind: "text" as const, text: t });

function articleInnerHTML(rt: RichText, title?: string): string {
	const vnode = renderRichText(rt, title, true) as unknown as {
		props?: { innerHTML?: string };
	};
	return vnode.props?.innerHTML ?? "";
}

const htmlOf = (vnode: VNode): Promise<string> =>
	renderToString(createSSRApp({ render: () => vnode }));

describe("renderRichText article — HTML 转义 (P0-B)", () => {
	it("片段 text 含 <script> → 转义为纯文本,不残留可执行标签", () => {
		const html = articleInnerHTML([text("<script>alert(1)</script>hello")]);
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("</script>");
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain("hello");
	});

	it("片段 text 含 <img onerror> → 整体转义", () => {
		const html = articleInnerHTML([text('<img src=x onerror="alert(1)">')]);
		expect(html).not.toMatch(/<img[^>]+onerror/i);
		expect(html).toContain("&lt;img");
	});

	it("表情 text 含引号 breakout → 当文字转义,不闭合任何属性、不残留标签", () => {
		// 表情现在当文字画(`text`),不拼 <img>;值得守的是「以后有人把表情图改回拼 <img>」时地址必须转义。
		const evil = '"><script>alert(1)</script><img src="';
		const html = articleInnerHTML([{ kind: "emoji", text: evil }]);
		expect(html).not.toContain('"><script>');
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<img");
		expect(html).toContain("&quot;");
		expect(html).toContain("&lt;script&gt;");
	});

	it("title 含 <script> → 转义", () => {
		const html = articleInnerHTML([text("正文")], "<script>steal()</script>");
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain("正文");
	});

	it("良性文本:& 被转义、换行仍转 <br><br>(功能不回归)", () => {
		const html = articleInnerHTML([text("a & b\nsecond")]);
		expect(html).toContain("a &amp; b");
		expect(html).toContain("<br><br>");
		expect(html).toContain("second");
	});

	it("表情当文字拼进去(转义后),专栏路径没有 <img>", () => {
		expect(articleInnerHTML([text("前"), { kind: "emoji", text: "[脱单doge]" }, text("后")])).toBe(
			"前[脱单doge]后",
		);
		expect(articleInnerHTML([{ kind: "emoji", text: "<b>[x]</b>" }])).toBe(
			"&lt;b&gt;[x]&lt;/b&gt;",
		);
	});
});

describe("renderRichText — 链接只剩文字,表情当文字", () => {
	it("link:只剩链接文字,颜色还是 B 站蓝,没有任何图标(BV / 抽奖 / 网页都一样)", async () => {
		const html = await htmlOf(
			renderRichText([
				{ kind: "link", text: "BV1FTGM69EFQ", url: "//www.bilibili.com/video/BV1FTGM69EFQ" },
				text(" "),
				{ kind: "link", text: "互动抽奖", url: "" },
				text(" "),
				{ kind: "link", text: "网页链接", url: "https://www.bilibili.com" },
			]),
		);
		expect(html).not.toContain("<svg");
		expect(html).toContain('<span class="text-[#00AEEC]">BV1FTGM69EFQ</span>');
		expect(html).toContain('<span class="text-[#00AEEC]">互动抽奖</span>');
		expect(html).toContain('<span class="text-[#00AEEC]">网页链接</span>');
	});

	it("话题 / @ 画法不变", async () => {
		const html = await htmlOf(
			renderRichText([
				{ kind: "topic", text: "#话题#", name: "话题" },
				{ kind: "mention", text: "@某人" },
			]),
		);
		expect(html).toContain('<span class="text-[#FF6699]">#话题#</span>');
		expect(html).toContain('<span class="text-[#00AEEC]">@某人</span>');
	});

	/** 验红:把普通路径里 `emoji` 那一支改回画 `<img>`,这条红。 */
	it("普通路径:「[doge]」按文字画在原位置,没有 <img>", async () => {
		const html = await htmlOf(
			renderRichText([text("感谢大家 "), { kind: "emoji", text: "[doge]" }, text("\n下一行")]),
		);
		expect(html).not.toContain("<img");
		expect(html).toContain("感谢大家 [doge]<br>下一行");
	});

	it("表情文字和别的文字一样走九行截断", async () => {
		const lines = Array.from({ length: 12 }, (_, i) => text(`第${i + 1}行\n`));
		const html = await htmlOf(renderRichText([...lines, { kind: "emoji", text: "[doge]" }]));
		expect(html).toContain("已省略");
		expect(html).not.toContain("[doge]");
	});

	it("九行截断:第 9 行之后的字不画,末尾补一句「已省略」", async () => {
		const lines = Array.from({ length: 12 }, (_, i) => text(`第${i + 1}行\n`));
		const html = await htmlOf(renderRichText(lines));
		expect(html).toContain("第9行");
		expect(html).not.toContain("第10行");
		expect(html).toContain("...（全文过长，已省略）");
	});

	it("专栏路径五行截断:第 5 行之后的字不画,末尾补一句「已省略」", () => {
		const html = articleInnerHTML(Array.from({ length: 8 }, (_, i) => text(`第${i + 1}行\n`)));
		expect(html).toContain("第5行");
		expect(html).not.toContain("第6行");
		expect(html).toContain("已省略");
	});
});
