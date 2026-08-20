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

/** 数一个片段出现几次 —— 「清洗完只该剩一条」这类断言全靠它。 */
function countOf(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

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

	it("image-rendering 放行 —— 像素风皮肤靠它关掉浏览器的平滑插值", () => {
		const { css, warnings } = ok(
			`[data-bn="page"] {
				image-rendering: pixelated;
			}`,
		);
		expect(css).toContain("image-rendering:pixelated");
		expect(warnings).toHaveLength(0);
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

	it("上限按 UTF-8 字节算 —— 中文注释不该按一个字一格算", () => {
		// `input.length` 是 UTF-16 单元数,一个汉字才记 1。皮肤里的中文注释一多,
		// 「64K 字符」落到盘上就是将近 192KB —— 闸声称拦住的量与实际差三倍。
		const big = `/* ${"皮肤注释".repeat(6000)} */\n[data-bn="glass"]{color:red}`;
		expect(big.length).toBeLessThan(64 * 1024);
		expect(Buffer.byteLength(big, "utf8")).toBeGreaterThan(64 * 1024);
		expect(sanitizeSkinCss(big).ok).toBe(false);
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

	it("皮肤自己写 z-index 想压到内容之上 → 它被摘掉,产物里只剩硬规矩那一条", () => {
		// 原先是「补的那句排在它后面,靠后到者赢压住」。改成摘掉是因为**存盘的是
		// 清洗后的产物**:留着尸体的话,下一轮清洗又补一条,每保存一次攒一个。
		const { css } = ok(`[data-bn="glass"]::before{content:"";position:absolute;inset:0;z-index:5}`);
		expect(css).not.toContain("z-index:5");
		expect(countOf(css, "z-index:")).toBe(1);
		expect(css).toContain("z-index:-1");
	});

	it("反复清洗不膨胀 —— 存盘的是产物,下次保存还要再过一遍", () => {
		// 真机上「超天酱 · 像素窗口」攒到了 **84 条** z-index:-1(12 处伪元素 × 7 轮)。
		// pointer-events 没跟着涨,恰恰印证了这条链路:它不在白名单里,上一轮那条会被
		// 过滤先删掉再重加,恒为 1;z-index 在白名单里、过滤放行,于是一轮攒一个。
		const once = ok(`[data-bn="page"]::before{content:"";position:absolute;inset:0}`).css;
		const twice = ok(once).css;
		expect(twice).toBe(once);
		expect(ok(twice).css).toBe(once);
		expect(countOf(once, "z-index:-1")).toBe(1);
		expect(countOf(once, "pointer-events:none")).toBe(1);
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

describe("hook 白名单不许绕开", () => {
	/**
	 * `isAllowedSelector` 逐个节点问「你是不是白名单里的件」,却从没问过
	 * 「这里到底有没有 hook」—— 一支只由伪类/伪元素组成的选择器于是全票通过,
	 * 而它命中的是**页面上每一个元素**。整个 hook 契约就这么绕开了。
	 */
	it("光秃秃的伪类 → 整条丢弃", () => {
		const { css, warnings } = ok(`:hover { background: #000; }`);
		expect(css).toBe("");
		expect(warnings.join()).toContain("不在 hook 白名单");
	});

	it("光秃秃的伪元素 → 整条丢弃", () => {
		const { css } = ok(`::before { content: ""; inset: 0; }`);
		expect(css).toBe("");
	});

	it("挂了 hook 的照旧放行", () => {
		const { css } = ok(`[data-bn="glass"]:hover { background: #000; }`);
		expect(css).toContain('[data-bn="glass"]:hover');
	});
});

describe("!important 一律摘掉", () => {
	/**
	 * 装饰层那两句硬规矩(pointer-events:none / z-index:-1)是**追加**在声明块尾部的,
	 * 靠「后到者赢」压过皮肤自己写的值 —— 而 `!important` 不吃这一套。
	 *
	 * 实测(2026-08-19 审计):`z-index:99 !important` 原样留在产物里,后面那句
	 * `z-index:-1` 完全无效,装饰照旧糊在内容之上(正是「樱墨」那次的症状)。
	 * 皮肤 CSS 本来就是 author 层、本来就生效,`!important` 在这里没有正当用途。
	 */
	it("摘掉之后追加的硬规矩才压得住", () => {
		const { css, warnings } = ok(
			`[data-bn="glass"]::before { content: ""; position: absolute; z-index: 99 !important; }`,
		);
		expect(css).not.toContain("!important");
		// 摘了 `!important` 之后它就是一条普通的 z-index,跟着被硬规矩摘掉。
		expect(css).not.toContain("z-index:99");
		expect(countOf(css, "z-index:")).toBe(1);
		expect(warnings.join()).toContain("important");
	});

	it("宿主身上的也摘 —— 它能压过工具类,那是布局在打架", () => {
		const { css } = ok(`[data-bn~="btn"] { border-radius: 4px !important; }`);
		expect(css).toContain("border-radius:4px");
		expect(css).not.toContain("!important");
	});
});

describe("宿主不许隐身 —— 补漏", () => {
	/**
	 * 下限只读了 filter 里**第一个** opacity(),第二个原样穿过。
	 * `filter:opacity(1) opacity(0)` 实测放行(2026-08-19 审计) —— 两个函数相乘,
	 * 结果还是 0。
	 */
	it("filter 里第二个 opacity() 同样算数", () => {
		const { warnings } = ok(`[data-bn="glass"] { filter: opacity(1) opacity(0); }`);
		expect(warnings.join()).toContain("opacity");
	});

	it("多个 opacity() 都合格才放行", () => {
		const { css, warnings } = ok(`[data-bn="glass"] { filter: opacity(0.9) opacity(0.8); }`);
		expect(css).toContain("filter:opacity(0.9) opacity(0.8)");
		expect(warnings).toEqual([]);
	});
});
