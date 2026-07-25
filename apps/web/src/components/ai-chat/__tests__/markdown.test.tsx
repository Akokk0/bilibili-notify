// @vitest-environment jsdom
/**
 * 单元测试 —— 女仆回复的 Markdown 渲染。
 *
 * 重心在**安全边界**,不在样式。回复里夹着 B 站的文本:动态正文、UP 昵称、直播间
 * 标题,全经工具结果进模型上下文,模型会照抄进回复(见 packages/ai/src/tools.ts)。
 * 也就是说这些内容**攻击者可控**。原来它们是纯文本,怎么写都无害;一旦按 Markdown
 * 渲染,就多了链接、图片、裸 HTML 三个出口:
 *
 *   - 图片会在**打开对话的那一刻自动发出请求**,泄露主人的 IP 与 referer,不需要
 *     任何点击。这是三者里唯一「零交互」的,所以一张都不渲染。
 *   - 链接放行,但只认 http/https,并强制新窗口 + rel=noopener。
 *   - 裸 HTML 交给 react-markdown 的默认行为(当字面文本)—— 关键是**别引
 *     rehype-raw**,这里有测试盯着。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ChatMarkdown } from "../markdown";

afterEach(cleanup);

/** 渲染一段 markdown,返回容器供结构断言。 */
function md(source: string): HTMLElement {
	const { container } = render(<ChatMarkdown text={source} />);
	return container;
}

describe("ChatMarkdown — 安全边界", () => {
	it("图片一张都不渲染 —— 它不需要点击就会发出请求", () => {
		const c = md("![看我](https://攻击者.example/log.png)");
		expect(c.querySelectorAll("img")).toHaveLength(0);
	});

	it("图片降级成它的替换文字,不是凭空消失", () => {
		// 整个吞掉的话,主人不知道这儿本来有东西;显示 alt 至少说明「她想放张图」。
		expect(md("![封面图](https://x.example/a.png)").textContent).toContain("封面图");
	});

	it("链接强制新窗口 + rel 带 noopener", () => {
		const a = md("[戳我](https://example.com/x)").querySelector("a");
		expect(a?.getAttribute("target")).toBe("_blank");
		expect(a?.getAttribute("rel") ?? "").toContain("noopener");
	});

	it("javascript: 一类的协议被掐掉,不落成可点的 href", () => {
		const a = md("[戳我](javascript:alert(1))").querySelector("a");
		// 要么整个不渲染成链接,要么 href 被清掉 —— 只要点不出脚本就行。
		expect(a?.getAttribute("href") ?? "").not.toContain("javascript:");
	});

	it("data: 也不放行 —— data:text/html 同样能跑脚本", () => {
		const a = md("[戳我](data:text/html;base64,PHNjcmlwdD4=)").querySelector("a");
		expect(a?.getAttribute("href") ?? "").not.toContain("data:");
	});

	it("裸 HTML 当字面文本,不进 DOM —— 即没引 rehype-raw", () => {
		const c = md('正文 <img src=x onerror="alert(1)"> 结束');
		expect(c.querySelectorAll("img")).toHaveLength(0);
		expect(c.textContent).toContain("onerror");
	});

	it("裸 script 标签同样只是字", () => {
		const c = md("<script>alert(1)</script>");
		expect(c.querySelectorAll("script")).toHaveLength(0);
		expect(c.textContent).toContain("alert(1)");
	});
});

