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

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { listSources } from "./walk.js";

/**
 * **不在这一层跳测试**(`skipTests: false`)—— 下面十几道断言里,该跳的各自
 * `continue`,不该跳的(如 token 定义是否存在)本来就要连测试一起看。
 */
const listTsx = (dir: string) => listSources(dir, { skipTestDirs: false });

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

// `hover:border-bn-accent/60` → 捕获前缀 `border` 与 token `bn-accent`(前缀修饰符
// 无所谓;`/60` 透明度后缀因为 `/` 不在字符集里会自然截断)。
const USAGE_RE = new RegExp(`\\b(${COLOR_PREFIXES.join("|")})-(bn-[a-z0-9-]+)`, "g");

/** 已定义的颜色 token(`--color-bn-pink` → `bn-pink`),ui 包 theme.css + web styles.css 合并。 */
function definedColorTokens(): Set<string> {
	const css = readFileSync(UI_THEME, "utf8") + readFileSync(STYLES, "utf8");
	const found = css.match(/--color-(bn-[a-z0-9-]+)\s*:/g) ?? [];
	return new Set(found.map((m) => m.replace(/--color-|\s*:/g, "")));
}

/**
 * 已定义的**字号** token(`--text-bn-xs` → `bn-xs`)。
 *
 * `text-` 这一个前缀横跨两个 namespace:`text-bn-text-primary` 是颜色
 * (`--color-bn-*`)、`text-bn-xs` 是字号(`--text-bn-*`)。守卫要是只认颜色那一半,
 * 字号阶梯一落地就会被整片报成「token 未定义」。其余前缀(bg / border / ring …)
 * 没有这个歧义,只查颜色。
 */
function definedSizeTokens(): Set<string> {
	const css = readFileSync(UI_THEME, "utf8");
	const found = css.match(/--text-(bn-[a-z0-9-]+)\s*:/g) ?? [];
	return new Set(found.map((m) => m.replace(/--text-|\s*:/g, "")));
}

