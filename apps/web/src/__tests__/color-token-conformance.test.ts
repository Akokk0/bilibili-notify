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

/**
 * 全站不许写死白字。
 *
 * 这些白字脚下的底 —— accent / danger / success / 各种渐变 —— **全都是皮肤改得动的**,
 * 而写死的 `text-white` 不是。底能变、字不能变,皮肤把 accent 调浅一档,主按钮上的字
 * 就整片消失。2026-08-21 真机上就这么翻过一次(About 那颗赞助钮)。
 *
 * 改走 `on-solid` token 之后,底与字才是能一起调的一对。
 */
describe("实底上的前景走 on-solid token", () => {
	const ROOTS = [join(SRC_DIR, "pages"), join(SRC_DIR, "components"), UI_SRC_DIR];

	it('没有哪个 .tsx 还写死 text-white / color:"white"', () => {
		const offenders: string[] = [];
		for (const root of ROOTS) {
			for (const file of listTsxRecursive(root)) {
				// 测试文件里的 `text-white` 是断言「没有白字」用的,不是产品代码。
				if (file.includes("__tests__")) continue;
				const src = readFileSync(file, "utf8");
				src.split("\n").forEach((line, i) => {
					// 注释里引述历史写法不算数(讲的就是「以前写死白字」这件事)。
					const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
					if (/\btext-white\b/.test(code) || /color:\s*"white"/.test(code)) {
						// UI 库与 web 不同根,统一按包名往前截,免得打出 `rc/…` 这种半截路径。
						const rel = file.replace(/^.*?((apps|packages)\/)/, "$1");
						offenders.push(`${rel}:${i + 1}`);
					}
				});
			}
		}
		expect(offenders.join("\n")).toBe("");
	});

	it("这个键在皮肤契约里 —— 只落地 CSS 变量的话皮肤编辑器里根本看不见它", async () => {
		const { SKIN_COLOR_TOKEN_MAP } = await import("@bilibili-notify/contract");
		expect("onSolid" in SKIN_COLOR_TOKEN_MAP).toBe(true);
	});
});

/**
 * 透明度用 `color-mix()` 现调,不许把 alpha 拼成十六进制后缀。
 *
 * `` `${accent}44` `` 这种写法有**两个**独立的坑,而且都是静默的:
 *
 * ① **传进来的是 `var()` 就废了** —— 拼出 `var(--color-bn-pink)44`,非法值、浏览器
 *    直接丢弃,那条边框/底色当场消失。于是它反过来把「这个属性只能收十六进制」的
 *    限制强加给所有调用方,颜色也就跟不了皮肤。`glass.tsx` / `atoms.tsx` 的注释都
 *    记着这条:限制在项目用上 `color-mix()` 之后就该没了,只是没人回来改。
 *
 * ② **传进来是 3 位 hex 也废了** —— `#888` + `1f` = `#8881f`,五位,同样非法同样静默。
 *    `Targets.tsx` 的 `tintFor()` 兜底返回的正是 `#888`,所以未知平台的图标底色框
 *    一直是没有背景的。构建绿、类型绿、肉眼要恰好碰上那条兜底路径才看得见。
 *
 * `color-mix(in srgb, X N%, transparent)` 两个坑都没有:收 hex(3 位 6 位都行)、收
 * `var()`、收 `color-mix()` 自身。
 */
describe("透明度走 color-mix,不拼 hex alpha 后缀", () => {
	const ROOTS = [join(SRC_DIR, "pages"), join(SRC_DIR, "components"), UI_SRC_DIR];
	/** `${accent}44` —— 模板插值紧跟两个十六进制位,后面不再有第三位。 */
	const ALPHA_SUFFIX_RE = /\$\{[^}]+\}[0-9a-fA-F]{2}(?![0-9a-fA-F])/g;

	it("没有哪个 .tsx 还在拼 alpha 后缀", () => {
		const offenders: string[] = [];
		for (const root of ROOTS) {
			for (const file of listTsxRecursive(root)) {
				if (file.includes("__tests__")) continue;
				const src = readFileSync(file, "utf8");
				src.split("\n").forEach((line, i) => {
					// 注释里引述的正是「以前这么拼」这件事,不算数。
					const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
					for (const m of code.matchAll(ALPHA_SUFFIX_RE)) {
						const rel = file.replace(/^.*?((apps|packages)\/)/, "$1");
						offenders.push(`${rel}:${i + 1}  ${m[0]}`);
					}
				});
			}
		}
		expect(offenders.join("\n")).toBe("");
	});
});
