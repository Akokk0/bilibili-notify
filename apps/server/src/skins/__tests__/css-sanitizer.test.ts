/**
 * 皮肤 CSS 清洗层:白名单制(只放行认识的,不是过滤坏的)。
 *
 * 契约:
 * - 选择器只准 `[data-bn="<hook>"]` 属性选择器(hook 在 SKIN_CSS_HOOK_MAP 名单内)
 *   + 伪类/伪元素/组合器;class / id / 标签 / 通配选择器一律整条丢弃
 * - 声明只放行视觉属性白名单;position 值域限 static/relative/absolute;
 *   伪元素 content 只准空串/none;值里出现 url( 等取网面一律丢弃
 * - @keyframes 放行但名字必须 skin- 前缀;@media 放行并递归清洗;其余 at-rule 丢弃
 * - 非法项**逐条丢弃并出 warning**(宽容模式,与「未知字段忽略告警」同哲学);
 *   整段解析不动(语法碎)才算 error
 * - 输出是重新序列化的产物 —— 存盘的永远是清洗后的 CSS,保留 hook 形式不翻译
 */

import { describe, expect, it } from "vite-plus/test";
import { sanitizeSkinCss } from "../css-sanitizer.js";

function ok(css: string): { css: string; warnings: string[] } {
	const res = sanitizeSkinCss(css);
	expect(res.ok).toBe(true);
	if (!res.ok) throw new Error("unreachable");
	return { css: res.css, warnings: res.warnings };
}

describe("选择器白名单", () => {
	it("hook 属性选择器 + 伪类/伪元素/组合器放行,产物保留 hook 形式", () => {
		const { css, warnings } = ok(
			`[data-bn="glass"]:hover { box-shadow: 0 0 24px rgba(251,114,153,0.5); }
			[data-bn="page"]::before { content: ""; }
			[data-bn="glass"] > [data-bn="btn"] { border-radius: 4px; }`,
		);
		expect(css).toContain('[data-bn="glass"]:hover');
		expect(css).toContain('[data-bn="page"]::before');
		expect(css).toContain('[data-bn="glass"]>[data-bn="btn"]');
		expect(warnings).toEqual([]);
	});

	it("不认识的 hook / class / id / 标签 / 通配选择器 → 整条丢弃并告警", () => {
		const { css, warnings } = ok(
			`[data-bn="nope"] { color: red; }
			.bn-glass { color: red; }
			#root { color: red; }
			div { color: red; }
			* { color: red; }
			[data-bn="glass"] { border-width: 2px; }`,
		);
		expect(css).not.toContain("color");
		expect(css).toContain("border-width:2px");
		expect(warnings).toHaveLength(5);
	});

	it("多选择器逗号列表:只要有一个非法就整条丢弃(不做部分保留)", () => {
		const { css, warnings } = ok(`[data-bn="glass"], div { opacity: 0.9; }`);
		expect(css).not.toContain("opacity");
		expect(warnings).toHaveLength(1);
	});
});

describe("声明白名单", () => {
	it("视觉属性放行;display / pointer-events / visibility 等欺骗面逐条丢弃", () => {
		const { css, warnings } = ok(
			`[data-bn="btn"] {
				background: linear-gradient(90deg, #111, #333);
				border: 2px dashed #fb7299;
				transform: rotate(-1deg);
				display: none;
				pointer-events: none;
				visibility: hidden;
			}`,
		);
		expect(css).toContain("background:");
		expect(css).toContain("transform:");
		expect(css).not.toContain("display");
		expect(css).not.toContain("pointer-events");
		expect(css).not.toContain("visibility");
		expect(warnings).toHaveLength(3);
	});

	it("值里出现 url( / image-set( / element( → 该声明丢弃(外联取网面全禁)", () => {
		const { css, warnings } = ok(
			`[data-bn="glass"] {
				background: url(https://evil.example/x.png);
				background-image: image-set("x.png" 1x);
				border-color: #123456;
			}`,
		);
		expect(css).not.toContain("url(");
		expect(css).not.toContain("image-set");
		expect(css).toContain("border-color:#123456");
		expect(warnings).toHaveLength(2);
	});

	it("position 只准 static/relative/absolute;fixed/sticky 丢弃", () => {
		const { css, warnings } = ok(
			`[data-bn="page"]::after { position: absolute; inset: 0; }
			[data-bn="glass"] { position: fixed; }`,
		);
		expect(css).toContain("position:absolute");
		expect(css).not.toContain("fixed");
		expect(warnings).toHaveLength(1);
	});

	it("content 只准空串或 none;带文字的 content 丢弃(防伪造界面文案)", () => {
		const { css, warnings } = ok(
			`[data-bn="page"]::before { content: ""; }
			[data-bn="page"]::after { content: "FAKE LOGIN"; }`,
		);
		expect(css).toContain('content:""');
		expect(css).not.toContain("FAKE");
		expect(warnings).toHaveLength(1);
	});

	it("var() 引用令牌放行(读内部样式变量无安全面,且是正经用法)", () => {
		const { css, warnings } = ok(`[data-bn="btn"] { border-color: var(--bn-glass-border); }`);
		expect(css).toContain("var(--bn-glass-border)");
		expect(warnings).toEqual([]);
	});
});

describe("at-rule", () => {
	it("@keyframes 放行但名字必须 skin- 前缀;animation 属性放行", () => {
		const { css, warnings } = ok(
			`@keyframes skin-float { from { transform: translateY(0); } to { transform: translateY(-8px); } }
			@keyframes bad-name { from { opacity: 0; } }
			[data-bn="glass"] { animation: skin-float 3s ease-in-out infinite alternate; }`,
		);
		expect(css).toContain("@keyframes skin-float");
		expect(css).not.toContain("bad-name");
		expect(css).toContain("animation:skin-float");
		expect(warnings).toHaveLength(1);
	});

	it("@media 放行并递归清洗内部规则;@import / @font-face 丢弃", () => {
		const { css, warnings } = ok(
			`@import "https://evil.example/x.css";
			@font-face { font-family: X; src: url(x.woff); }
			@media (prefers-reduced-motion: no-preference) {
				[data-bn="glass"] { transition: transform 0.2s; }
				div { color: red; }
			}`,
		);
		expect(css).not.toContain("@import");
		expect(css).not.toContain("@font-face");
		expect(css).toContain("@media");
		expect(css).toContain("prefers-reduced-motion");
		expect(css).toContain("transition:");
		expect(css).not.toContain("color");
		expect(warnings).toHaveLength(3);
	});
});

describe("硬失败与体积", () => {
	it("超过 64KB → error", () => {
		const big = `[data-bn="glass"] { border-width: 1px; }`.repeat(3000);
		const res = sanitizeSkinCss(big);
		expect(res.ok).toBe(false);
	});

	it("空串 / 全被丢弃 → ok 且产物为空串", () => {
		const { css } = ok("div { color: red; }");
		expect(css).toBe("");
		expect(ok("").css).toBe("");
	});
});
