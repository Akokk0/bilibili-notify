/**
 * 自定义块的 HTML 清洗层(ADR-0014 决策 11 / 12)。
 *
 * 判据是「**把实现改坏能红**」:每条都挑一个真到不了浏览器就会出事的形状 ——
 * 标签白名单漏一个 `<script>` 就等于给 `--no-sandbox` 的 puppeteer 开门,`src` 的
 * 类型闸一松就把直播标题当 URL 发出去。
 */

import { CARD_SKIN_LIMITS } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { sanitizeCardBlockHtml } from "../html-sanitizer.js";

const ASSETS = new Set(["bg.png", "sticker.webp"]);

function run(input: string, kind: "live" | "sc" = "live") {
	return sanitizeCardBlockHtml(input, { kind, assets: ASSETS });
}

function ok(input: string, kind: "live" | "sc" = "live") {
	const res = run(input, kind);
	expect(res.ok, res.ok ? "" : res.errors.join(" / ")).toBe(true);
	if (!res.ok) throw new Error("unreachable");
	return { html: res.html, warnings: res.warnings };
}

function bad(input: string, kind: "live" | "sc" = "live") {
	const res = run(input, kind);
	expect(res.ok).toBe(false);
	if (res.ok) throw new Error("unreachable");
	return res.errors;
}

describe("标签白名单", () => {
	it("<script> 连同里面的代码一起丢 —— 出图的 puppeteer 是 --no-sandbox 的", () => {
		const { html, warnings } = ok('<div>好</div><script>fetch("https://evil.example")</script>');
		expect(html).toBe("<div>好</div>");
		expect(html).not.toContain("evil.example");
		expect(warnings.join()).toContain("script");
	});

	it("<iframe> 整个丢弃", () => {
		const { html, warnings } = ok('<span>x</span><iframe src="https://evil.example"></iframe>');
		expect(html).toBe("<span>x</span>");
		expect(warnings.join()).toContain("iframe");
	});

	it("<a href> 整个丢弃 —— 连同链接文字(不在名单的标签是丢子树,不是脱壳)", () => {
		const { html, warnings } = ok('<div>留下</div><a href="https://evil.example">点我</a>');
		expect(html).toBe("<div>留下</div>");
		expect(html).not.toContain("点我");
		expect(warnings.join()).toContain("<a>");
	});

	it("嵌套在合法标签里的非法标签同样丢子树,外壳与合法兄弟照留", () => {
		const { html } = ok("<div>前<object data=x><b>藏在里面</b></object>后</div>");
		expect(html).toBe("<div>前后</div>");
		expect(html).not.toContain("藏在里面");
	});

	it("<svg> 这种异命名空间的壳也丢", () => {
		const { html } = ok("<div>a</div><svg><text>b</text></svg>");
		expect(html).toBe("<div>a</div>");
	});

	/**
	 * 内联 svg 是「开放重写」里**单列最后一片、可砍**的那一片(ADR-0014 决策 11 的 🔗)——
	 * 这一轮没做,所以它连同事件属性一起整段丢。事件属性这一条不看标签:`onload` 挂在
	 * 哪里都是给 `--no-sandbox` 的 puppeteer 开门。
	 */
	it("<svg onload=…> 连壳带事件属性整段丢 —— svg 这轮不做", () => {
		const { html, warnings } = ok(
			'<p>留下</p><svg onload="fetch(\'https://evil.example\')"><circle r="4"></circle></svg>',
		);
		expect(html).toBe("<p>留下</p>");
		expect(html).not.toContain("onload");
		expect(html).not.toContain("evil.example");
		expect(warnings.join()).toContain("svg");
	});

	/**
	 * 放宽的是**排版语义**那一批(ADR-0014 决策 11 的 🔗:列表 / 标题 / 表格 / 分节 /
	 * 引用 / 代码…)。地板没动:脚本、外链、内嵌文档、表单、音视频一个都不进来。
	 */
	it("排版语义标签整批保留:标题 / 列表 / 表格 / 分节 / 引用 / 代码 / 行内标注", () => {
		const input =
			"<section><header><h1>标题一</h1><h2>标题二</h2><h3>三</h3><h4>四</h4><h5>五</h5><h6>六</h6></header>" +
			"<article><ul><li>甲</li></ul><ol><li>乙</li></ol><hr>" +
			"<table><thead><tr><th>列</th></tr></thead><tbody><tr><td>格</td></tr></tbody></table>" +
			"<blockquote><p>引</p></blockquote><pre><code>code()</code></pre>" +
			'<figure><img src="asset:bg.png"><figcaption>图注</figcaption></figure>' +
			"<p><sup>上</sup><sub>下</sub><mark>标</mark><del>删</del><ins>增</ins><time>09-13</time><abbr>缩</abbr></p>" +
			"</article><footer>脚</footer></section>";
		const { html, warnings } = ok(input);
		for (const tag of [
			"section",
			"header",
			"h1",
			"h6",
			"article",
			"ul",
			"ol",
			"li",
			"hr",
			"table",
			"thead",
			"tbody",
			"tr",
			"th",
			"td",
			"blockquote",
			"pre",
			"code",
			"figure",
			"figcaption",
			"sup",
			"sub",
			"mark",
			"del",
			"ins",
			"time",
			"abbr",
			"footer",
		]) {
			expect(html, tag).toContain(`<${tag}`);
		}
		expect(warnings).toEqual([]);
	});

	it("地板没松:style / link / form / video / audio / embed 连子树一起丢", () => {
		for (const [evil, needle] of [
			["<style>.x{color:red}</style>", "style"],
			['<link rel="stylesheet" href="https://evil.example/x.css">', "link"],
			['<form action="https://evil.example"><input></form>', "form"],
			['<video src="https://evil.example/x.mp4"></video>', "video"],
			['<audio src="https://evil.example/x.mp3"></audio>', "audio"],
			['<embed src="https://evil.example/x.swf">', "embed"],
		] as const) {
			const { html, warnings } = ok(`<div>留下</div>${evil}`);
			expect(html, evil).toBe("<div>留下</div>");
			expect(html, evil).not.toContain("evil.example");
			expect(warnings.join(), evil).toContain(needle);
		}
	});
});

