/// <reference types="node" />
/**
 * 颜色 token conformance —— 扫 `apps/web/src/{pages,components}` 全 .tsx,对每个
 * 颜色类 utility(`bg-bn-*` / `text-bn-*` / `border-bn-*` …)断言它引用的 token 在
 * `styles.css` 里真的定义了 `--color-bn-*`。
 *
 * 为什么需要静态护栏:**UnoCSS 对未定义的 token 是静默丢弃的** —— 不报错、不警告,
 * 直接编译成空。于是 `bg-bn-accent`(一个从不存在的 token)会让按钮**没有背景色**,
 * 配上 `text-white` 就是白字白底、彻底隐形;而 typecheck 管不着(那是字符串)、Biome
 * 管不着、组件测试只查 role/文本也管不着 —— **整套门禁全绿,按钮却看不见**。只能靠
 * 肉眼发现,这正是 `bn-accent` 在 Targets / BlockListEditor / MessageLayoutEditor
 * 里死了 6 处(拖拽高亮边框根本不显示)却一直没人察觉的原因。
 *
 * 只管**颜色类**前缀:`rounded-bn-card`(--radius-bn-*)、`shadow-bn-elev`
 * (--shadow-bn-*)、`bn-anim-fade-in`(纯 CSS class)都不是颜色 token,不在此列。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(TEST_DIR, "..");
const STYLES = join(SRC_DIR, "styles.css");
/** tokens 的正主 —— @theme 块已随纯展示件搬进 @bilibili-notify/ui。 */
const UI_SRC_DIR = join(SRC_DIR, "../../../packages/ui/src");
const UI_THEME = join(UI_SRC_DIR, "theme.css");

/** 会被 UnoCSS 解析成 `var(--color-…)` 的 utility 前缀。 */
const COLOR_PREFIXES = [
	"bg",
	"text",
	"border",
	"ring",
	"from",
	"via",
	"to",
	"fill",
	"stroke",
	"outline",
	"decoration",
	"caret",
	"divide",
	"placeholder",
] as const;

// `hover:border-bn-accent/60` → 捕获 `bn-accent`(前缀修饰符无所谓;`/60` 透明度后缀
// 因为 `/` 不在字符集里会自然截断)。
const USAGE_RE = new RegExp(`\\b(?:${COLOR_PREFIXES.join("|")})-(bn-[a-z0-9-]+)`, "g");

function listTsxRecursive(dir: string): string[] {
	const acc: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) acc.push(...listTsxRecursive(full));
		else if (full.endsWith(".tsx")) acc.push(full);
	}
	return acc;
}

/** 已定义的颜色 token(`--color-bn-pink` → `bn-pink`),ui 包 theme.css + web styles.css 合并。 */
function definedColorTokens(): Set<string> {
	const css = readFileSync(UI_THEME, "utf8") + readFileSync(STYLES, "utf8");
	const found = css.match(/--color-(bn-[a-z0-9-]+)\s*:/g) ?? [];
	return new Set(found.map((m) => m.replace(/--color-|\s*:/g, "")));
}

describe("颜色 token conformance", () => {
	it("所有 bn-* 颜色类都引用 styles.css 里真实定义的 token", () => {
		const defined = definedColorTokens();
		// 定义集自身得先是像样的 —— 否则正则一改就悄悄退化成「空集,人人合格」。
		expect(defined.size).toBeGreaterThan(10);
		expect(defined.has("bn-pink")).toBe(true);

		const offenders: Array<{ token: string; file: string }> = [];
		for (const file of [
			...listTsxRecursive(join(SRC_DIR, "pages")),
			...listTsxRecursive(join(SRC_DIR, "components")),
			// 库里的纯展示件同样受此约束 —— 它们的 class 也靠这两份 css 的 token 兑现。
			...listTsxRecursive(UI_SRC_DIR),
		]) {
			const src = readFileSync(file, "utf8");
			for (const m of src.matchAll(USAGE_RE)) {
				const token = m[1];
				if (token && !defined.has(token)) {
					offenders.push({ token, file: file.slice(SRC_DIR.length + 1) });
				}
			}
		}

		const detail = [...new Set(offenders.map((o) => `  ${o.token}  (${o.file})`))].join("\n");
		expect(offenders, `styles.css 里没有定义以下颜色 token:\n${detail}`).toEqual([]);
	});
});
