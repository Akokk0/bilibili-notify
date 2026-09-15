/**
 * 卡片字体 —— `font-family` 怎么写进 CSS,以及自带字体文件怎么进来。
 *
 * 起因是一条**一直没人发现的既有 bug**:baseCSS 曾经写成
 * `font-family: "${font}", …`,把整个配置值套进一对引号里。CSS 里带引号 = **一个**
 * 家族名,于是出厂默认值 `PingFang SC, sans-serif` 变成了一个叫「PingFang SC,
 * sans-serif」的家族 —— 世上没有这个家族,一路落到后面硬编码的兜底链。表现是「设了
 * 苹方却没生效」,而且**永远不报错**:CSS 解析器对不存在的家族名就是静静跳过,
 * 容器里更是必然落到 Noto,谁也看不出来。
 *
 * 字体选择器上线后这条更要钉死:选择器交出来的是**单个**家族名(可能带空格,必须加
 * 引号),而 generic 家族(sans-serif / monospace…)**恰恰不能**加引号 —— 加了就变成
 * 找一个叫「sans-serif」的字体文件。两种都得对。
 */

import { JSDOM } from "jsdom";
import { describe, expect, it } from "vite-plus/test";
import { h } from "vue";
import { renderCard } from "../render";

/** 最小组件 —— 这一组测的是外壳 CSS,卡片长什么样无关。 */
const Tiny = () => h("div", { class: "text-[12px]" }, "字体");

/** 取 `<style>` 里的 CSS。 */
function cssOf(html: string): string {
	return html.slice(html.indexOf("<style>") + 7, html.indexOf("</style>"));
}

/** 外壳里那条「字体从这儿起」的规则的声明值(2026-09-15 起挂在 `html:root`,从前是 `*`)。 */
function familyDecl(css: string): string {
	const m = css.match(/html:root\s*\{[^}]*font-family:\s*([^;}]+)/);
	return (m?.[1] ?? "").trim();
}

function render(options: Parameters<typeof renderCard>[2]): Promise<string> {
	return renderCard(Tiny, {}, options);
}

describe("font-family 写法", () => {
	it("带空格的家族名要加引号 —— 否则 CSS 解析不出这是一个名字", async () => {
		const css = cssOf(await render({ font: "Comic Sans MS" }));
		expect(familyDecl(css)).toContain('"Comic Sans MS"');
	});

	it("老配置里那种**逗号列表**要逐项处理,不能整串塞进一对引号", async () => {
		// 出厂默认值就是这个形状。整串加引号的话它是个不存在的家族名,苹方从来没生效过。
		const css = cssOf(await render({ font: "PingFang SC, sans-serif" }));
		const decl = familyDecl(css);
		expect(decl).toContain('"PingFang SC"');
		expect(decl).not.toContain('"PingFang SC, sans-serif"');
	});

	it("generic 家族名不许加引号 —— 加了就成了找一个叫 sans-serif 的字体文件", async () => {
		const decl = familyDecl(cssOf(await render({ font: "monospace" })));
		expect(decl).toMatch(/(^|,\s*)monospace\b/);
		expect(decl).not.toContain('"monospace"');
	});

	it("没配字体 → 只剩兜底链,不留一对空引号", async () => {
		const decl = familyDecl(cssOf(await render({ font: "" })));
		expect(decl).not.toContain('""');
		expect(decl).toContain("sans-serif");
	});

	it("兜底链恒在最后 —— 缺字体也不该渲染成方块", async () => {
		const decl = familyDecl(cssOf(await render({ font: "Comic Sans MS" })));
		expect(decl).toContain('"Noto Sans CJK"');
		expect(decl.trim().endsWith("sans-serif")).toBe(true);
	});
});

describe("自带字体文件(@font-face)", () => {
	const FACE = '@font-face{font-family:"bn-user-font";src:url("data:font/woff2;base64,AAA")}';

	it("给了 fontFace 就注入进 <style>,主人上传的字体才可能生效", async () => {
		const css = cssOf(await render({ font: "bn-user-font", fontFace: FACE }));
		expect(css).toContain(FACE);
	});

	it("没给 fontFace 就一个 @font-face 都不写", async () => {
		const css = cssOf(await render({ font: "Comic Sans MS" }));
		expect(css).not.toContain("@font-face");
	});

	it("@font-face 排在通配规则之前 —— 字体先声明,读起来也才讲得通", async () => {
		// 断言的是「在 `*{…}` 那条之前」,不是「在第一个 font-family 之前」—— 后者恒真
		// (@font-face 自己块里就有个 font-family),等于没测。
		const css = cssOf(await render({ font: "bn-user-font", fontFace: FACE }));
		expect(css.indexOf("@font-face")).toBeLessThan(css.indexOf("* {"));
	});
});

/**
 * **外壳的字体只准是「起点」,不能是「压在每个元素头上」。**
 *
 * 2026-09-15 抓到的回归:外壳那条 `*{…font-family}` 给**每个元素**直接设了字体,于是
 * 谁也不从祖先继承 —— 皮肤在外框上写 `font-family` 一路到不了文字。本来只影响皮肤作者
 * 自己写的那句,但 09-14 字体退役之后**默认皮肤的字体旋钮**也走这条路
 * (`[data-bn="frame"]{font-family:var(--bn-knob-font,…)}`),于是面板上再没有任何入口
 * 能改出图的字体了。
 *
 * 钉的是**算出来的值**而不是 CSS 文本:写成「外壳里必须有 html{font-family}」那种断言
 * 是在复述现状,换个等价写法就假红,而真正坏掉的那天(有人把它改回 `*`)它照样绿。
 */
describe("字体是继承的起点,不是压在每个元素上", () => {
	/** 一张最小的「外框套文字」,与真卡同形。 */
	const Framed = () =>
		h("div", { "data-bn": "frame" }, [h("span", { id: "t" }, "字"), h("code", { id: "c" }, "x")]);

	const computed = async (extraCss: string | undefined, id: string): Promise<string> => {
		const html = await renderCard(Framed, {}, { font: "Chain", ...(extraCss ? { extraCss } : {}) });
		const dom = new JSDOM(html);
		const el = dom.window.document.getElementById(id);
		if (!el) throw new Error(`没有 #${id}`);
		return dom.window.getComputedStyle(el).fontFamily;
	};

	it("外框上写的字体传得到里面的文字 —— 皮肤与字体旋钮全靠这一跳", async () => {
		const got = await computed('[data-bn="frame"]{font-family:Probe}', "t");
		expect(got).toContain("Probe");
	});

	it("没人覆盖时仍是那条兜底链 —— 起点还在,只是不再压着每个元素", async () => {
		expect(await computed(undefined, "t")).toContain("Chain");
	});

	it("`<code>` 照旧走 UnoCSS preflight 的等宽 —— 这一档不受影响", async () => {
		// 像素护栏。`code, kbd, samp, pre` 是 preflight 里的一条规则,特异度压得过 `*`
		// 也压得过 `html` —— 两种写法下它都赢,所以这次改动碰不到它。写在这儿是因为
		// 「顺手给这些元素补一句 inherit」是个很自然的念头,而那会真的改掉出的图。
		expect(await computed(undefined, "c")).toContain("monospace");
	});
});
