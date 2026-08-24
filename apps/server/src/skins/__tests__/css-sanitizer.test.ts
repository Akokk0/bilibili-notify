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

import {
	SKIN_CSS_EXACT_PROPS,
	SKIN_CSS_PROP_NOTES,
	SKIN_CSS_PROP_PREFIXES,
} from "@bilibili-notify/contract";
import { describe, expect, it } from "vite-plus/test";
import { MAX_SKIN_CSS_BYTES, sanitizeSkinCss, stripDecorationResidue } from "../css-sanitizer.js";

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

	/**
	 * `var(--bn-tint)` 与 `color-mix()` 必须活着出来。
	 *
	 * 词表的 badge / chip-active 两档明写着「描边颜色写 `var(--bn-tint)`」——
	 * 徽章与胶囊各自把自己那个语义色露在这个变量里,皮肤顺着它描边,才不会把
	 * 「直播是粉的、动态是蓝的」和四档日志等级罩成同一个色(2026-08-24 真机翻的车)。
	 *
	 * 这条测试挡的是**静默失效**:清洗层若丢掉这种写法,皮肤照样存得下、构建照样绿,
	 * 只有真机上那圈描边会变成默认色 —— 也就是那个车再翻一次。
	 */
	it("var() 与 color-mix() 放行 —— 词表教皮肤用它们顺着语义色描边", () => {
		const { css, warnings } = ok(
			`[data-bn="badge"] {
				outline: 2px solid var(--bn-tint, #8E6BFF);
				outline-offset: -2px;
				box-shadow: 2px 2px 0 0 color-mix(in srgb, var(--bn-tint, #8E6BFF) 45%, transparent);
			}`,
		);
		expect(css).toContain("var(--bn-tint");
		expect(css).toContain("color-mix(");
		expect(warnings).toHaveLength(0);
	});

	/**
	 * 叠挂点的写法必须活着出来 —— `SKIN_STATE_NOTES` 就是教皮肤这么写的。
	 *
	 * 挂点是多挂点模式(选中那颗同时挂着 chip 与 chip-active),所以给基础词写
	 * `:hover` 会连选中那颗一起打,而 `:not()` 在这一层是丢弃的(下一条钉住)。
	 * 唯一的出路就是把两个词叠进同一段选择器 —— 它一旦被丢,主人会看到的正是
	 * 2026-08-24 那个症状:鼠标指上去,选中那段塌回轨道里。
	 */
	it("同一段里叠两个挂点放行 —— 这是「只管选中那颗」的唯一写法", () => {
		const { css, warnings } = ok('[data-bn="chip"][data-bn="chip-active"]:hover{background:#fff}');
		expect(css).toContain('[data-bn="chip"][data-bn="chip-active"]:hover');
		expect(warnings).toHaveLength(0);
	});

	it(":not() 丢弃 —— 所以「除了选中那颗」写不出来,只能靠叠挂点", () => {
		// 这条不是遗憾,是现状的记录:提示词里那句「:not() 会被丢弃」得有东西钉着,
		// 否则哪天清洗层放行了,文档就开始骗人。
		const { css, warnings } = ok('[data-bn="chip"]:not([data-bn="chip-active"]):hover{color:red}');
		expect(css).toBe("");
		expect(warnings).toHaveLength(1);
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
 * 卡面高光那类覆盖层(`::before` + `position:absolute` + `inset:0` + 渐变)要能安全
 * 存在,靠两句硬规矩:`pointer-events:none` + `z-index:-1`。这两句**不归清洗层补**——
 * 补进产物,存盘/导出的 CSS 里就躺着一句白名单外的声明,下一轮清洗(编辑器保存、
 * 导出 zip 再导入)必然对着自己上一轮的笔迹刷「不在白名单,已丢弃」(2026-08-25
 * 主人导入自家导出的包,一口气 12 条)。
 *
 * 硬规矩由**注入层**独挑(web `decorationGuardCss`,带 !important,连清洗层从未
 * 见过的存量皮肤也压得住)。清洗层对 `pointer-events` 只有一件事:照实报警丢弃 ——
 * 存盘产物里**永远不出现**这个词,警告于是永远指向作者真写了的东西。
 */
describe("伪元素守卫不归清洗层", () => {
	it("清洗产物不含 pointer-events —— 硬规矩在注入层,不在盘里", () => {
		const { css } = ok(`[data-bn="glass"]::before{content:"";position:absolute;inset:0}`);
		expect(css).not.toContain("pointer-events");
	});

	it("round-trip 零警告且逐字稳定:产物再洗一遍,没有可举报的东西", () => {
		const first = ok(`[data-bn="page"]::before{content:"";position:absolute;inset:0}`);
		const second = ok(first.css);
		expect(second.warnings).toEqual([]);
		expect(second.css).toBe(first.css);
	});

	it("装饰规则写 pointer-events —— 不管什么值,一律警告丢弃", () => {
		for (const v of ["none", "auto"]) {
			const { css, warnings } = ok(
				`[data-bn="page"]::before{content:"";position:absolute;inset:0;pointer-events:${v}}`,
			);
			expect(warnings.some((w) => w.includes("pointer-events"))).toBe(true);
			expect(css).not.toContain("pointer-events");
		}
	});

	it("宿主(非伪元素)写 pointer-events 同样警告 —— 那是能把按钮点死的欺骗面", () => {
		const { warnings } = ok(`[data-bn="btn"]{pointer-events:none}`);
		expect(warnings.some((w) => w.includes("pointer-events"))).toBe(true);
	});

	it("装饰里皮肤写的 z-index 放行保留 —— 白名单内;压不压得住由注入层的 !important 说了算", () => {
		const { css, warnings } = ok(
			`[data-bn="page"]::before{content:"";position:absolute;inset:0;z-index:5}`,
		);
		expect(warnings).toEqual([]);
		expect(css).toContain("z-index:5");
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

	/**
	 * keyframe 块被整体按「伪元素」记账(`{ pseudo: true }`),好让装饰层的动画照旧
	 * 能动 position。可动画是**挂得到宿主身上**的:一句 `animation:skin-x 1s` 写在
	 * `[data-bn="header"]` 上,那段 keyframes 里的 position 就落在顶栏本人身上,
	 * 而动画来源的声明优先级**高于**普通作者声明 —— `position:sticky` 照样被顶掉,
	 * 正是这道闸要拦的「顶栏散架」。opacity 那两条早就为此把 keyframes 排除在
	 * 「装饰」之外了,position 这条漏了。
	 */
	it("keyframes 里的 position 一样拒收 —— 那段动画挂得到宿主身上", () => {
		const { css, warnings } = ok(
			`@keyframes skin-x{0%{position:relative}100%{position:relative}}` +
				`[data-bn="header"]{animation:skin-x 1s infinite}`,
		);
		expect(css).not.toContain("position");
		expect(warnings.some((w) => w.includes("position"))).toBe(true);
		// 动画本身不是罪 —— 拒的只是那一句 position。
		expect(css).toContain("animation:skin-x 1s infinite");
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

	/**
	 * 上面那三条只验了**没有** hook 的形状,于是「至少有一个 hook」这个判据看着够用。
	 * 可 hook 管的是它自己那一段 —— 后代组合器一跨,后面那段就自由了:
	 * `[data-bn="page"] :hover` 挂着 hook、每个件都在白名单里、`hooks > 0` 通过,
	 * 而 `page` 映射到 `body`,这条选中的是**页面上每一个元素**,跟裸 `:hover` 一模
	 * 一样。判据得改成「每一段都得有 hook」。
	 */
	it("组合器后面那段光秃秃 → 整条丢弃,别让 hook 只管住第一段", () => {
		for (const evil of [
			`[data-bn="page"] :hover { background: #f00; }`,
			`[data-bn="page"] :nth-child(n) { background: #f00; }`,
			`[data-bn="page"]>:hover { background: #f00; }`,
			`[data-bn="page"] ::before { content: ""; }`,
		]) {
			const { css, warnings } = ok(evil);
			expect(css).toBe("");
			expect(warnings.join()).toContain("不在 hook 白名单");
		}
	});

	it("每段都挂着 hook 的后代选择器照旧放行", () => {
		const { css } = ok(`[data-bn="glass"] [data-bn="btn"]:hover { background: #000; }`);
		expect(css).toContain('[data-bn="btn"]');
	});
});

describe("!important 一律摘掉", () => {
	/**
	 * 注入层的硬规矩(`z-index:-1!important`)要压得住皮肤,前提是皮肤自己**没有**
	 * `!important` —— 同为 important 时层序反转,author 层反而赢(2026-08-19 审计
	 * 实测:`z-index:99 !important` 让守卫完全失效,装饰糊在内容之上,「樱墨」的
	 * 症状)。皮肤 CSS 本来就是 author 层、本来就生效,`!important` 没有正当用途。
	 */
	it("摘成普通声明 —— 值保留,压它的是注入层的 !important", () => {
		const { css, warnings } = ok(
			`[data-bn="glass"]::before { content: ""; position: absolute; z-index: 99 !important; }`,
		);
		expect(css).not.toContain("!important");
		// 值本身在白名单内,保留;装饰上它赢不了注入层那句 important。
		expect(css).toContain("z-index:99");
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

/**
 * 上限这道闸只量了**输入**,而清洗器自己会往产物里加东西:每条装饰规则都补上
 * 「压在内容之下」那两句。存盘的又是**清洗后的产物**(这一层的口径),于是它下一次
 * 提交时量的是长出来的那份 —— 一套写得够满的皮肤能存进去,却再也改不动、
 * 连自己导出的 zip 都传不回来。
 *
 * 判据因此得落在产物上:**存得进去的,一定还能再存一次。**
 */
describe("上限量的是存盘那份", () => {
	/** 装饰规则,每条 44 字节。 */
	function decorations(count: number): string {
		return Array.from(
			{ length: count },
			(_, i) => `[data-bn="glass"]::before{content:"";inset:${i}px}`,
		).join("");
	}

	it("清洗不再长胖 —— 产物字节数不超过原文(硬规矩不落盘之后,没有追加项)", () => {
		// 曾经这段输入会被清洗**撑爆**上限:每条装饰规则被追加 pointer-events/z-index
		// 两句,1200 条 × ~30 字节一路胀过 64K,于是需要「清洗后超了」这条独立报错。
		// 硬规矩挪去注入层之后清洗只删不加,这个膨胀面整个消失。
		const input = decorations(1200);
		expect(Buffer.byteLength(input, "utf8")).toBeLessThan(MAX_SKIN_CSS_BYTES);
		const res = sanitizeSkinCss(input);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(Buffer.byteLength(res.css, "utf8")).toBeLessThanOrEqual(
			Buffer.byteLength(input, "utf8"),
		);
	});

	it("放行的产物再清洗一遍还是原样 —— 存进去的就一定还能再存一次", () => {
		const first = sanitizeSkinCss(decorations(400));
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(Buffer.byteLength(first.css, "utf8")).toBeLessThanOrEqual(MAX_SKIN_CSS_BYTES);
		const second = sanitizeSkinCss(first.css);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.css).toBe(first.css);
	});
});

/**
 * 白名单是**放行的那一份**,提示词是**教 AI 的那一份** —— 从前后者是手抄的一小半,
 * 靠一个「等」字兜住剩下的,于是 transform-origin、rotate、top/left、content 这些
 * 收得进去的属性,两条造皮肤的路谁都没教过。
 *
 * 现在提示词从名单生成,这一组盯着别再退回手写:清洗层真放行的,提示词必须讲得出。
 */
describe("提示词与白名单同源", () => {
	it("名单里每一个属性都真的放行", () => {
		for (const prop of SKIN_CSS_EXACT_PROPS) {
			// position 有自己的值域闸,给它一个合法值;其余给个能过语法的值即可。
			const value = prop === "position" ? "relative" : prop === "content" ? '""' : "inherit";
			const res = ok(`[data-bn~="glass"]::after { ${prop}: ${value} }`);
			expect(res.css, prop).toContain(prop);
		}
	});

	it("提示词把名单逐条讲了出来,不再是抄一小半加个「等」", () => {
		for (const prop of SKIN_CSS_EXACT_PROPS) {
			expect(SKIN_CSS_PROP_NOTES, prop).toContain(prop);
		}
		for (const prefix of SKIN_CSS_PROP_PREFIXES) {
			expect(SKIN_CSS_PROP_NOTES, prefix).toContain(`${prefix}*`);
		}
	});

	it("提示词点名的三个「会被丢弃」的属性,清洗层确实丢", () => {
		for (const prop of ["display", "pointer-events", "visibility"]) {
			expect(SKIN_CSS_PROP_NOTES).toContain(prop);
			const res = ok(`[data-bn~="glass"] { ${prop}: none }`);
			expect(res.css, prop).not.toContain(prop);
		}
	});
});

/**
 * 存量烙印的清洁工。v0.7.0 及之前清洗层把两句硬规矩烙进了存盘产物;它们如今由
 * 注入层独挑,盘里那批要在读盘时摘掉 —— 否则下一次保存,清洗层会对着旧烙印刷
 * 「不在白名单,已丢弃」,主人以为自己的皮肤写坏了。
 */
describe("stripDecorationResidue", () => {
	it("摘掉装饰规则里的 pointer-events:none 与 z-index:-1", () => {
		const out = stripDecorationResidue(
			'[data-bn="page"]::before{content:"";inset:0;pointer-events:none;z-index:-1}',
		);
		expect(out).not.toContain("pointer-events");
		expect(out).not.toContain("z-index");
		expect(out).toContain("inset:0");
	});

	it("只认烙印的签名 —— 作者写的 z-index:5 一个字不动", () => {
		const css = '[data-bn="page"]::before{content:"";z-index:5}';
		expect(stripDecorationResidue(css)).toBe(css);
	});

	it("宿主规则不碰 —— 烙印只落过装饰", () => {
		// 宿主上的 z-index:-1 是作者自己的选择(白名单内),不是我们的笔迹。
		const css = '[data-bn="badge"]{z-index:-1}';
		expect(stripDecorationResidue(css)).toBe(css);
	});

	it("没有烙印就原样返回 —— 不重排、不重新序列化别人的字", () => {
		const css = '[data-bn="btn"] { background: #123456; }';
		expect(stripDecorationResidue(css)).toBe(css);
	});

	it("解析不动的输入原样返回 —— 这是清洁工,不是守门员", () => {
		const css = "not-css at all {{{";
		expect(stripDecorationResidue(css)).toBe(css);
	});
});
