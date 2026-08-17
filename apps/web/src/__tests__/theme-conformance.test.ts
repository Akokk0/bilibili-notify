import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { THEME_STORAGE_KEY } from "../services/theme";

const SRC_DIR = dirname(fileURLToPath(new URL("../placeholder", import.meta.url)));

const BANNED = [
	{ re: /\bbg-white(?:\/\d+)?\b/g, hint: "改用 bg-bn-surface / bg-bn-field / inverse token" },
	{ re: /\bbg-gray-(?:50|100|200|300)\b/g, hint: "改用 bg-bn-surface-muted / bg-bn-hover-muted" },
	{
		re: /\bborder-gray-(?:100|200|300)\b/g,
		hint: "改用 border-bn-border / border-bn-border-subtle",
	},
	// 深灰文字(gray-600 及更深)在亮底语义=正文/次要文字,暗色下必然 dark-on-dark 不可读 → 必须走
	// text-bn-text-*。浅灰(gray-200~500)豁免:它们只用于固定深色容器(如 Logs 终端 bg-[#0f1115]),
	// 那里两套主题都是深底,浅灰文字始终可读。
	{
		re: /\btext-gray-(?:600|700|800|900)\b/g,
		hint: "改用 text-bn-text-secondary / text-bn-text-tertiary",
	},
	{ re: /\bborder-black\/5\b/g, hint: "改用 border-bn-border-subtle" },
	{ re: /\bbg-black\/5\b/g, hint: "改用 bg-bn-code-bg / bg-bn-hover-muted" },
	{ re: /\bhover:bg-black\/5\b/g, hint: "改用 hover:bg-bn-hover-muted" },
	{ re: /\bhover:bg-gray-50\b/g, hint: "改用 hover:bg-bn-surface-muted" },
	// arbitrary 浅色 hex(#e/#f 开头,如 bg-[#fafafa]/hover:bg-[#fdf2f5])在暗色下不翻转 → 必须走
	// 语义 token(bg-bn-*/border-bn-*)。深色 arbitrary(#0/#1 开头,如 bg-[#0f1115] 终端)合法,不拦。
	{
		re: /(?:hover:)?(?:bg|border|text)-\[#[efEF][0-9a-fA-F]{2,5}\]/g,
		hint: "arbitrary 浅色 hex → 改用语义 token 或内联 var(--color-bn-*)",
	},
	// amber 浅实色底 / 深档文字在暗色下分别过亮 / 不可读 → 走 warning token。半透明(amber-500/15)
	// 与 amber-500 强调色合法,不拦。
	{ re: /\bbg-amber-(?:50|100)\b/g, hint: "改用 bg-bn-warning-soft" },
	{ re: /\btext-amber-(?:700|800|900)\b/g, hint: "改用 text-bn-warning-text" },
	// ring-gray 是 border-gray 的描边孪生:暗色下浅灰 ring 在深底上变白边。先前只 ban
	// border-gray 漏了 ring 变体(订阅 UP 卡片的白描边即此)。
	{ re: /\bring-gray-(?:100|200|300)\b/g, hint: "改用 ring-bn-border / ring-bn-pink" },
	{ re: /\bring-white(?:\/\d+)?\b/g, hint: "改用 ring-bn-border / ring-bn-surface" },
];

// 注:本扫描只看 className 文本,不覆盖内联 style 里的硬编码颜色(如 style={{ background: "#f5f5f5" }})
// —— 那类正则易误伤合法品牌色/动态 tone 拼接(`${tone}1f`)。内联 style 的浅色一律手动用
// var(--color-bn-*),新增时人工把关。

// 合法豁免:位于「两套主题都恒定深色」的容器内(如灵动岛 bg-black/85)的元素,需要固定亮色
// 前景,与暗色翻转无关。key = `<相对 src 路径>:<utility>`。这里登记即文档:写明为何例外。
const ALLOWED = new Set<string>([
	// 灵动岛(恒深 pill)内的「保存」CTA —— 固定白底黑字,不能跟随主题翻转成深底黑字。
	"components/draft-island.tsx:bg-white",
]);

async function listTsxFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const out: string[] = [];
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "__tests__") continue;
			out.push(...(await listTsxFiles(full)));
		} else if (entry.isFile() && entry.name.endsWith(".tsx")) {
			out.push(full);
		}
	}
	return out;
}