describe("属性白名单", () => {
	it("事件属性 / id / data-* / target 一律丢,元素本身留下", () => {
		const { html, warnings } = ok(
			'<div id="x" data-bn="glass" onclick="alert(1)" target="_blank" class="a">文字</div>',
		);
		expect(html).toBe('<div class="a">文字</div>');
		for (const dropped of ["id", "data-bn", "onclick", "target"]) {
			expect(warnings.join(), dropped).toContain(dropped);
		}
	});

	it("img 上的 onerror 丢掉,图本身照留 —— 正则过滤挡不住的就是这一类", () => {
		const { html } = ok('<img src="asset:bg.png" onerror="alert(1)" alt="底图">');
		expect(html).toBe('<img src="asset:bg.png" alt="底图">');
		expect(html).not.toContain("onerror");
	});

	it("srcset 丢掉 —— 它是 src 之外的第二条取网路", () => {
		const { html, warnings } = ok('<img src="asset:bg.png" srcset="https://evil.example/x 2x">');
		expect(html).not.toContain("srcset");
		expect(html).not.toContain("evil.example");
		expect(warnings.join()).toContain("srcset");
	});

	/**
	 * `colspan` / `rowspan` 是**只给 td / th** 的两格,而且只准正整数:`colspan="0"`
	 * 在 HTML 里有「铺满整列组」的特殊含义,负数 / 非数字浏览器各有各的容错 ——
	 * 一张画出来的表跟作者以为的不是一回事,不如整格丢掉。
	 */
	it("td / th 的 colspan / rowspan 放行,值只准正整数", () => {
		const { html } = ok('<table><tr><td colspan="2" rowspan="3">格</td></tr></table>');
		expect(html).toContain('colspan="2"');
		expect(html).toContain('rowspan="3"');
	});

	it("colspan 不是正整数 → 丢掉这一格属性,单元格本身照留", () => {
		for (const bad of ['colspan="x"', 'colspan="0"', 'colspan="-1"', 'colspan="2.5"']) {
			const { html, warnings } = ok(`<table><tr><td ${bad}>格</td></tr></table>`);
			expect(html, bad).toContain("<td>格</td>");
			expect(html, bad).not.toContain("colspan");
			expect(warnings.join(), bad).toContain("colspan");
		}
	});

	it("colspan 只属于 td / th —— 写在 div 上照丢", () => {
		const { html, warnings } = ok('<div colspan="2">x</div>');
		expect(html).toBe("<div>x</div>");
		expect(warnings.join()).toContain("colspan");
	});

	it("class 只准 [A-Za-z0-9_-] 的 token;掺了别的整个属性丢", () => {
		expect(ok('<div class="ok-1 b_2">x</div>').html).toBe('<div class="ok-1 b_2">x</div>');
		const { html, warnings } = ok('<div class="a.b{live.title}">x</div>');
		expect(html).toBe("<div>x</div>");
		expect(warnings.join()).toContain("class");
	});
});

