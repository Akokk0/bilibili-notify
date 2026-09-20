/**
 * 包内唯一那份 HTML 转义 —— **逐字符**钉住它转哪几个。
 *
 * 从前这个包里有三份互不相同的近亲(皮肤渲染器 / 富文本 / SC 留言),产物全都喂
 * `innerHTML` 或属性位,而「哪份漏了什么」只能靠人挨个读源码。合成一份之后,这条测试
 * 就是那个问题的答案:少转一个当场红,多转一个也当场红(多转不会出安全问题,但会悄悄
 * 改掉出图的 HTML 字节,而基准夹具的正文里恰好没有引号 / 撇号,照不出来)。
 */

import { describe, expect, it } from "vite-plus/test";
import { escapeHtml, escapeHtmlWithBreaks } from "../html-escape";

describe("escapeHtml", () => {
	it("转的正好是这五个字符,一个不多一个不少", () => {
		expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
	});

	it("`&` 先转,不会把自己转出来的实体再转一遍", () => {
		expect(escapeHtml("&lt;")).toBe("&amp;lt;");
	});

	it("别的字符一个都不动(含换行与中文)", () => {
		expect(escapeHtml("你好 / = ` \n 世界")).toBe("你好 / = ` \n 世界");
	});

	it("拿它当属性值:引号关不掉属性,尖括号开不了新标签", () => {
		const attr = `<img src="${escapeHtml('x" onerror=alert(1)><b')}">`;
		expect(attr).toBe('<img src="x&quot; onerror=alert(1)&gt;&lt;b">');
	});
});

describe("escapeHtmlWithBreaks —— SC 留言那一份", () => {
	it("换行换成 <br>,而且是**转义之后**才换", () => {
		expect(escapeHtmlWithBreaks("一\n二")).toBe("一<br>二");
		// 原文里写着 `<br>` 的照样被转掉 —— 只有真换行才变成标签。
		expect(escapeHtmlWithBreaks("<br>")).toBe("&lt;br&gt;");
	});

	it("除换行外与 escapeHtml 一字不差", () => {
		expect(escapeHtmlWithBreaks(`&<>"'`)).toBe(escapeHtml(`&<>"'`));
	});
});
