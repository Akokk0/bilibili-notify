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
			[data-bn="glass"]::before { content:""; position: fixed; }`,
		);
		expect(css).toContain("position:absolute");
		expect(css).not.toContain("position:fixed");
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

	it("伪元素规则一律补 z-index:-1 —— 装饰永远画在宿主内容之下", () => {
		const { css } = ok(`[data-bn="glass"]::before{content:"";position:absolute;inset:0}`);
		expect(css).toContain("z-index:-1");
	});

	it("皮肤自己写 z-index 想压到内容之上 → 补的那句在它后面,压得住", () => {
		const { css } = ok(`[data-bn="glass"]::before{content:"";position:absolute;inset:0;z-index:5}`);
		expect(css.lastIndexOf("z-index:5")).toBeLessThan(css.lastIndexOf("z-index:-1"));
	});

	it("不是伪元素的规则不补 z-index —— 那是宿主自己的层级", () => {
		const { css } = ok(`[data-bn="glass"]{opacity:0.9}`);
		expect(css).not.toContain("z-index");
	});
});

/**
 * 宿主的 `position` **不是皮肤的事**。
 *
 * 上一轮为了让 `inset:0` 贴在自己那张卡上,这一层给宿主补了一句 `[data-bn=X]
 * {position:relative}`。那句埋了两颗雷:
 *
 * 1. 顶栏是 `.bn-glass-strong` + Tailwind 的 `sticky` 工具类。皮肤 CSS 是**无层**
 *    author 样式,而工具类在 `@layer utilities` 里 —— 层的比较发生在特异性**之前**,
 *    无层永远赢。于是那句 `position:relative` 把顶栏的 `position:sticky` 顶掉了。
 * 2. 它压根不必要:`.bn-glass` / `.bn-glass-strong` 身上有 `backdrop-filter`,那本身
 *    就已经建立了包含块与层叠上下文。真正缺定位的宿主由**注入层**在 `@layer
 *    components` 里补(见 web 的 composeSkinCss),那一层排在 utilities 之前,工具类
 *    照旧赢。
 *
 * 所以这一层的职责反过来:host 规则里的 `position` 一律拒收,伪元素规则里照旧放行。
 */
describe("宿主的 position 不归皮肤管", () => {
	it("非伪元素规则里的 position 一律丢弃并给出理由", () => {
		const { css, warnings } = ok(`[data-bn="header"]{position:relative;opacity:0.9}`);
		expect(css).not.toContain("position");
		expect(warnings.some((w) => w.includes("position"))).toBe(true);
	});

	it("伪元素规则里的 position 照旧放行 —— 装饰层自己得能绝对定位", () => {
		const { css } = ok(`[data-bn="glass"]::before{content:"";position:absolute;inset:0}`);
		expect(css).toContain("position:absolute");
	});

	it("不再往产物里塞宿主定位那条规则(那活儿搬去注入层了)", () => {
		const { css } = ok(`[data-bn="glass"]::before{content:"";position:absolute;inset:0}`);
		expect(css).not.toContain("{position:relative}");
	});
});

describe("取网面的转义写法", () => {
	/**
	 * `\75 ` 在 CSS 里就是 `u` —— tokenizer 按规范**先解转义再判 ident**,所以
	 * `\75 rl(...)` 到了浏览器手上就是 `url(...)`,照发请求。子串匹配 `url(` 看不见
	 * 它,而这一层挡的正是「外联隐私泄露面」。
	 *
	 * 同仓 schema.ts 的 FORBIDDEN_SUBSTRINGS 一直挡着反斜杠,这一层却没有 ——
	 * 两处口径必须一致,否则弱的那层恰好是能力更强的那层。
	 */
	it("转义写的 url( → 该声明丢弃", () => {
		const { css, warnings } = ok(
			`[data-bn="page"]::before { content: ""; background: \\75 rl(https://evil.example/x.png); }`,
		);
		expect(css).not.toContain("75 rl");
		expect(warnings.join()).toContain("转义");
	});

	it("值里任何反斜杠都丢 —— 白名单里的属性没有一个需要它", () => {
		const { warnings } = ok(`[data-bn="page"] { background: \\72 ed; }`);
		expect(warnings.join()).toContain("转义");
	});
});

describe("宿主不许隐身", () => {
	/**
	 * `opacity:0` 比 `visibility:hidden` 更毒:不可见,但**仍然可点**。白名单挡掉了
	 * 后者却放行前者,等于挡了安全的那个、放行了危险的那个。宿主给下限,装饰层
	 * (伪元素)照旧随便淡 —— 它本来就 pointer-events:none 且压在内容之下。
	 *
	 * 注意这道闸**不封闭**:`background:transparent;color:transparent` 同样让按钮
	 * 隐形,而那是主题系统的固有能力,拦不掉也不该拦。这里只堵最顺手的那条。
	 */
	it("宿主 opacity 低于下限 → 丢弃", () => {
		const { warnings } = ok(`[data-bn~="btn"] { opacity: 0; }`);
		expect(warnings.join()).toContain("opacity");
	});

	it("百分号写法同样算数", () => {
		const { warnings } = ok(`[data-bn~="btn"] { opacity: 0%; }`);
		expect(warnings.join()).toContain("opacity");
	});

	it("正常的淡化照旧放行", () => {
		const { css, warnings } = ok(`[data-bn~="btn"] { opacity: 0.6; }`);
		expect(css).toContain("opacity:0.6");
		expect(warnings).toEqual([]);
	});

	it("装饰性伪元素想多淡有多淡", () => {
		const { css, warnings } = ok(`[data-bn="page"]::before { content: ""; opacity: 0.04; }`);
		expect(css).toContain("opacity:0.04");
		expect(warnings).toEqual([]);
	});

	it("filter:opacity() 是同一把锁的另一把钥匙,一起收", () => {
		const { warnings } = ok(`[data-bn~="btn"] { filter: opacity(0); }`);
		expect(warnings.join()).toContain("opacity");
	});

	it("@keyframes 里按宿主从严 —— 同一段动画挂得到宿主身上", () => {
		const { warnings } = ok(`@keyframes skin-vanish { to { opacity: 0; } }`);
		expect(warnings.join()).toContain("opacity");
	});
});
