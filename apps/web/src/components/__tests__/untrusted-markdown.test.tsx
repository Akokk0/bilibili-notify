// @vitest-environment jsdom

/**
 * 渲染**第三方拓展**的 README / CHANGELOG。
 *
 * 🔴 这和 `doc-markdown.tsx` 的前提正相反:那份明写着「内容都是仓库内静态文件、非用户
 * 输入」,而这里的内容是任何人打进拓展包里的。所以两条底线各有一条测试盯着 ——
 * ① 链接只认 http/https,`javascript:` 一律不给 href;② **绝不引 `rehype-raw`**,
 * 裸 HTML 当字面文本。AstrBot 那头开了 `html: true`,为此修过两个 README XSS。
 */

import { cleanup, render } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { UNTRUSTED_MARKDOWN_COMPONENTS } from "../untrusted-markdown";

function md(text: string): HTMLElement {
	return render(<ReactMarkdown components={UNTRUSTED_MARKDOWN_COMPONENTS}>{text}</ReactMarkdown>)
		.container;
}

describe("不受信 markdown", () => {
	afterEach(cleanup);

	it("`javascript:` 链接不给 href —— 退成纯文字,不留一个假的可点物件", () => {
		const c = md("[点我](javascript:alert(1))");
		expect(c.textContent).toContain("点我");
		expect(c.querySelector("a")).toBeNull();
	});

	it("正常的 https 链接照常可点,并且新窗口打开、不漏来源地址", () => {
		const a = md("[BN](https://example.com/x)").querySelector("a");
		expect(a?.getAttribute("href")).toBe("https://example.com/x");
		expect(a?.getAttribute("target")).toBe("_blank");
		expect(a?.getAttribute("rel")).toContain("noreferrer");
	});

	it("https 图片画出来,但不把这台面板的地址捎给图床", () => {
		const img = md("![截图](https://img.example.com/a.png)").querySelector("img");
		expect(img?.getAttribute("src")).toBe("https://img.example.com/a.png");
		expect(img?.getAttribute("referrerpolicy")).toBe("no-referrer");
		expect(img?.getAttribute("loading")).toBe("lazy");
	});

	/**
	 * 相对路径脱离了仓库上下文就拼不出地址 —— 渲染出去是一张碎图,而且**照样会发一次
	 * 请求**(打到面板自己身上)。画占位不画 img。
	 */
	it("相对路径的图片不渲染成 img,留一句占位", () => {
		const c = md("![流程图](docs/flow.png)");
		expect(c.querySelector("img")).toBeNull();
		expect(c.textContent).toContain("流程图");
	});

	/** 🔴 引了 `rehype-raw` 这条就会红 —— 那个插件会把下面这段变成真节点。 */
	it("裸 HTML 当字面文本,不变成节点", () => {
		const c = md('<img src=x onerror="alert(1)"> 后面还有字');
		expect(c.querySelector("img")).toBeNull();
		expect(c.textContent).toContain("onerror");
	});
});
