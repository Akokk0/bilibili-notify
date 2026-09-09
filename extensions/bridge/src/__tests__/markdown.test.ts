/**
 * 「桥不认 markdown 时,把主人写的排版剥成干净纯文本」(ADR-0012 决策 32)。
 *
 * 这一层最大的风险**不是漏剥,是多剥** —— 推送正文里 `3 * 4`、`snake_case`、贴进来的
 * 一段代码全都合法,把它们当成排版揉一遍的话,主人收到的是被悄悄改错的消息。所以底下
 * 「不该动的」那几条与「该剥的」一样重要。
 */

import { describe, expect, it } from "vite-plus/test";
import { stripMarkdown } from "../markdown.js";

describe("stripMarkdown:该剥的", () => {
	it("强调:粗体 / 斜体 / 粗斜体,星号与下划线两套写法", () => {
		expect(stripMarkdown("**开播**了")).toBe("开播了");
		expect(stripMarkdown("*轻声*说")).toBe("轻声说");
		expect(stripMarkdown("__很重要__")).toBe("很重要");
		expect(stripMarkdown("_也是斜体_")).toBe("也是斜体");
		expect(stripMarkdown("***又粗又斜***")).toBe("又粗又斜");
	});

	it("行内代码:反引号去掉,里头一个字不动", () => {
		expect(stripMarkdown("敲 `vp run build` 就好")).toBe("敲 vp run build 就好");
	});

	it("围栏代码块:围栏与语言标记去掉,正文原样留着", () => {
		expect(stripMarkdown("看这段:\n```ts\nconst a = 1 * 2;\n```\n完")).toBe(
			"看这段:\nconst a = 1 * 2;\n完",
		);
	});

	/** 🔴 链接**不能只留文字** —— 那样地址就没了,而地址往往正是要发出去的东西。 */
	it("链接:文字与地址都留着", () => {
		expect(stripMarkdown("[点这里](https://b23.tv/abc)")).toBe("点这里 https://b23.tv/abc");
		// 文字与地址一样时不必说两遍。
		expect(stripMarkdown("[https://b23.tv/abc](https://b23.tv/abc)")).toBe("https://b23.tv/abc");
		// 尖括号自动链接。
		expect(stripMarkdown("见 <https://b23.tv/abc>")).toBe("见 https://b23.tv/abc");
	});

	it("图片:说明文字与地址都留着", () => {
		expect(stripMarkdown("![封面](https://i0.hdslb.com/x.jpg)")).toBe(
			"封面 https://i0.hdslb.com/x.jpg",
		);
	});

	it("标题 / 引用:前缀去掉,内容留着", () => {
		expect(stripMarkdown("## 今日直播\n> 转自公告")).toBe("今日直播\n转自公告");
	});

	it("无序列表:星号与加号统一成短横,短横本来就是纯文本", () => {
		expect(stripMarkdown("* 一\n+ 二\n- 三")).toBe("- 一\n- 二\n- 三");
	});

	it("分隔线:换成一行不含星号的线", () => {
		expect(stripMarkdown("上\n***\n下")).toBe("上\n———\n下");
		expect(stripMarkdown("上\n---\n下")).toBe("上\n———\n下");
	});

	it("转义:`\\*` 是主人想要的那个星号,还它", () => {
		expect(stripMarkdown("三乘四写作 3 \\* 4")).toBe("三乘四写作 3 * 4");
	});
});

describe("stripMarkdown:🔴 不该动的", () => {
	it("空格夹着的星号是乘号,不是强调", () => {
		expect(stripMarkdown("3 * 4 * 5 = 60")).toBe("3 * 4 * 5 = 60");
	});

	it("词中间的下划线是名字的一部分", () => {
		expect(stripMarkdown("字段叫 snake_case_name")).toBe("字段叫 snake_case_name");
		expect(stripMarkdown("BN_CONFIG_DISABLED=1")).toBe("BN_CONFIG_DISABLED=1");
	});

	/**
	 * ⚠️ 举的例子要**离了保护就真的会被揉坏** —— 头一版拿的是 `a * b`(空格夹着的星号
	 * 本来就不成强调),于是把「代码先抠出来」这一步整个拆掉,这条测试照样绿。
	 */
	it("代码里的星号与下划线一个都不许动", () => {
		expect(stripMarkdown("行内写 `**粗**` 与 `a*b*c`")).toBe("行内写 **粗** 与 a*b*c");
		expect(stripMarkdown("```\nx = **a**\ny = *b*\n```")).toBe("x = **a**\ny = *b*");
	});

	it("孤零零的一个星号 / 下划线原样留着", () => {
		expect(stripMarkdown("打个星号 * 看看")).toBe("打个星号 * 看看");
		expect(stripMarkdown("下划线 _ 单独一个")).toBe("下划线 _ 单独一个");
	});

	it("纯文本原样返回,不多不少", () => {
		const plain = "老番茄 开播了!标题:测试直播\n地址 https://live.bilibili.com/123";
		expect(stripMarkdown(plain)).toBe(plain);
	});

	it("空串与只有空白的照原样", () => {
		expect(stripMarkdown("")).toBe("");
		expect(stripMarkdown("   ")).toBe("   ");
	});
});
