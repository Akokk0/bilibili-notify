import { describe, expect, it } from "vite-plus/test";
import { safeHref } from "../safe-href";

/**
 * 渲染不受信 Markdown 时「这个 href 能不能落成可点的链接」那把尺子。
 *
 * 🔴 **它必须有自己的单元测试** —— 它在产品里是**第二道闸**:`react-markdown` 自带的
 * `defaultUrlTransform` 会先把 `javascript:` 之类抹成空串,所以光靠组件层那条
 * 「`javascript:` 链接不给 href」,把这里整个换成直通也照样全绿(实测 1930 条一条不红)。
 * 防御纵深的那一层要是没人量,它就不是一层。
 */
describe("safeHref", () => {
	it("http 与 https 原样放行", () => {
		expect(safeHref("https://example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
		expect(safeHref("http://example.com/")).toBe("http://example.com/");
	});

	/** 白名单之外一律不给 href —— 穷举黑名单漏一个就是一个洞。 */
	it.each([
		["javascript:alert(1)", "最朴素的那一个"],
		["JaVaScRiPt:alert(1)", "大小写混写"],
		["  javascript:alert(1)", "前导空白"],
		["java\nscript:alert(1)", "协议名里插换行"],
		["java\tscript:alert(1)", "协议名里插制表符"],
		["data:text/html;base64,PHNjcmlwdD4=", "data: 能整页塞 HTML"],
		["vbscript:msgbox(1)", "老 IE 的那一个"],
		["file:///etc/passwd", "本地文件"],
		["blob:https://example.com/uuid", "blob:"],
	])("%s 不给 href（%s）", (href) => {
		expect(safeHref(href)).toBeUndefined();
	});

	/** `mailto:` 也不放 —— 这两个场景下它几乎不出现,而每多一项都是一条要单独想的路。 */
	it("mailto: 也不放行", () => {
		expect(safeHref("mailto:a@example.com")).toBeUndefined();
	});

	it("空的、没有的,都不给 href", () => {
		expect(safeHref(undefined)).toBeUndefined();
		expect(safeHref("")).toBeUndefined();
	});

	/**
	 * 相对地址**原样放行**是刻意的:它跳不出本站。
	 *
	 * ⚠️ 但「跳不出本站」只对 AI 聊天成立 —— 拓展文档那头的相对路径脱离了源仓就没有意义,
	 * 所以 `untrusted-markdown.tsx` 在这把尺子**之外**另加了一道「必须是绝对地址」。
	 * 那一道有它自己的测试,别把这条当成拓展文档也放行相对路径的依据。
	 */
	it("相对地址原样放行（AI 聊天那条路的前提）", () => {
		expect(safeHref("./a.md")).toBe("./a.md");
		expect(safeHref("/guide")).toBe("/guide");
	});
});