describe("ChatMarkdown — 渲染范围", () => {
	it("行内强调出真标签", () => {
		expect(md("**粗**").querySelector("strong")).toBeTruthy();
		expect(md("*斜*").querySelector("em")).toBeTruthy();
		expect(md("~~删~~").querySelector("del")).toBeTruthy();
		expect(md("`码`").querySelector("code")).toBeTruthy();
	});

	it("有序与无序列表都出列表标签", () => {
		expect(md("- 甲\n- 乙").querySelectorAll("li")).toHaveLength(2);
		expect(md("1. 甲\n2. 乙").querySelector("ol")).toBeTruthy();
	});

	it("围栏代码块出 pre + code", () => {
		const c = md("```\nconst a = 1;\n```");
		expect(c.querySelector("pre code")).toBeTruthy();
		expect(c.textContent).toContain("const a = 1;");
	});

	it("引用块出 blockquote", () => {
		expect(md("> 引用一句").querySelector("blockquote")).toBeTruthy();
	});

	it("标题降级 —— 不出 h1~h6,720px 的对话里塞不下那个字号", () => {
		// 六级全查:只查 h1 的话,`##` 照样会漏出一个 h2。
		for (const src of ["# 甲", "## 乙", "### 丙", "#### 丁", "##### 戊", "###### 己"]) {
			const c = md(src);
			expect(c.querySelectorAll("h1,h2,h3,h4,h5,h6"), src).toHaveLength(0);
			// 文字不能丢,而且还得看得出是个标题 —— 加粗成一行。
			expect(c.textContent).toContain(src.replace(/^#+ /, ""));
			expect(c.firstElementChild?.className ?? "").toContain("font-bold");
			cleanup();
		}
	});

	it("表格套在一个能横向滚动的容器里 —— 不许把整页撑宽", () => {
		const c = md("| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |");
		const table = c.querySelector("table");
		expect(table).toBeTruthy();
		const wrapper = table?.parentElement;
		expect(wrapper?.className ?? "").toContain("overflow-x-auto");
	});
});

describe("ChatMarkdown — 换行语义", () => {
	it("单个换行当真换行 —— 女仆的短句全靠它分行", () => {
		// 严格 markdown 会把这三行折成一个段落,粘成一坨。remark-breaks 负责这件事。
		const c = md("第一句\n第二句\n第三句");
		expect(c.querySelectorAll("br").length).toBeGreaterThanOrEqual(2);
		expect(c.querySelectorAll("p")).toHaveLength(1);
	});

	it("空行照旧分段", () => {
		expect(md("上段\n\n下段").querySelectorAll("p")).toHaveLength(2);
	});

	it("代码块里的换行不被 br 污染 —— 那里本来就是 pre", () => {
		const code = md("```\n甲\n乙\n```").querySelector("pre code");
		expect(code?.querySelectorAll("br")).toHaveLength(0);
		expect(code?.textContent).toContain("甲\n乙");
	});
});

describe("ChatMarkdown — 流式半截", () => {
	/**
	 * 主人选的是「边流边解析」:每来一片重新解析当前全文。所以**每一个前缀**都会被
	 * 当成一份完整文档喂进来,里头必然有没闭合的结构。一处抛异常就是整个聊天界面白屏。
	 */
	const FULL = "她说 **加粗** 然后\n- 甲\n- 乙\n\n```js\nconst a = 1;\n```\n> 引用";

	it("每一个前缀都渲染得出来,一个都不许抛", () => {
		for (let i = 1; i <= FULL.length; i++) {
			expect(() => md(FULL.slice(0, i)), `前缀长度 ${i} 炸了`).not.toThrow();
			cleanup();
		}
	});

	it("未闭合的强调符原样显示,不吞字", () => {
		// `**加粗` 只写了一半时,主人该看到那两个星号和后面的字,而不是一片空白。
		expect(md("她说 **加粗").textContent).toContain("加粗");
	});

	it("只开了一半的代码围栏也照样出块,不把后文吃掉", () => {
		const c = md("看这个\n```js\nconst a = 1;");
		expect(c.textContent).toContain("const a = 1;");
	});
});

describe("ChatMarkdown — 空与退化输入", () => {
	it("空串不渲染出任何块,也不抛", () => {
		expect(() => md("")).not.toThrow();
	});

	it("纯文本原样出来 —— 绝大多数回复就是这样", () => {
		expect(md("主人晚上好呀~").textContent).toContain("主人晚上好呀~");
	});

	it("正文里落单的 * 和 # 不该被当成标记吃掉", () => {
		// 女仆爱用颜文字和符号,`3 * 5` 这种不能变成斜体。
		const c = md("3 * 5 = 15,C# 也是一门语言");
		expect(c.textContent).toContain("3 * 5 = 15");
		expect(c.textContent).toContain("C#");
	});
});

describe("ChatMarkdown — 无障碍与可查", () => {
	it("链接带得上可读的文字", () => {
		expect(screen.queryByText("戳我")).toBeNull();
		md("[戳我](https://example.com)");
		expect(screen.getByText("戳我")).toBeTruthy();
	});
});
