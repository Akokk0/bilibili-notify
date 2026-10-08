/**
 * 正文富文本的渲染(`renderRichText`,输入是 `Post.richText` 的五种片段)。
 *
 * 两块:
 *
 * 1. **回归守护 — P0-B:专栏(`isArticle`)路径必须全文 HTML 转义。**
 *    关键不变量:专栏片段的 `text` / `title`(以及表情的 `text`)均来自 B 站 API(攻击者可控)。它们最终进入
 *    `<div innerHTML={fullHtml}/>`,**必须**经 escapeHtml 转义 —— 注入的 <script>/<iframe>/onerror/属性
 *    breakout/@import 一律变纯文本,不得在 puppeteer 截图页内被解析执行(渲染页的请求闸只挡得住它往外发请求,挡不住脚本在页内跑)。
 *    复发点:任何人去掉 escapeHtml、改回 `acc + node.text` 裸拼,本套立刻挂。
 *    断言落在返回 VNode 的 props.innerHTML(安全攸关字符串本身,非 SSR 产物)。
 *    表情图的地址同样要转义:地址是宿主注入的解析口给的(图库引用 → data URL),虽然不是攻击者直接写的,
 *    仍按「拼进 innerHTML 的一律转义」处理(`escapeHtml(src)`,下面「专栏里的表情图」那几条钉着)。
 * 2. **小图标与表情图只认图库引用**(ADR-0021 决策 22 的 2026-10-05 🔗,㉑d):`link.icon` / `emoji.image` 是引用,
 *    经调用方给的 `imageUrl` 解析;解析得到就画图,解析不到(或根本没给解析口)就退成文字 —— 链接只画文字(颜色照旧),
 *    表情当文字画它的 `text`(「[doge]」)。B 站的要到 3a 才存进图库,目前没有来源给。
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

describe("renderRichText — 没有解析口 / 没有引用:链接只剩文字,表情当文字", () => {
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

	/** 验红:把普通路径里没有引用的 `emoji` 那一支改成画 `<img>`,这条红。 */
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

/**
 * 有引用、解析口给得出地址:画图(㉑d)。解析口是同步查表(出图器事先把引用都解析成地址),解析不到就回
 * `undefined`,退成文字。
 */
describe("renderRichText — 图库引用解析得到就画图,解析不到退成文字", () => {
	const ICON = "data:image/png;base64,SUNPTg==";
	const EMOJI = "data:image/png;base64,RU1PSkk=";
	const table: Record<string, string> = { "icon.png": ICON, "emoji.png": EMOJI };
	const imageUrl = (ref: string) => table[ref];

	it("普通路径:表情有图就画成行内小图(不再画它的文字),位置不变", async () => {
		const html = await htmlOf(
			renderRichText(
				[text("感谢 "), { kind: "emoji", text: "[doge]", image: "emoji.png" }, text(" 大家")],
				undefined,
				false,
				imageUrl,
			),
		);
		// SSR 把空的 alt 写成裸属性。
		expect(html).toContain(
			`感谢 <img class="inline w-[17px] h-[17px] align-middle" src="${EMOJI}" alt> 大家`,
		);
		expect(html).not.toContain("[doge]");
	});

	it("普通路径:链接有图标就在文字前画小图,颜色照旧;整条链接只画一个图标(换行也一样)", async () => {
		const html = await htmlOf(
			renderRichText(
				[{ kind: "link", text: "互动\n抽奖", url: "u", icon: "icon.png" }],
				undefined,
				false,
				imageUrl,
			),
		);
		expect(html.match(/<img/g)).toHaveLength(1);
		// 图标在第一段字前面,同在蓝色的 span 里。
		expect(html).toMatch(
			new RegExp(
				`<span class="text-\\[#00AEEC\\]">(?:<!--\\[-->)?<img style="[^"]*" src="${ICON}" alt>互动`,
			),
		);
		expect(html).toContain('<span class="text-[#00AEEC]">抽奖</span>');
	});

	it("解析不到(引用不在表里 / 没给解析口):表情退回文字,链接退回只有文字,都不抛", async () => {
		const rt: RichText = [
			{ kind: "link", text: "链接", url: "u", icon: "gone.png" },
			{ kind: "emoji", text: "[doge]", image: "gone.png" },
		];
		for (const resolver of [imageUrl, undefined]) {
			const html = await htmlOf(renderRichText(rt, undefined, false, resolver));
			expect(html).not.toContain("<img");
			expect(html).toContain('<span class="text-[#00AEEC]">链接</span>');
			expect(html).toContain("[doge]");
		}
	});

	it("专栏里的表情图:拼一个受控的 <img>,地址转义;解析不到当文字(同样转义)", () => {
		const withImage = articleInnerHTML([
			text("前"),
			{ kind: "emoji", text: "[doge]", image: "emoji.png" },
		]);
		// 不给解析口:退成文字。
		expect(withImage).toBe("前[doge]");
		const vnode = renderRichText(
			[
				text("前"),
				{ kind: "emoji", text: "[doge]", image: "emoji.png" },
				{ kind: "emoji", text: "<b>[x]</b>", image: "gone.png" },
			],
			undefined,
			true,
			imageUrl,
		) as unknown as { props?: { innerHTML?: string } };
		expect(vnode.props?.innerHTML).toBe(
			`前<img style="width:17px;height:17px;display:inline;vertical-align:middle" src="${EMOJI}"/>&lt;b&gt;[x]&lt;/b&gt;`,
		);
	});

	it("专栏里的表情图地址含引号 / 尖括号也出不了 src 属性(拼进 innerHTML 的一律转义)", () => {
		const evil = 'x" onerror="alert(1)"><script>alert(2)</script>';
		const vnode = renderRichText(
			[{ kind: "emoji", text: "[doge]", image: "emoji.png" }],
			undefined,
			true,
			() => evil,
		) as unknown as { props?: { innerHTML?: string } };
		const html = vnode.props?.innerHTML ?? "";
		expect(html).not.toContain("<script>");
		expect(html).not.toMatch(/"\s*onerror=/);
		expect(html).toContain("&quot;");
	});
});