describe("style 交给 CSS 那一层的声明级过滤", () => {
	it("合规声明留下", () => {
		const { html } = ok('<div style="color:#fb7299;border-radius:8px">x</div>');
		expect(html).toContain("color:#fb7299");
		expect(html).toContain("border-radius:8px");
	});

	it("url() 丢掉 —— 外联取网面任何情况下不放行", () => {
		const { html, warnings } = ok(
			'<div style="background:url(https://evil.example/x.png);color:#fff">x</div>',
		);
		expect(html).not.toContain("url(");
		expect(html).not.toContain("evil.example");
		expect(html).toContain("color:#fff");
		expect(warnings.join()).toContain("url");
	});

	it("position 与布局属性放行(卡片皮肤管的就是布局),sticky / fixed 仍不行", () => {
		const { html, warnings } = ok(
			'<div style="position:absolute;top:0;padding:4px;color:#fff">x</div><b style="position:fixed">y</b>',
		);
		expect(html).toContain("position:absolute;top:0;padding:4px;color:#fff");
		expect(html).not.toContain("fixed");
		expect(warnings.join()).toContain("position");
	});

	it("黑名单上的执行面属性丢掉;全丢光则整个 style 不落盘", () => {
		const { html, warnings } = ok(
			'<div style="behavior:url(x.htc);-moz-binding:url(x.xml)">x</div>',
		);
		expect(html).toBe("<div>x</div>");
		expect(warnings.join()).toContain("behavior");
	});

	/**
	 * `style=""` 与块级 CSS 是**同一份规格**({@link CARD_DECL_OPTIONS}),所以属性从
	 * 白名单改黑名单这件事必须在这一层也看得见 —— 两边各写一份名单就是它破的方式。
	 */
	it("属性黑名单化在 style 里同样生效:pointer-events / cursor / mask-image 现在落盘", () => {
		const { html, warnings } = ok(
			'<div style="pointer-events:none;cursor:pointer;mask-image:linear-gradient(#000,transparent)">x</div>',
		);
		expect(html).toContain("pointer-events:none");
		expect(html).toContain("cursor:pointer");
		expect(html).toContain("mask-image:");
		expect(warnings).toEqual([]);
	});
});

describe("img 的 src 只准两种值", () => {
	it("asset:<包内资产> 放行", () => {
		expect(ok('<img src="asset:sticker.webp">').html).toBe('<img src="asset:sticker.webp">');
	});

	it("image 类型的字段占位符放行", () => {
		expect(ok('<img src="{up.face}">').html).toBe('<img src="{up.face}">');
	});

	it("外部 URL 丢掉整个 img", () => {
		const { html, warnings } = ok('<div>x</div><img src="https://evil.example/x.png">');
		expect(html).toBe("<div>x</div>");
		expect(warnings.join()).toContain("evil.example");
	});

	it("javascript: 伪协议丢掉整个 img", () => {
		const { html, warnings } = ok('<div>x</div><img src="javascript:alert(1)">');
		expect(html).toBe("<div>x</div>");
		expect(warnings.join()).toContain("javascript");
	});

	/**
	 * 类型闸:`live.title` 在字段表里是 text。放行的话出图时浏览器会拿「直播标题」
	 * 去发一个请求 —— 图画不出来,标题倒是送出去了。
	 */
	it("text 类型的字段当不了图 —— 丢掉整个 img 并说清是类型不对", () => {
		const { html, warnings } = ok('<div>x</div><img src="{live.title}">');
		expect(html).toBe("<div>x</div>");
		expect(warnings.join()).toContain("text");
	});

	it("asset: 指向包里没有的资产 → 丢掉整个 img", () => {
		const { html, warnings } = ok('<div>x</div><img src="asset:nope.png">');
		expect(html).toBe("<div>x</div>");
		expect(warnings.join()).toContain("nope.png");
	});

	it("占位符只能是整个值,拼在一起不算", () => {
		const { html } = ok('<div>x</div><img src="https://i.example/{up.face}">');
		expect(html).toBe("<div>x</div>");
	});

	it("没有 src 的 img 丢掉 —— 画不出东西的空壳", () => {
		const { html, warnings } = ok('<div>x</div><img alt="没有图">');
		expect(html).toBe("<div>x</div>");
		expect(warnings.join()).toContain("src");
	});
});

