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

import { describe, expect, it } from "vite-plus/test";
import { h } from "vue";
import { renderCard } from "../render";

/** 最小组件 —— 这一组测的是外壳 CSS,卡片长什么样无关。 */
const Tiny = () => h("div", { class: "text-[12px]" }, "字体");

/** 取 `<style>` 里的 CSS。 */
function cssOf(html: string): string {
	return html.slice(html.indexOf("<style>") + 7, html.indexOf("</style>"));
}

/** `*{…}` 那条通配规则里的 font-family 声明值。 */
function familyDecl(css: string): string {
	const m = css.match(/\*\s*\{[^}]*font-family:\s*([^;}]+)/);
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