describe("颜色 token conformance", () => {
	it("所有 bn-* 颜色类都引用 styles.css 里真实定义的 token", () => {
		const defined = definedColorTokens();
		const sizes = definedSizeTokens();
		// 定义集自身得先是像样的 —— 否则正则一改就悄悄退化成「空集,人人合格」。
		expect(defined.size).toBeGreaterThan(10);
		expect(defined.has("bn-pink")).toBe(true);
		expect(sizes.has("bn-xs")).toBe(true);

		const offenders: Array<{ token: string; file: string }> = [];
		for (const file of [
			...listTsx(join(SRC_DIR, "pages")),
			...listTsx(join(SRC_DIR, "components")),
			// 库里的纯展示件同样受此约束 —— 它们的 class 也靠这两份 css 的 token 兑现。
			...listTsx(UI_SRC_DIR),
		]) {
			const src = readFileSync(file, "utf8");
			for (const m of src.matchAll(USAGE_RE)) {
				const [, prefix, token] = m;
				if (prefix === "text" && token && sizes.has(token)) continue;
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
			for (const file of listTsx(root)) {
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
			for (const file of listTsx(root)) {
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
	/**
	 * 三个端整棵扫。此前这里是 `[web/pages, web/components, packages/ui]` 的白名单,
	 * 于是 desktop 落在网外 —— 它那颗状态胶囊写着 `color="#FB7299"`,正是
	 * `--color-bn-pink` 的值,皮肤换了主强调色它还钉在 B 站粉。白名单漏掉一个目录
	 * 是这份守卫犯过的第二次(第一次是家族色守卫没看 `packages/ui`)。
	 */
	const ROOTS = [SRC_DIR, UI_SRC_DIR, join(SRC_DIR, "../../desktop/src")];
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
			for (const file of listTsx(root)) {
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
		for (const file of listTsx(SRC_DIR)) {
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

/**
 * **颜色一律走 token,不用 Tailwind 自带调色板、也不写任意值 hex。**
 *
 * `text-gray-500` / `bg-white` / `bg-[#0f1115]` 这三种写法都跳得出皮肤 —— 它们编译成
 * 固定的色值,`--color-bn-*` 那一层根本不经过。默认装看着没事,换个皮肤就露:玻璃调暗了
 * 而钮还是白底,面色调深了而时间轴圆点还箍着一圈白边。
 *
 * 收尾这一轮清的就是最后四个文件:Logs 的控制台、About 的代码块、草稿岛的保存钮、
 * Dashboard 时间轴的圆点。控制台那两块**确实**该恒暗,但恒暗不等于写死 —— 现在走
 * `--color-bn-console-*`,值仍然固定,只是集中到一处、两边不会再各飘各的。
 *
 * 扫三个端的源码,不留白名单 —— 白名单正是家族色守卫漏掉 `StatsBar` 的原因。
 */
describe("颜色一律走 token", () => {
	const PALETTE = [
		"gray|slate|zinc|neutral|stone",
		"red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky",
		"blue|indigo|violet|purple|fuchsia|pink|rose",
		"black|white",
	].join("|");
	const PREFIX = "text|bg|border|from|via|to|ring|fill|stroke|divide|outline|decoration";
	const RAW_RE = new RegExp(
		`\\b(?:${PREFIX})-(?:${PALETTE})(?:-\\d{2,3})?\\b|\\b(?:${PREFIX})-\\[#[0-9a-fA-F]{3,8}\\]`,
		"g",
	);

	const ROOTS = [
		[SRC_DIR, "apps/web/src"],
		[UI_SRC_DIR, "packages/ui/src"],
		[join(SRC_DIR, "../../desktop/src"), "apps/desktop/src"],
	] as const;

	it("三个端里都没有原生调色板类,也没有任意值 hex 类", () => {
		const findings: string[] = [];
		for (const [root, label] of ROOTS) {
			for (const file of listTsx(root)) {
				if (/__tests__|\.test\./.test(file)) continue;
				const src = readFileSync(file, "utf8")
					.replace(/\/\*[\s\S]*?\*\//g, "")
					.replace(/\/\/.*$/gm, "");
				const hits = [...new Set([...src.matchAll(RAW_RE)].map((m) => m[0]))];
				if (hits.length > 0) {
					findings.push(`${label}/${file.slice(root.length + 1)}: ${hits.join(" ")}`);
				}
			}
		}
		expect(findings).toEqual([]);
	});
});

/**
 * **叠放层级走分层表,不写裸数字。**
 *
 * 收编前 12 个层级散在十来个文件里,加一层浮层只能翻别处的 className 猜一个不撞的
 * 数字 —— `header.tsx` 与 `draft-island.tsx` 的注释里各存了半张手写的对照表,正是
 * 因为源码里读不出顺序。表在 `theme.css`,数值一个没动。
 *
 * `z-index` 没有 Tailwind theme namespace,所以那一族是手写 `@utility`(同 shadow)。
 */
describe("叠放层级走分层表", () => {
	/** `z-10` 这类裸档,以及 inline 的 `zIndex: 60`。`z-bn-*` 不在网内。 */
	const Z_RE = /\bz-\d+\b|\bz-\[[^\]]+\]|\bzIndex\s*:\s*\d+/g;
	const ROOTS = [
		[SRC_DIR, "apps/web/src"],
		[UI_SRC_DIR, "packages/ui/src"],
		[join(SRC_DIR, "../../desktop/src"), "apps/desktop/src"],
	] as const;

	it("三个端里都没有裸 z-index", () => {
		const findings: string[] = [];
		for (const [root, label] of ROOTS) {
			for (const file of listTsx(root)) {
				if (/__tests__|\.test\./.test(file)) continue;
				const src = readFileSync(file, "utf8")
					.replace(/\/\*[\s\S]*?\*\//g, "")
					.replace(/\/\/.*$/gm, "");
				const hits = [...new Set([...src.matchAll(Z_RE)].map((m) => m[0]))];
				if (hits.length > 0) {
					findings.push(`${label}/${file.slice(root.length + 1)}: ${hits.join(" ")}`);
				}
			}
		}
		expect(findings).toEqual([]);
	});

	it("每个 z-bn-* utility 在 theme.css 里都有定义 —— 拼错了 Tailwind 是静默丢弃的", () => {
		const css = readFileSync(UI_THEME, "utf8");
		const defined = new Set([...css.matchAll(/@utility\s+(z-bn-[a-z-]+)\s*\{/g)].map((m) => m[1]));
		const used = new Set<string>();
		for (const [root] of ROOTS) {
			for (const file of listTsx(root)) {
				for (const m of readFileSync(file, "utf8").matchAll(/\bz-bn-[a-z-]+/g)) used.add(m[0]);
			}
		}
		expect([...used].filter((u) => !defined.has(u))).toEqual([]);
	});
});

/**
 * **字号走阶梯,不写 `text-[Npx]`。**
 *
 * 收编前站里 454 处写死的字号漂成 21 个值,从 9px 到 32px,半档遍地:同样是配
 * `text-bn-text-tertiary` 的小字注脚,10 / 10.5 / 11 / 11.5 四个档都有人用,肉眼
 * 分不出却各写各的。归并成 9 档之后字号进了 `@theme`,皮肤也才有的可调。
 *
 * 只拦**绝对像素**。`text-[0.88em]` 那种相对单位是另一回事 —— 它说的是「比父级
 * 小一点」(markdown 里的行内 code),跟阶梯不冲突,换个阶梯档反而会写死死。
 *
 * `packages/image` 不在扫描范围:那是 SSR 卡片渲染器,自带一套样式正本
 * (`packages/image/src/styles.ts`),跟前端的 theme.css 无关。
 */
describe("字号走阶梯", () => {
	const PX_RE = /\btext-\[[0-9.]+px\]/g;
	const ROOTS = [
		[SRC_DIR, "apps/web/src"],
		[UI_SRC_DIR, "packages/ui/src"],
		[join(SRC_DIR, "../../desktop/src"), "apps/desktop/src"],
	] as const;

	it("三个端里都没有写死的像素字号", () => {
		const findings: string[] = [];
		for (const [root, label] of ROOTS) {
			for (const file of listTsx(root)) {
				const src = readFileSync(file, "utf8")
					.replace(/\/\*[\s\S]*?\*\//g, "")
					.replace(/\/\/.*$/gm, "");
				const hits = [...new Set([...src.matchAll(PX_RE)].map((m) => m[0]))];
				if (hits.length > 0) {
					findings.push(`${label}/${file.slice(root.length + 1)}: ${hits.join(" ")}`);
				}
			}
		}
		expect(findings).toEqual([]);
	});

	it("阶梯是**单调**的 —— 档名排下来字号必须一档比一档大", () => {
		const css = readFileSync(UI_THEME, "utf8");
		const ORDER = ["micro", "2xs", "xs", "sm", "base", "md", "lg", "xl", "hero"];
		const px = ORDER.map((name) => {
			const m = new RegExp(`--text-bn-${name}:\\s*([0-9.]+)px`).exec(css);
			return m ? Number(m[1]) : Number.NaN;
		});
		// 每一档都得真在表里 —— 否则 NaN 会让下面的比较静默放行。
		expect(px.filter(Number.isNaN)).toEqual([]);
		expect(px).toEqual([...px].sort((a, b) => a - b));
		expect(new Set(px).size).toBe(px.length);
	});
});

/**
 * **两栏骨架只有一份。**
 *
 * `SectionNav` 那五页共用「左侧竖栏 + 右侧内容」,收编前每页各写一遍
 * `xl:grid-cols-[220px_1fr]`,六处逐字节相同 —— `section-nav.tsx` 的注释里还得三次
 * 把这串类名抄出来解释自己跟谁配对。现在栏宽在 `--bn-rail-width`,类名是
 * `grid-bn-rail`,改一次五页跟着动。
 */
describe("两栏骨架只有一份", () => {
	const ROOTS = [
		[SRC_DIR, "apps/web/src"],
		[UI_SRC_DIR, "packages/ui/src"],
	] as const;

	it("没有哪一页再手写栏宽", () => {
		const findings: string[] = [];
		for (const [root, label] of ROOTS) {
			for (const file of listTsx(root)) {
				const src = readFileSync(file, "utf8");
				if (/grid-cols-\[\d+px_1fr\]/.test(src))
					findings.push(`${label}/${file.slice(root.length + 1)}`);
			}
		}
		expect(findings).toEqual([]);
	});

	it("栏宽变量与 utility 都真的在表里", () => {
		const css = readFileSync(UI_THEME, "utf8");
		expect(/--bn-rail-width:\s*\d+px/.test(css)).toBe(true);
		expect(/@utility\s+grid-bn-rail\s*\{/.test(css)).toBe(true);
	});
});

/**
 * **字号阶梯刻意不进皮肤词表。**
 *
 * 九档是变量,`theme.css` 里改一处全站跟着走 —— 但这是给维护者的口子,不是给皮肤作者的。
 * 开给皮肤就是「大字模式」,而那件事主人明确不要,理由也站得住:九档**不是等比的**
 * (下半段 10→11→12→13 是 +1 密排、上半段 13→15→17→20→28 越拉越开),没法像圆角那样
 * 用一根系数整体缩放;逐档开九个键的话,只要有人把 `xs` 调得比 `sm` 大,版式的主次关系
 * 当场反过来,而那种坏法在编辑器里看不出来 —— 得回到每一页去发现。
 *
 * 这条守卫拦的是「日后有人顺手把它加进词表」。要开的话先想清怎么防住逆序,别只加键。
 *
 * 栏宽是反例:它**开了**(`SKIN_LIMITS.railWidth`)—— 单个数字、两头夹死、调坏了最多是
 * 左栏胖瘦,不会让版式的层级关系失效。
 */
describe("字号阶梯不进皮肤词表", () => {
	it("皮肤契约里没有任何 --text-bn-* 的键", () => {
		const contract = readFileSync(join(SRC_DIR, "../../contract/src/skin.ts"), "utf8");
		expect(contract).not.toContain("--text-bn-");
		// 反面对照:别的 token 族确实在词表里,免得这条退化成「扫了个空文件」。
		expect(contract).toContain("--color-bn-");
		expect(contract).toContain("railWidth");
	});

	it("皮肤注入端也不写字号变量", () => {
		const inject = readFileSync(join(SRC_DIR, "services/skin.ts"), "utf8");
		expect(inject).not.toContain("--text-bn-");
		expect(inject).toContain("--radius-bn-card");
	});
});
