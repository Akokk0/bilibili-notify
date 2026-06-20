/**
 * 回归守护 —— LiveCard 直播间简介(`room_info.description`)渲染。
 *
 * 复发点:任何人把 `htmlToPlain` 改成只做 strip 或只做 decode,「entity-encoded
 * HTML」(`&lt;p&gt;...`)分支立刻挂回去,卡片上又会出现字面 `<p>xxxx</p>` /
 * `&lt;p&gt;xxxx&lt;/p&gt;`(取决于 input 形态)。
 */

import { describe, expect, it } from "vite-plus/test";
import { htmlToPlain } from "../html-to-plain";

describe("htmlToPlain", () => {
	it("null / undefined / 空串 → 空串", () => {
		expect(htmlToPlain(null)).toBe("");
		expect(htmlToPlain(undefined)).toBe("");
		expect(htmlToPlain("")).toBe("");
	});

	it("纯文本不动", () => {
		expect(htmlToPlain("这个主播很懒")).toBe("这个主播很懒");
	});

	it("raw HTML 标签(B 站富文本编辑器典型输出)→ 剥成纯文本", () => {
		expect(htmlToPlain("<p>欢迎来到直播间</p>")).toBe("欢迎来到直播间");
		expect(htmlToPlain("<p>第一段</p><p>第二段</p>")).toBe("第一段 第二段");
		expect(htmlToPlain("第一行<br>第二行")).toBe("第一行 第二行");
	});

	it("entity-encoded HTML(部分接口返回的形式)→ decode 后再剥", () => {
		// 关键回归守卫:用户报告的就是这种 input,期望最终看不到 `&lt;p&gt;` 字符串。
		expect(htmlToPlain("&lt;p&gt;欢迎来到直播间&lt;/p&gt;")).toBe("欢迎来到直播间");
		expect(htmlToPlain("&lt;p&gt;第一段&lt;/p&gt;&lt;p&gt;第二段&lt;/p&gt;")).toBe("第一段 第二段");
	});

	it("混合 HTML entities → 解码常见集合", () => {
		expect(htmlToPlain("A&amp;B")).toBe("A&B");
		expect(htmlToPlain("&quot;话术&quot;")).toBe('"话术"');
		expect(htmlToPlain("It&#39;s ok")).toBe("It's ok");
		expect(htmlToPlain("space&nbsp;here")).toBe("space here");
	});

	it("数字 / hex 字符引用", () => {
		expect(htmlToPlain("A&#65;B")).toBe("AAB"); // &#65; = 'A'
		expect(htmlToPlain("&#x4E2D;文")).toBe("中文"); // &#x4E2D; = '中'
	});

	it("`&amp;` 嵌套不会被二次解码", () => {
		// 复发点:`&amp;lt;` 不应被先 `&amp;`→`&` 再 `&lt;`→`<`,
		// 应保留为字面 `&lt;`。
		expect(htmlToPlain("&amp;lt;p&amp;gt;")).toBe("&lt;p&gt;");
	});

	it("文本里包含 `<` 字符(非 tag 形态)→ 保留", () => {
		// regex strip 只匹配 `</?[a-zA-Z]...>`;`<` 后非字母则不当 tag,保留。
		expect(htmlToPlain("1 < 2 且 3 > 2")).toBe("1 < 2 且 3 > 2");
	});

	it("折叠多余空白", () => {
		expect(htmlToPlain("<p>  多   空格  </p>")).toBe("多 空格");
		expect(htmlToPlain("\n\n第一段\n\n第二段\n\n")).toBe("第一段 第二段");
	});

	it("带属性的标签(如 <a href>)也剥干净", () => {
		expect(htmlToPlain('<a href="https://example.com">点这里</a>')).toBe("点这里");
		expect(htmlToPlain('<img src="x.jpg" alt="图">')).toBe("");
	});
});
