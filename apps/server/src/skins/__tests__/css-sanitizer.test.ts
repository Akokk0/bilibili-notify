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
		const { css, warnings } = ok(`[data-bn="btn"] { border-color: var(--color-bn-border); }`);
		expect(css).toContain("var(--color-bn-border)");
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

/**
 * 装饰性伪元素**永远不许吃点击**。
 *
 * 真机上撞的(2026-08-19,「樱墨 · Sakura Ink」):设计师写了一层再标准不过的
 * 卡面高光 —— `[data-bn="glass"]::before{content:"";position:absolute;inset:0;
 * background:linear-gradient(...)}`。放到任何前端项目里,这段都得配一句
 * `pointer-events:none`;而 `pointer-events` **在我们的白名单外**(它是欺骗面,
 * 刻意不开)。于是设计师写不出正确的覆盖层,也没法补救 —— 主人拿到的是一整页
 * 点不动的按钮。
 *
 * 所以这件事不能求设计师做对,得由这一层**替它做掉**:凡是伪元素规则,一律补上
 * `pointer-events:none`。它写不了(属性被禁)、也覆盖不掉(同样被禁),结构上就没有
 * 出错的余地。
 */
describe("伪元素不吃点击", () => {
	it("伪元素规则一律补 pointer-events:none", () => {
		const { css } = ok(`[data-bn="glass"]::before{content:"";position:absolute;inset:0}`);
		expect(css).toContain("pointer-events:none");
	});

	it("::after 同样补", () => {
		const { css } = ok(`[data-bn="page"]::after{content:"";position:absolute;inset:0}`);
		expect(css).toContain("pointer-events:none");
	});

	it("不是伪元素的规则不碰 —— 给按钮补这句会把按钮本身点死", () => {
		const { css } = ok(`[data-bn="btn"]:hover{opacity:0.9}`);
		expect(css).not.toContain("pointer-events");
	});

	it("皮肤自己写 pointer-events:auto 想抢回来 → 丢弃,补的那句照旧", () => {
		const { css, warnings } = ok(
			`[data-bn="glass"]::before{content:"";position:absolute;inset:0;pointer-events:auto}`,
		);
		expect(warnings.some((w) => w.includes("pointer-events"))).toBe(true);
		expect(css).toContain("pointer-events:none");
		expect(css).not.toContain("pointer-events:auto");
	});
});

/**
 * 绝对定位的伪元素需要一个**定位祖先**,否则 `inset:0` 撑到远处某个祖先甚至整页。
 *
 * 站内多数 `.bn-glass` 卡片身上并没有 `relative`(实测),所以那层「卡面高光」实际
 * 铺满了整页 —— 这也是上面那口点不动的锅的另一半:它不只吃了卡上的点击,是吃了
 * 全页的。补 `pointer-events:none` 之后点击回来了,但那片渐变仍然糊在整页上。
 *
 * 由这一层替它补上宿主的 `position:relative`:只给**真的用了绝对定位伪元素**的
 * 那几个挂点补,不碰别人的布局。
 */
describe("绝对定位伪元素的宿主", () => {
	it("宿主补上 position:relative,伪元素才贴在自己那张卡上", () => {
		const { css } = ok(`[data-bn="glass"]::before{content:"";position:absolute;inset:0}`);
		expect(css).toContain(`[data-bn="glass"]{position:relative}`);
	});

	it("伪元素没用绝对定位 → 不给宿主补,别为没有的问题改人家布局", () => {
		const { css } = ok(`[data-bn="glass"]::before{content:"";background:#fff}`);
		expect(css).not.toContain("position:relative");
	});

	it("一个挂点写了好几条绝对定位伪元素 → 宿主那句只补一次", () => {
		const { css } = ok(
			`[data-bn="page"]::before{content:"";position:absolute;inset:0}
			 [data-bn="page"]::after{content:"";position:absolute;top:0}`,
		);
		expect(css.match(/\[data-bn="page"\]\{position:relative\}/g)).toHaveLength(1);
	});
});
