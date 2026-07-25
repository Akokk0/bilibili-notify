/**
 * 单元测试 —— Markdown 那一坨代码不许进初始包。
 *
 * `react-markdown` 连带 micromark / mdast 那一整套约 **153KB**(实测:主 chunk
 * 1029KB → 876KB)。`AiChatDock` 是在 App 根上**静态**挂着的,所以只要这条链上有
 * 一处静态 import,那 153KB 就进初始包 —— 每次打开 dashboard 都加载,哪怕主人从不
 * 点开聊天。
 *
 * 顺带还会毁掉别人的努力:About 页那边写的是
 * `lazy(() => import("react-markdown"))`,特意懒加载的;库一旦被别处拽进主包,
 * 那个 lazy 就成了摆设 —— 没东西可懒。
 *
 * 这条守卫扫**源码**而不是查产物:产物层面的断言要求先跑一遍 build,而 `vp test`
 * 不该有那个前提。刻意不放在 markdown.test.tsx 里 —— 那个文件跑在 jsdom 下,
 * `import.meta.url` 不是 file: scheme,`fileURLToPath` 直接抛。
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const AI_CHAT_DIR = dirname(fileURLToPath(new URL("../placeholder", import.meta.url)));

/** ai-chat 目录下除 markdown.tsx 之外的源文件(不含子目录,即不含 __tests__)。 */
async function siblings(): Promise<string[]> {
	const entries = await readdir(AI_CHAT_DIR, { withFileTypes: true });
	return entries
		.filter((e) => e.isFile() && /\.tsx?$/.test(e.name) && e.name !== "markdown.tsx")
		.map((e) => e.name);
}

describe("markdown 模块只许动态引入", () => {
	it("没有任何地方静态 import ./markdown", async () => {
		const files = await siblings();
		expect(files.length).toBeGreaterThan(3); // 目录没扫到时别假绿

		const offenders: string[] = [];
		for (const name of files) {
			const text = await readFile(join(AI_CHAT_DIR, name), "utf8");
			// 静态形式带 `from`;动态的 `import("./markdown")` 没有,不会被命中。
			if (/^\s*import\s[^;]*\sfrom\s+["']\.\/markdown["']/m.test(text)) offenders.push(name);
		}
		expect(offenders, '改用 lazy(() => import("./markdown"))').toEqual([]);
	});

	it("除了 markdown.tsx,没人直接引 react-markdown 或 remark-*", async () => {
		const files = await siblings();
		const offenders: string[] = [];
		for (const name of files) {
			const text = await readFile(join(AI_CHAT_DIR, name), "utf8");
			if (/from\s+["'](?:react-markdown|remark-[\w-]+)["']/.test(text)) offenders.push(name);
		}
		expect(offenders).toEqual([]);
	});

	it("markdown.tsx 自己确实是那个装着重依赖的模块 —— 守卫别守了个空壳", async () => {
		// 上面两条只说「别人没引」。万一哪天有人把 react-markdown 挪出 markdown.tsx,
		// 两条都会继续绿,而依赖已经跑到别处去了。
		const text = await readFile(join(AI_CHAT_DIR, "markdown.tsx"), "utf8");
		expect(text).toMatch(/from\s+["']react-markdown["']/);
	});
});
