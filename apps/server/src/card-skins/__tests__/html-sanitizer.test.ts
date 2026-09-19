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

/**
 * 内联 svg(ADR-0014 决策 11 的 🔗,2026-09-14 补上的最后一片):SVG 命名空间走**自己的
 * 一张白名单**,与 HTML 那张互不串门。每条守卫仍挑「到了浏览器就出事」的形状:
 * `foreignObject` 是把 HTML 再塞回来的门、`href` 是 svg 里唯一的取网面、`url()` 在
 * 表现属性里能指向外部文档。
 */
describe("内联 svg", () => {
	it("形状 / 渐变 / use 整套保留,事件属性照丢", () => {
		const input =
			'<svg viewBox="0 0 24 24" width="24" height="24" onload="fetch(\'https://evil.example\')">' +
			'<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fb7299"></stop><stop offset="1" stop-color="#00f0ff"></stop></linearGradient></defs>' +
			'<path d="M2 2h20v20H2z" fill="url(#g)" stroke="#fff" stroke-width="1.5"></path>' +
			'<circle cx="12" cy="12" r="4" fill="currentColor"></circle>' +
			'<use href="#g"></use><text x="0" y="10" font-size="8">{up.name}</text>' +
			"</svg>";
		const { html, warnings } = ok(input);
		expect(html).toBe(input.replace(" onload=\"fetch('https://evil.example')\"", ""));
		expect(html).not.toContain("onload");
		expect(warnings.join()).toContain("onload");
	});

	it("大小写敏感的标签 / 属性名原样保留 —— linearGradient 写成 lineargradient 画不出来", () => {
		const { html } = ok(
			'<svg viewBox="0 0 1 1"><defs><radialGradient id="r" gradientUnits="userSpaceOnUse"></radialGradient><clipPath id="c"></clipPath></defs><rect clip-path="url(#c)" width="1" height="1"></rect></svg>',
		);
		expect(html).toContain("<radialGradient ");
		expect(html).toContain('gradientUnits="userSpaceOnUse"');
		expect(html).toContain("<clipPath ");
	});

	it("foreignObject 连子树丢 —— 那是把 HTML 再塞回 svg 的门", () => {
		const { html, warnings } = ok(
			'<svg><foreignObject><div>藏在里面</div></foreignObject><rect width="1" height="1"></rect></svg>',
		);
		expect(html).toBe('<svg><rect width="1" height="1"></rect></svg>');
		expect(html).not.toContain("藏在里面");
		expect(warnings.join()).toContain("foreignObject");
	});

	it("svg 里的 script / image / animate / set / a 一律连子树丢", () => {
		for (const [evil, needle] of [
			["<script>fetch('https://evil.example')</script>", "script"],
			['<image href="https://evil.example/x.png"></image>', "image"],
			['<animate attributeName="href" to="https://evil.example"></animate>', "animate"],
			['<set attributeName="href" to="https://evil.example"></set>', "set"],
			['<a href="https://evil.example"><rect width="1" height="1"></rect></a>', "a"],
			['<feImage href="https://evil.example/x.png"></feImage>', "feImage"],
		] as const) {
			const { html, warnings } = ok(`<svg><circle r="1"></circle>${evil}</svg>`);
			expect(html, evil).toBe('<svg><circle r="1"></circle></svg>');
			expect(html, evil).not.toContain("evil.example");
			expect(warnings.join(), evil).toContain(needle);
		}
	});

	/**
	 * `<mark>` 在 HTML 那张表里,但写在 `<svg>` 里 parse5 把它建成 SVG 命名空间的 `mark`,
	 * 对不上 svg 那张表就丢。(`<b>` 这类「breakout」标签会被 parser 踢出 svg 变成兄弟,
	 * 浏览器也是这么读的 —— 那不是清洗器的事。)
	 */
	it("svg 命名空间里的 HTML 标签也不认 —— 白名单按命名空间查", () => {
		const { html } = ok('<svg><mark>x</mark><g><rect width="1" height="1"></rect></g></svg>');
		expect(html).toBe('<svg><g><rect width="1" height="1"></rect></g></svg>');
		expect(ok("<svg><b>x</b></svg>").html).toBe("<svg></svg><b>x</b>");
	});

	it("href 只准 #片段引用;外部 URL / javascript: / 相对路径整个属性丢", () => {
		expect(ok('<svg><use href="#icon"></use></svg>').html).toBe(
			'<svg><use href="#icon"></use></svg>',
		);
		for (const bad of [
			'href="https://evil.example/x.svg#icon"',
			'href="javascript:alert(1)"',
			'href="x.svg#icon"',
			'href="#"',
			'href="#a b"',
		]) {
			const { html, warnings } = ok(`<svg><use ${bad}></use></svg>`);
			expect(html, bad).toBe("<svg><use></use></svg>");
			expect(warnings.join(), bad).toContain("href");
		}
	});

	it("xlink:href 归一成 href,同一条 # 规矩", () => {
		expect(ok('<svg><use xlink:href="#icon"></use></svg>').html).toBe(
			'<svg><use href="#icon"></use></svg>',
		);
		const { html } = ok('<svg><use xlink:href="https://evil.example/x.svg#i"></use></svg>');
		expect(html).toBe("<svg><use></use></svg>");
	});

	it("表现属性里的 url() 只准 url(#id);指向外部的整个属性丢", () => {
		const { html, warnings } = ok(
			'<svg><rect fill="url(#g)" stroke="url(https://evil.example/x.svg#p)" filter="url(#f)" mask="url( #m )" width="1" height="1"></rect></svg>',
		);
		expect(html).toContain('fill="url(#g)"');
		expect(html).toContain('filter="url(#f)"');
		expect(html).toContain('mask="url(#m)"');
		expect(html).not.toContain("stroke=");
		expect(html).not.toContain("evil.example");
		expect(warnings.join()).toContain("stroke");
	});

	it("id 只在 svg 元素上放行,且只准 [A-Za-z][A-Za-z0-9_-]*;HTML 元素上照丢", () => {
		expect(ok('<svg><linearGradient id="g-1"></linearGradient></svg>').html).toContain('id="g-1"');
		const { html, warnings } = ok('<svg><linearGradient id="1g"></linearGradient></svg>');
		expect(html).toBe("<svg><linearGradient></linearGradient></svg>");
		expect(warnings.join()).toContain("id");
		expect(ok('<div id="x">y</div>').html).toBe("<div>y</div>");
	});

	it("svg 元素的 style 走同一份声明级过滤:url() 不放行,要用属性写 fill=url(#g)", () => {
		const { html, warnings } = ok(
			'<svg><rect style="fill:url(#g);opacity:.5" width="1" height="1"></rect></svg>',
		);
		expect(html).toContain('style="opacity:.5"');
		expect(html).not.toContain("url(");
		expect(warnings.join()).toContain("url");
	});

	it("其它命名空间前缀的属性(xml:space / xmlns:xlink)与不在名单的属性丢掉", () => {
		const { html, warnings } = ok(
			'<svg xmlns:xlink="http://www.w3.org/1999/xlink" xml:space="preserve" data-x="1" tabindex="0"><rect width="1" height="1"></rect></svg>',
		);
		expect(html).toBe('<svg><rect width="1" height="1"></rect></svg>');
		expect(warnings.join()).toContain("tabindex");
	});

	it("text 里的占位符同样对表 —— 缺字段整块拒收", () => {
		expect(ok("<svg><text>{live.title}</text></svg>").html).toContain("{live.title}");
		expect(bad("<svg><text><tspan>{sc.price}</tspan></text></svg>").join()).toContain("sc.price");
	});

	it("滤镜整套放行(除 feImage)—— 霓虹辉光就靠它", () => {
		const input =
			'<svg><defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur in="SourceGraphic" stdDeviation="3" result="b"></feGaussianBlur><feMerge><feMergeNode in="b"></feMergeNode><feMergeNode in="SourceGraphic"></feMergeNode></feMerge></filter></defs><text filter="url(#glow)">霓虹</text></svg>';
		const { html, warnings } = ok(input);
		expect(html).toBe(input);
		expect(warnings).toEqual([]);
	});
});