describe("占位符对表", () => {
	it("认识的字段原样保留(渲染器才做替换)", () => {
		const { html, warnings } = ok("<p>{up.name} 正在播:{live.title}</p>");
		expect(html).toBe("<p>{up.name} 正在播:{live.title}</p>");
		expect(warnings).toEqual([]);
	});

	/**
	 * 缺字段是 **error(整块拒收)**,不是空串也不是原样保留:`{sc.price}` 是 SC 卡的
	 * 字段,写进直播卡出图时只会留一个空洞,而皮肤照样存得下、构建照样绿 —— 错要在
	 * 装包这一步就报出来。
	 */
	it("别的卡种的字段 → error 并报出路径", () => {
		const errors = bad("<p>{sc.price}</p>");
		expect(errors.join()).toContain("sc.price");
	});

	it("alt 里的占位符同样对表", () => {
		expect(ok('<img src="asset:bg.png" alt="{up.name} 的头像">').html).toContain("{up.name}");
		expect(bad('<img src="asset:bg.png" alt="{sc.price}">').join()).toContain("sc.price");
	});

	it("{ 后面不是路径形状的照字面保留 —— 那是作者真想写的花括号", () => {
		const { html } = ok("<p>{ 手写 } {1} {single}</p>");
		expect(html).toBe("<p>{ 手写 } {1} {single}</p>");
	});

	it("换个卡种,同一个路径就该认识", () => {
		expect(ok("<p>{sc.price}</p>", "sc").html).toBe("<p>{sc.price}</p>");
	});
});

describe("转义与形状", () => {
	it("文本位置一律 HTML 转义 —— 序列化走 parse5,不用自己写", () => {
		const { html } = ok("<div>a &lt; b &amp; c</div>");
		expect(html).toBe("<div>a &lt; b &amp; c</div>");
	});

	it("合法样例原样出来", () => {
		const input =
			'<div class="row" style="color:#fb7299"><img src="asset:bg.png" alt="底图"><span>{up.name}</span><br><small>{live.time}</small></div>';
		expect(ok(input).html).toBe(input);
	});
});

describe("硬失败", () => {
	it("超过 maxHtmlBytes → error", () => {
		const big = "<div>x</div>".repeat(1000);
		expect(Buffer.byteLength(big, "utf8")).toBeGreaterThan(CARD_SKIN_LIMITS.maxHtmlBytes);
		expect(bad(big).join()).toContain("上限");
	});

	it("上限按 UTF-8 字节算 —— 中文不该按一个字一格算", () => {
		const big = `<p>${"皮肤文案".repeat(750)}</p>`;
		expect(big.length).toBeLessThan(CARD_SKIN_LIMITS.maxHtmlBytes);
		expect(Buffer.byteLength(big, "utf8")).toBeGreaterThan(CARD_SKIN_LIMITS.maxHtmlBytes);
		expect(bad(big).join()).toContain("上限");
	});

	it("清洗后什么都不剩 → error", () => {
		expect(bad("<script>alert(1)</script>").join()).toContain("不剩");
		expect(bad("   ").join()).toContain("不剩");
		expect(bad("").join()).toContain("不剩");
	});
});
