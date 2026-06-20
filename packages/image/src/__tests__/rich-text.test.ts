/**
 * 回归守护 — P0-B:parseRichText 的专栏(isArticle)路径必须全文 HTML 转义。
 *
 * 关键不变量:专栏 node.text / title / emoji.icon_url 均来自 B 站 API(攻击者
 * 可控)。它们最终进入 `<div innerHTML={fullHtml}/>`,**必须**经 escapeHtml
 * 转义 —— 注入的 <script>/<iframe>/onerror/属性 breakout/@import 一律变纯文本,
 * 不得在 puppeteer 截图页内被解析执行(否则旁路 image SSRF 白名单)。
 *
 * 复发点:任何人去掉 escapeHtml、改回 `acc + node.text` 裸拼,本套立刻挂。
 * 断言落在返回 VNode 的 props.innerHTML(安全攸关字符串本身,非 SSR 产物)。
 */

import { describe, expect, it } from "vite-plus/test";
import { parseRichText } from "../rich-text";
import type { RichTextNode } from "../types";

function node(over: Partial<RichTextNode[number]>): RichTextNode[number] {
	return { orig_text: "", text: "", type: "RICH_TEXT_NODE_TYPE_TEXT", ...over };
}

function articleInnerHTML(rt: RichTextNode, title?: string): string {
	const vnode = parseRichText(rt, title, true) as unknown as {
		props?: { innerHTML?: string };
	};
	return vnode.props?.innerHTML ?? "";
}

describe("parseRichText article — HTML 转义 (P0-B)", () => {
	it("node.text 含 <script> → 转义为纯文本,不残留可执行标签", () => {
		const html = articleInnerHTML([node({ text: "<script>alert(1)</script>hello" })]);
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("</script>");
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain("hello");
	});

	it("node.text 含 <img onerror> → 整体转义", () => {
		const html = articleInnerHTML([node({ text: '<img src=x onerror="alert(1)">' })]);
		expect(html).not.toMatch(/<img[^>]+onerror/i);
		expect(html).toContain("&lt;img");
	});

	it("emoji.icon_url 含引号 breakout → 不闭合 src 属性", () => {
		const evil = '"><script>alert(1)</script><img src="';
		const html = articleInnerHTML([
			node({ emoji: { icon_url: evil, size: 1, text: ":x:", type: 1 } }),
		]);
		// 我方受控的 <img ... src="..."/> 骨架仍在,但注入的 "> 被转义
		expect(html).not.toContain('"><script>');
		expect(html).toContain("&quot;");
		expect(html).toContain("&lt;script&gt;");
	});

	it("title 含 <script> → 转义", () => {
		const html = articleInnerHTML([node({ text: "正文" })], "<script>steal()</script>");
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain("正文");
	});

	it("良性文本:& 被转义、换行仍转 <br><br>(功能不回归)", () => {
		const html = articleInnerHTML([node({ text: "a & b\nsecond" })]);
		expect(html).toContain("a &amp; b");
		expect(html).toContain("<br><br>");
		expect(html).toContain("second");
	});
});