describe("theme conformance", () => {
	it("does not reintroduce light-only neutral Tailwind utilities", async () => {
		const findings: string[] = [];
		for (const file of await listTsxFiles(SRC_DIR)) {
			const rel = relative(SRC_DIR, file);
			const source = await readFile(file, "utf8");
			for (const { re, hint } of BANNED) {
				re.lastIndex = 0;
				for (const match of source.matchAll(re)) {
					// 归一掉透明度后缀(bg-white/90 → bg-white),让豁免覆盖同一 utility 的所有透明度变体。
					const base = match[0].replace(/\/\d+$/, "");
					if (ALLOWED.has(`${rel}:${base}`)) continue;
					const line = source.slice(0, match.index).split("\n").length;
					findings.push(`${rel}:${line} ${match[0]} → ${hint}`);
				}
			}
		}

		expect(findings).toEqual([]);
	});

	/**
	 * 聊天界面的强调色必须走 `--bn-chat-*`,不能写死。
	 *
	 * 换观感只换那几个变量的值(默认主题在 styles.css 的 :root、皮肤经
	 * composeSkinVars 注入)。设计稿通篇是紫色,照抄进 JSX 的结果就是
	 * 「换什么皮肤,滑块 / 光标 / 气泡 / 发送键还是紫的」。
	 *
	 * 这条守在源码上:jsdom 不算样式,颜色对不对量不出来;而「又从设计稿抄了一段
	 * 紫色进来」恰恰是最容易反复发生的事。
	 */
	it("ai-chat 里没有写死的强调色 —— 全走 --bn-chat-* 变量", async () => {
		const ACCENT = /bn-purple|#6c5ce7|#a29bfe|#[fF][bB]7299|#e84393/g;
		const findings: string[] = [];
		for (const file of await listTsxFiles(join(SRC_DIR, "components/ai-chat"))) {
			const rel = relative(SRC_DIR, file);
			const source = await readFile(file, "utf8");
			for (const match of source.matchAll(ACCENT)) {
				const line = source.slice(0, match.index).split("\n").length;
				findings.push(`${rel}:${line} ${match[0]}`);
			}
		}
		expect(findings).toEqual([]);
	});

	it("默认聊天主题在 :root 上备齐强调色的三种形态;四色预设已砍干净", async () => {
		// 实色(色点 / 光标)、rgb 分量(半透明底,rgba 要拆开的分量)、渐变副色。
		// 缺任何一个就有一处悄悄回落到 var() 的兜底值 —— 不报错,只是颜色永远不对。
		const css = await readFile(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
		for (const varName of ["--bn-chat-dot:", "--bn-chat-accent-rgb:", "--bn-chat-accent-2:"]) {
			expect(`${varName} ${css.includes(varName)}`).toBe(`${varName} true`);
		}
		// 预设选择器一个都不许剩:剩一块就是一段永远不命中的死 CSS。
		expect(css.includes("data-chat-theme")).toBe(false);
	});

	it("ships a synchronous anti-FOUC theme script in index.html", async () => {
		const html = await readFile(
			fileURLToPath(new URL("../../index.html", import.meta.url)),
			"utf8",
		);
		// storage key 必须与运行时(services/theme.ts)一致,否则首屏脚本读错键 → 闪烁回归。
		expect(html).toContain(THEME_STORAGE_KEY);
		// <head> 内必须有同步 <script>(非 module)在 React 挂载前设置 data-theme。
		expect(html).toMatch(/<head>[\s\S]*<script>[\s\S]*dataset\.theme[\s\S]*<\/head>/);
	});
});
