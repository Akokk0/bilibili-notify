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

/**
 * 强调色属性(`accent` / `color` / `tone` / `titleColor`)不许写与 token **同值**的
 * 十六进制字面量。
 *
 * 上面那条管的是 class 串,这条管的是**属性**。玻璃件的 `accent`、`Pill` 的 `color`
 * 都同时收 hex 与 `var()`(内部 `color-mix()`,见 glass.tsx),于是写 `#FB7299` 和写
 * `var(--color-bn-pink)` 在默认装下**像素级一致** —— 差别只在装了皮肤之后:后者跟着
 * 强调色换装,前者永远钉在 B 站粉。整页都赛博朋克了,Rules 那一排分区的角光还是粉的。
 *
 * 和 class 那条是同一种失败模式:门禁全绿、开发机上看不出来,只有真机装皮肤才露馅。
 *
 * **判据是「与已定义 token 同值」而不是「是个 hex」** —— 站里有一批**刻意**不跟皮肤的
 * 产品语言色(`config/push-kinds.ts`:「直播是粉的、动态是蓝的」,皮肤重上色会让两种
 * kind 撞成一个颜色)。那些走常量表引用,不是字面量,天然不落进这张网;要引用它们就
 * 写 `color={PUSH_TONE.live}`,这条守卫就管不着,正是想要的效果。
 *
 * 取值只读**亮色**那两块(`@theme` + `:root`),不读 `[data-theme="dark"]` 的重定义:
 * 亮色块才是调色板正本,暗色块里像 `#94a3b8` 这种值在亮色下是另一个 token,一起收会
 * 误伤一批本来就没有 token 的分区装饰色。
 */
describe("强调色属性走 token,不写同值 hex", () => {
	const ROOTS = [join(SRC_DIR, "pages"), join(SRC_DIR, "components"), UI_SRC_DIR];
	const COLOR_PROPS = ["accent", "color", "tone", "titleColor"];
	/**
	 * 属性值两种写法都要抓:`accent="#FB7299"` 与 `accent={a ? "#ef4444" : "#22c55e"}`。
	 * 只认 `=`(JSX 属性),**不认 `:`** —— `{ tone: "#FB7299" }` 那是常量色表的写法,
	 * 站里有一批刻意不跟皮肤的产品语言色正住在那种表里(见上方注释)。
	 */
	const PROP_RE = new RegExp(
		`\\b(?:${COLOR_PROPS.join("|")})\\s*=\\s*(?:"(#[0-9a-fA-F]{3,8})"|\\{[^{}]*\\})`,
		"g",
	);
	const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;

	/**
	 * 刻意还没转的,连**为什么**一起记。数字是该文件里刻意留下的**个数**。
	 *
	 * 同 `input-hook-coverage` 那张表的规矩:只填数字等于没说清,而且写了却已经改完的
	 * 文件也要报 —— 否则豁免条目会一直挂着骗人。
	 */
	const KEPT: Record<string, { count: number; why: string }> = {};

	/** 亮色调色板:`#fb7299` → `--color-bn-pink`。 */
	function lightPalette(): Map<string, string> {
		const css = readFileSync(UI_THEME, "utf8");
		const light = css.slice(0, css.indexOf(':root[data-theme="dark"]'));
		const map = new Map<string, string>();
		for (const m of light.matchAll(/(--color-bn-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
			// 同一个色值可能挂多个 token(surface / surface-strong 都是 #ffffff),留第一个报出来就够。
			if (!map.has((m[2] as string).toLowerCase()))
				map.set((m[2] as string).toLowerCase(), m[1] as string);
		}
		return map;
	}

	it("没有哪个 accent / color 属性写死了 token 的色值", () => {
		const palette = lightPalette();
		// 调色板自身得先像样 —— 正则一改就悄悄退化成「空集,人人合格」。
		expect(palette.get("#fb7299")).toBe("--color-bn-pink");
		expect(palette.size).toBeGreaterThan(10);

		const found: string[] = [];
		for (const root of ROOTS) {
			for (const file of listTsxRecursive(root)) {
				if (file.includes("__tests__")) continue;
				const src = readFileSync(file, "utf8");
				src.split("\n").forEach((line, i) => {
					const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
					for (const m of code.matchAll(PROP_RE)) {
						for (const hex of (m[0] as string).match(HEX_RE) ?? []) {
							const token = palette.get(hex.toLowerCase());
							if (!token) continue;
							const rel = file.replace(/^.*?((apps|packages)\/)/, "$1");
							found.push(`${rel}:${i + 1}  ${hex} → 改写成 var(${token})`);
						}
					}
				});
			}
		}

		const perFile = new Map<string, string[]>();
		for (const f of found) {
			const file = (f.split(":")[0] as string).trim();
			perFile.set(file, [...(perFile.get(file) ?? []), f]);
		}

		const offenders: string[] = [];
		for (const [file, hits] of perFile) {
			const kept = KEPT[file];
			if (!kept) offenders.push(...hits);
			else if (hits.length !== kept.count) {
				offenders.push(`${file}: 实际 ${hits.length} 处,豁免表写的是 ${kept.count}`, ...hits);
			}
		}
		// 豁免表里写了、实际却已经改完的文件也要报 —— 否则它会一直挂着骗人。
		for (const file of Object.keys(KEPT)) {
			if (!perFile.has(file)) offenders.push(`${file}: 已经全部转完,请从豁免表删掉`);
		}
		expect(offenders.join("\n")).toBe("");
	});

	it("豁免表每一条都写了理由 —— 只填数字等于没说清", () => {
		const naked = Object.entries(KEPT)
			.filter(([, v]) => v.why.trim().length < 20)
			.map(([k]) => k);
		expect(naked).toEqual([]);
	});
});

/**
 * 平台标识色只有库里那一份。
 *
 * 库导出了 `PlatformIcon` / `platformLabel`,唯独没导出色 —— 于是 Targets 照着库里的
 * `PLATFORM_META` 又抄了一份 `PLATFORM_TINT`,三个色加一个 `#888` 兜底逐字节相同。
 * 现在色走 `platformTint()`,兜底也换成了静默档 token。
 *
 * 判据与家族色守卫一致:**凑齐三个才算**。单独一个不作数 —— `#22c55e` 是通用的
 * 「成功绿」,`#3b82f6` 是通用的「信息蓝」,它们各自出现和平台表无关。
 */
describe("平台标识色只有库里那一份", () => {
	const PLATFORM_HEXES = ["#3b82f6", "#14b8a6", "#22c55e"];

	it("站点源码里不再出现成套的平台色", () => {
		const findings: string[] = [];
		for (const file of listTsxRecursive(SRC_DIR)) {
			if (/__tests__|\.test\./.test(file)) continue;
			const src = readFileSync(file, "utf8")
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/\/\/.*$/gm, "")
				.toLowerCase();
			const hit = PLATFORM_HEXES.filter((h) => src.includes(h));
			if (hit.length >= 3) findings.push(`${file.slice(SRC_DIR.length + 1)}: ${hit.join(" ")}`);
		}
		expect(findings).toEqual([]);
	});
});