/**
 * 命名空间声明(`xmlns` / `xmlns:xlink`)**静静丢掉,不出 warning**。
 *
 * 它们是每一份从设计工具复制出来的 svg 都带的两条,而在 HTML 里它们本来就不起作用 ——
 * 解析器按标签名就把 `<svg>` 放进 svg 命名空间了。为它们各报一条警告,等于让每个作者
 * 第一次贴 svg 就先吃两条看不懂的红字,然后学会不看警告栏 —— 而警告栏里真该看的是
 * 「你那个 `<image>` 被丢了」。
 */
describe("svg 的命名空间声明", () => {
	const svg = (inner: string) => sanitizeCardBlockHtml(inner, { kind: "dynamic", assets: ASSETS });

	it("xmlns 丢掉但不吭声", () => {
		const r = svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect/></svg>');
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.html).not.toContain("xmlns");
		expect(r.warnings).toEqual([]);
	});

	it("xmlns:xlink 同理", () => {
		const r = svg('<svg xmlns:xlink="http://www.w3.org/1999/xlink"><rect/></svg>');
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.warnings).toEqual([]);
	});

	it("别的前缀照旧报,而且名字里不许多出一个冒号", () => {
		const r = svg('<svg><rect xml:space="preserve"/></svg>');
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.warnings.join()).toContain("xml:space");
		expect(r.warnings.join()).not.toMatch(/属性 :/);
	});
});

