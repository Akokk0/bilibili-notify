/**
 * **内置块只画结构,不带样子**(ADR-0014 决策 7 的 2026-09-19 🔗)。
 *
 * 块的外观(颜色 / 背景 / 圆角 / 边框 / 阴影 / 字号字重行高 / 内外边距 / 间距 / 头像这类定死
 * 的尺寸)全住在出厂默认皮肤各块的 CSS 里;渲染器的 class 只准剩撑住结构的那几个
 * (display / flex 族 / 对齐 / 百分比宽高 / shrink / overflow / 截断 / object-fit)。
 *
 * 这条守卫**扫源码**而不是扫产物:一个外观类若在别处也出现过,产物里它照样有 CSS 规则,
 * 光看产物看不出「是谁带进来的」。判据是 class 属性与 class 常量里的每个 token 都不许
 * 长得像外观类 —— 有人顺手把 `rounded-lg` 写回封面上,这里当场红,而字节基准只会说
 * 「又变了一片」。
 *
 * 范围按卡种一片片扩(ADR 里定的是按卡种切片、每片过像素门才提交),扫到哪列到哪。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const BLOCKS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "blocks");

/** 已经搬空外观的块文件。 */
const BARE_FILES = ["live.tsx", "dynamic.tsx", "sc.tsx"];

/**
 * 长得像外观的 class token。列的是 UnoCSS 里会编成外观属性的那些前缀;结构类
 * (`flex` / `items-center` / `w-full` / `h-full` / `block` / `shrink-0` / `min-w-0` /
 * `overflow-hidden` / `truncate` / `line-clamp-*` / `object-*` / `whitespace-*`)都不在里头。
 */
const APPEARANCE = [
	/^rounded(-|$)/,
	/^text-\[/, // 字号 / 字色的任意值
	/^text-(white|black|transparent)$/,
	/^(bg|from|to|via)-/,
	/^(p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr)-/,
	/^gap-/,
	/^font-/,
	/^leading-/,
	/^tracking-/,
	/^shadow/,
	/^border(?!-box)/,
	/^opacity-/,
	/^(w|h)-\[/, // 定死的尺寸(`w-full` / `h-full` / `h-px` 不算)
	/^(w|h)-\d/,
	/^\[(color|background|background-color|border|box-shadow|font-size)[:\]]/,
];

/** 文件里所有 class 的 token:`class="…"` 属性、以及 `_CLASS = "…"` 这类常量。 */
function classTokens(source: string): string[] {
	const out: string[] = [];
	for (const m of source.matchAll(/class="([^"]*)"/g)) out.push(...(m[1] ?? "").split(/\s+/));
	for (const m of source.matchAll(/_CLASS\s*=\s*"([^"]*)"/g))
		out.push(...(m[1] ?? "").split(/\s+/));
	for (const m of source.matchAll(/class=\{`([^`]*)`\}/g))
		out.push(...(m[1] ?? "").replace(/\$\{[^}]*\}/g, " ").split(/\s+/));
	return out.filter(Boolean);
}

/**
 * `bg-` 打头、但其实是**结构**的两个:`background-size:cover` 与 `background-position:center`。
 * 它们是「一张数据来的背景图怎么裁、怎么摆」,与 `object-cover` 是同一件事的两种写法
 * (图当背景铺时用这一对,当 `<img>` 时用那一个)—— 底色 / 渐变那类才是外观。
 */
const STRUCTURAL: ReadonlySet<string> = new Set(["bg-cover", "bg-center"]);

export function appearanceTokens(source: string): string[] {
	return classTokens(source).filter(
		(t) => !STRUCTURAL.has(t) && APPEARANCE.some((re) => re.test(t)),
	);
}

describe("内置块只画结构 — 块文件里没有外观类", () => {
	for (const file of BARE_FILES) {
		it(`blocks/${file}`, () => {
			const source = readFileSync(join(BLOCKS_DIR, file), "utf8");
			expect(appearanceTokens(source)).toEqual([]);
		});
	}

	it("扫描器认得出外观类(把守卫本身改坏能红)", () => {
		expect(
			appearanceTokens(
				'<img class="block w-full h-full object-cover rounded-lg" /><span class="text-[16px] font-bold [color:var(--bn-ink)]">',
			),
		).toEqual(["rounded-lg", "text-[16px]", "font-bold", "[color:var(--bn-ink)]"]);
		expect(
			appearanceTokens('<div class="flex items-center gap-x w-full min-w-0 truncate">'),
		).toEqual(["gap-x"]);
	});

	// `STRUCTURAL` 是 `bg-` 那条规则上开的一个小口,开宽了(比如整条 `bg-` 都放行)守卫就
	// 瞎了一半 —— 所以口子自己也要有守卫:放行的只有那两个,别的 `bg-` 照抓。
	it("bg- 的口子只开给裁法与定位,底色 / 渐变照抓", () => {
		expect(
			appearanceTokens('<div class="bg-cover bg-center bg-white/50 bg-black/60 bg-gradient-to-r">'),
		).toEqual(["bg-white/50", "bg-black/60", "bg-gradient-to-r"]);
	});
});
