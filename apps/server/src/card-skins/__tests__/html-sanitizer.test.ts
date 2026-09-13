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

	it("position 丢掉 —— 自定义块不许从网格里挣出去", () => {
		const { html, warnings } = ok('<div style="position:absolute;top:0;color:#fff">x</div>');
		expect(html).not.toContain("position");
		expect(warnings.join()).toContain("position");
	});

	it("白名单外的属性丢掉;全丢光则整个 style 不落盘", () => {
		const { html } = ok('<div style="display:none;visibility:hidden">x</div>');
		expect(html).toBe("<div>x</div>");
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