/**
 * **占位符只有 `src` / `alt` 两档认**(ADR-0014 决策 12 原文:「其他属性不认占位符」)。
 *
 * 这一组钉的是**形状**,不是某条警告文案:产物里除 `src` / `alt` 外的任何属性值都不许
 * 还留着 `{a.b}`。理由在 `rejectsPlaceholder` 的注释里 —— 替换发生在清洗**之后**、
 * 是字符串级的、只做 HTML 转义,所以留在 `style` 里的占位符等于让 B 站来的原文直接当
 * CSS 声明用(实测能 `position:absolute` 铺一层盖住整张卡);svg 的表现属性同形。
 *
 * 判据:把 `filterAttrs` / `filterSvgAttrs` 里那两句 `rejectsPlaceholder` 拆掉,这一组必须红。
 */
describe("属性里的占位符:只有 src / alt 认", () => {
	/** 产物里所有属性值 —— 用来问「还有没有 `{a.b}` 漏在属性里」。 */
	function attrValues(html: string): string[] {
		return [...html.matchAll(/\s[\w:-]+="([^"]*)"/g)].map((m) => m[1] as string);
	}

	it("style 里的占位符整个属性丢掉 —— 不然直播标题就成了 CSS 声明", () => {
		const { html, warnings } = ok('<div style="color:{live.title}">好</div>');
		expect(html).not.toContain("{live.title}");
		expect(html).toBe("<div>好</div>");
		expect(warnings.join()).toContain("占位符");
	});

	it("混在正经声明里也一样 —— 是整个属性丢,不是只削那一条", () => {
		const { html } = ok('<div style="font-weight:700;color:{live.title}">好</div>');
		expect(attrValues(html).join()).not.toContain("{");
	});

	it('svg 的表现属性同形 —— <circle r="{live.title}"> 也得丢', () => {
		const { html } = ok(
			'<svg viewBox="0 0 2 2"><circle r="{live.title}" cx="1" cy="1"></circle></svg>',
		);
		expect(attrValues(html).join()).not.toContain("{live.title}");
		expect(html).toContain('cx="1"');
	});

	it("src / alt 那两档照旧认 —— 别把正经用法一起堵了", () => {
		const { html } = ok('<img src="{live.cover}" alt="{live.title} 的封面">');
		expect(html).toContain('src="{live.cover}"');
		expect(html).toContain("{live.title}");
	});

	it("`{ margin }` / `{1}` 这种不是占位符形状的花括号照字面留着", () => {
		const { html } = ok('<div style="color:red" data-x="{1}">好</div>');
		expect(html).toContain('style="color:red"');
	});
});
