/**
 * 卡片皮肤 CSS 清洗层(ADR-0014 决策 13,2026-09-13「开放重写」那一版)。
 *
 * 核心与 dashboard 皮肤同一份实现(`skins/scoped-css.ts`),所以这一组**只钉卡片这档
 * 的参数**:属性走**黑名单**、选择器**自由**但每条都归一到 `self` / `frame` 起头、
 * 挂点仍按块对表、`@keyframes` 不放行、上限是 `CARD_SKIN_LIMITS.maxCssBytes`。
 *
 * 判据是「**把实现改坏能红**」:选择器归一那条不是断言某个字符串出现,而是把产物重新
 * 解析一遍、逐条问它的第一个节点是不是挂点 —— 归一化拆掉就会红。
 */

import { CARD_SKIN_LIMITS } from "@bilibili-notify/internal";
import type { CssNode } from "css-tree";
import { parse } from "css-tree/dist/csstree.esm";
import { describe, expect, it } from "vite-plus/test";
import { sanitizeCardBlockCss, sanitizeCardFrameCss } from "../css-sanitizer.js";

function ok(css: string, builtin?: string, kind: "live" | "sc" = "live") {
	const res = sanitizeCardBlockCss(css, { kind, builtin });
	expect(res.ok, res.ok ? "" : res.errors.join(" / ")).toBe(true);
	if (!res.ok) throw new Error("unreachable");
	return { css: res.css, warnings: res.warnings };
}

function okFrame(css: string) {
	const res = sanitizeCardFrameCss(css);
	expect(res.ok, res.ok ? "" : res.errors.join(" / ")).toBe(true);
	if (!res.ok) throw new Error("unreachable");
	return { css: res.css, warnings: res.warnings };
}

/**
 * 产物里每条复杂选择器的**第一个节点**,用 css-tree 把产物重新解析出来判 —— 不是
 * `css.startsWith('[data-bn="self"]')`。
 *
 * 字符串前缀会在两头说谎:`[data-bn="self"]x` 也以那串起头(但它是一个复合段,不是
 * 后代前缀),而逗号列表里第二支之后的开头根本不在字符串头上。归一化那一步一旦被
 * 拆掉,这个函数返回的就是 `ClassSelector` / `TypeSelector`,断言当场红。
 */
function selectorLeads(css: string): string[] {
	const ast = parse(css, { parseCustomProperty: false });
	if (ast.type !== "StyleSheet") throw new Error("产物顶层不是样式表");
	const leads: string[] = [];
	ast.children.forEach((node: CssNode) => {
		if (node.type !== "Rule" || node.prelude.type !== "SelectorList") return;
		node.prelude.children.forEach((sel: CssNode) => {
			if (sel.type !== "Selector") return;
			const first = sel.children.first;
			if (first === null) {
				leads.push("<空选择器>");
				return;
			}
			if (
				first.type === "AttributeSelector" &&
				first.name.name === "data-bn" &&
				first.matcher === "=" &&
				first.value?.type === "String"
			) {
				leads.push(`[data-bn="${first.value.value}"]`);
				return;
			}
			leads.push(first.type);
		});
	});
	return leads;
}

describe("选择器自由,但每条都归一到挂点起头", () => {
	/**
	 * 「改坏能红」的那一条:归一化拆掉,下面四条里就会冒出 `ClassSelector` /
	 * `TypeSelector` 的开头。用 AST 判而不是 `startsWith`,理由见 {@link selectorLeads}。
	 */
	it("class / 标签 / 挂点 / 组合器打头的,清洗后一律以 self 起头", () => {
		const { css } = ok(
			`.hud > span:first-child{color:red}
			div span em{color:red}
			[data-bn="avatar"] img{border-radius:999px}
			[data-bn="self"]:hover{color:red}`,
			"header",
		);
		expect(selectorLeads(css)).toEqual([
			'[data-bn="self"]',
			'[data-bn="self"]',
			'[data-bn="self"]',
			'[data-bn="self"]',
		]);
		// 补的是**后代组合器**,原来那串一个件都不动(css-tree 的 generate 不在 `>`
		// 两边留空格,所以这里写的是它的规范写法,不是作者敲的那份)。
		expect(css).toContain('[data-bn="self"] .hud>span:first-child{color:red}');
		expect(css).toContain('[data-bn="self"] div span em{color:red}');
	});

	it("已经以 self 起头的一个字都不动 —— 伪元素 / 伪类照旧", () => {
		const { css, warnings } = ok(
			'[data-bn="self"]::before{content:"";border-width:1px}[data-bn="self"]:hover{color:#fff}',
			"header",
		);
		expect(css).toContain('[data-bn="self"]::before{content:"";border-width:1px}');
		expect(css).toContain('[data-bn="self"]:hover{color:#fff}');
		expect(warnings).toEqual([]);
	});

	it('挂点起头的补成后代 —— [data-bn="avatar"] img → self 在前', () => {
		const { css } = ok('[data-bn="avatar"] img{border-radius:999px}', "header");
		expect(css).toBe('[data-bn="self"] [data-bn="avatar"] img{border-radius:999px}');
	});

	it("逗号列表每一支各自归一,不是整条一起判", () => {
		const { css } = ok('[data-bn="self"]:hover, .x{color:red}', "header");
		expect(selectorLeads(css)).toEqual(['[data-bn="self"]', '[data-bn="self"]']);
		expect(css).toContain('[data-bn="self"]:hover');
		expect(css).toContain('[data-bn="self"] .x');
	});

	it("class / 标签 / 属性 / :is / :has / :not / 伪元素混着写都放行", () => {
		const { css, warnings } = ok(
			`.hud[data-kind="a"]:not(.off) > span::after{content:"";color:red}
			:is(b, em) span{color:red}
			.row:has(> img){border-width:1px}`,
			"header",
		);
		expect(selectorLeads(css)).toEqual([
			'[data-bn="self"]',
			'[data-bn="self"]',
			'[data-bn="self"]',
		]);
		expect(css).toContain(":not(.off)");
		expect(css).toContain(":is(b,em)");
		expect(css).toContain(":has(");
		expect(warnings).toEqual([]);
	});

	it('产物里的挂点只有 [data-bn="…"] 一种写法 —— 渲染器的翻译靠它', () => {
		const { css } = ok('[data-bn="avatar"]{border-radius:999px}', "header");
		expect(css).toContain('[data-bn="avatar"]');
		expect(css).not.toContain("data-bn~=");
		expect(css).not.toContain("data-bn ");
	});
});

describe("挂点仍按块对表(自由的是别的段,不是挂点)", () => {
	it("self 与该块的内部挂点放行,产物保留 hook 形式(翻译是渲染器的事)", () => {
		const { css, warnings } = ok(
			`[data-bn="self"]{padding-top:12px;border-radius:8px}
			[data-bn="self"] [data-bn="name"]{color:#fb7299}`,
			"header",
		);
		expect(css).toContain('[data-bn="self"]{padding-top:12px;border-radius:8px}');
		expect(css).toContain('[data-bn="self"] [data-bn="name"]');
		expect(warnings).toEqual([]);
	});

	/**
	 * 挂点是**按块**分的,不是一张全卡通票 —— 更不是全仓通票。两个例子都得有:
	 *
	 * - `popularity` 是**同一张直播卡**里「直播数据」块的挂点。写进「主播信息」块必须
	 *   丢掉 —— 只按卡种取并集的写法在这一条上才会露馅。
	 * - `price` 是**别的卡种**(SC 卡金额块)的挂点,连卡都不对。
	 *
	 * 放行任何一个,挂点契约就从「这个块内部有什么」松成「别处所有挂点」,渲染器一
	 * 翻译,一个块的 CSS 就摸得到另一个块。
	 */
	it("同卡别的块的挂点整条丢弃并告警", () => {
		const { css, warnings } = ok(
			`[data-bn="popularity"]{color:red}
			[data-bn="avatar"]{border-width:2px}`,
			"header",
		);
		expect(css).not.toContain("popularity");
		expect(css).toContain("border-width:2px");
		expect(warnings.join()).toContain("popularity");
	});

	it("别的卡种的挂点整条丢弃并告警", () => {
		const { css, warnings } = ok(
			`[data-bn="price"]{color:red}
			[data-bn="avatar"]{border-width:2px}`,
			"header",
		);
		expect(css).not.toContain("price");
		expect(css).toContain("border-width:2px");
		expect(warnings.join()).toContain("price");
	});

	it("藏在 :is() / :has() 里的越界挂点一样对表", () => {
		const { css, warnings } = ok(
			`.row:has([data-bn="price"]){color:red}
			.row:is([data-bn="avatar"]){border-width:2px}`,
			"header",
		);
		expect(css).not.toContain("price");
		expect(css).toContain("border-width:2px");
		expect(warnings.join()).toContain("price");
	});

	it("同一个挂点名换个块就该放行 —— sc/amount 认识 price", () => {
		const { css, warnings } = ok(`[data-bn="price"]{color:red}`, "amount", "sc");
		expect(css).toBe('[data-bn="self"] [data-bn="price"]{color:red}');
		expect(warnings).toEqual([]);
	});

	it("自定义块(没有 builtin)只有 self —— 内置块的挂点一个都不认", () => {
		const { css, warnings } = ok(
			`[data-bn="self"]{color:#111}
			[data-bn="avatar"]{border-radius:999px}`,
		);
		expect(css).toBe('[data-bn="self"]{color:#111}');
		expect(warnings.join()).toContain("avatar");
	});

	it("认不出的块名不静默 —— 只按 self 洗,并且说出来", () => {
		const { css, warnings } = ok(`[data-bn="self"]{color:#111}`, "no-such-block");
		expect(css).toContain('[data-bn="self"]');
		expect(warnings[0]).toContain("no-such-block");
	});

	/**
	 * 挂点是**精确等号**这一种写法。`~=` / `^=` / `*=` 都能一把网住一串挂点
	 * (`[data-bn~="a"]` 命中 `"pics pic"` 那种多挂点容器,`^=` 更是前缀通配),
	 * 放行的话按块对表那道闸就等于没有。
	 */
	it("挂点只认精确等号:~= / ^= / *= / 裸 [data-bn] 一律整条丢弃", () => {
		for (const evil of [
			'[data-bn~="avatar"]{color:red}',
			'[data-bn^="av"]{color:red}',
			'[data-bn*="ava"]{color:red}',
			"[data-bn]{color:red}",
			'.x:has([data-bn~="avatar"]){color:red}',
		]) {
			const { css, warnings } = ok(evil, "header");
			expect(css, evil).toBe("");
			expect(warnings.join(), evil).toContain("data-bn");
		}
	});
});

describe("卡片这档与 dashboard 刻意不同的地方", () => {
	/**
	 * 卡片是**截图**,静态的 —— 动画一帧都画不出来,只拖慢渲染(ADR-0014 决策 13)。
	 * dashboard 那边 `skin-` 前缀的 @keyframes 是放行的,所以这条盯的正是「参数没传对
	 * 就会跟着 dashboard 一起放行」。
	 */
	it("@keyframes 整段丢弃 —— 名字合规也不行", () => {
		const { css, warnings } = ok(
			`@keyframes skin-float{from{transform:translateY(0)}to{transform:translateY(-8px)}}
			[data-bn="self"]{border-width:1px}`,
			"header",
		);
		expect(css).not.toContain("@keyframes");
		expect(css).not.toContain("skin-float");
		expect(css).toContain("border-width:1px");
		expect(warnings.join()).toContain("@keyframes");
	});

	it("@import 丢弃 —— 外联取网面任何情况下不放行", () => {
		const { css, warnings } = ok(
			`@import "https://evil.example/x.css";
			[data-bn="self"]{border-width:1px}`,
			"header",
		);
		expect(css).not.toContain("@import");
		expect(css).not.toContain("evil.example");
		expect(warnings.join()).toContain("@import");
	});
});

describe("属性:黑名单只列执行面,别的随便写", () => {
	it("原来白名单外、现在放行的那一批", () => {
		const { css, warnings } = ok(
			`[data-bn="self"]{
				mask-image:linear-gradient(#000,transparent);
				border-image:linear-gradient(#000,#fff) 1;
				mix-blend-mode:overlay;
				font-family:"Noto Sans SC",sans-serif;
				pointer-events:none;
				cursor:pointer;
				user-select:none;
				grid-template-columns:1fr 2fr;
				clip-path:polygon(0 0,100% 0,100% 80%,0 100%);
			}`,
			"header",
		);
		for (const p of [
			"mask-image:",
			"border-image:",
			"mix-blend-mode:overlay",
			"font-family:",
			"pointer-events:none",
			"cursor:pointer",
			"user-select:none",
			"grid-template-columns:1fr 2fr",
			"clip-path:polygon(",
		]) {
			expect(css, p).toContain(p);
		}
		expect(warnings).toEqual([]);
	});

	/**
	 * 资产口子(ADR-0014 决策 13 的 🔗):包内资产由渲染器注成 `--bn-asset-<名>`,
	 * 作者在 CSS 里 `var()` 自己叠。`url()` 照旧一律拒 —— 所以 `var()` 必须放行,
	 * 不然这条路整个不通。
	 */
	it("var(--bn-asset-*) 放行,和渐变叠在一起也放行", () => {
		const { css, warnings } = ok(
			'[data-bn="self"]{background:var(--bn-asset-hud),linear-gradient(#000,#fff)}',
			"header",
		);
		expect(css).toContain("var(--bn-asset-hud)");
		expect(css).toContain("linear-gradient(");
		expect(warnings).toEqual([]);
	});

	it("执行面黑名单:behavior / -moz-binding 逐条丢弃", () => {
		const { css, warnings } = ok(
			`[data-bn="self"]{behavior:url(x.htc);-moz-binding:url(x.xml);binding:url(x.xml);-ms-behavior:url(x.htc);color:#fff}`,
			"header",
		);
		expect(css).toBe('[data-bn="self"]{color:#fff}');
		expect(warnings.join()).toContain("behavior");
		expect(warnings.join()).toContain("-moz-binding");
	});

	it("值里的 url( / image-set( → 该声明丢弃,别的声明照留", () => {
		const { css, warnings } = ok(
			`[data-bn="self"]{
				background:url(https://evil.example/x.png);
				background-image:image-set("x.png" 1x);
				border-color:#123456;
			}`,
			"header",
		);
		expect(css).not.toContain("url(");
		expect(css).not.toContain("image-set");
		expect(css).toContain("border-color:#123456");
		expect(warnings).toHaveLength(2);
	});

	it("转义写的 url( 一样拦住 —— tokenizer 先解转义再判 ident", () => {
		const { css, warnings } = ok(
			`[data-bn="self"]{background:\\75 rl(https://evil.example/x.png)}`,
			"header",
		);
		expect(css).not.toContain("75 rl");
		expect(warnings.join()).toContain("转义");
	});

	it("expression( 丢弃 —— 老 IE 的执行面,值级过滤一条不松", () => {
		const { css, warnings } = ok(
			'[data-bn="self"]{width:expression(alert(1));border-width:1px}',
			"header",
		);
		expect(css).toBe('[data-bn="self"]{border-width:1px}');
		expect(warnings.join()).toContain("expression");
	});
});

describe("position 的值域", () => {
	it("伪元素放行,且值域限 static/relative/absolute", () => {
		const { css, warnings } = ok(
			`[data-bn="self"]::before{content:"";position:absolute;inset:0}
			[data-bn="self"]::after{content:"";position:fixed}`,
			"header",
		);
		expect(css).toContain("position:absolute");
		expect(css).not.toContain("position:fixed");
		expect(warnings).toHaveLength(1);
	});

	it("宿主(非伪元素)写 position 也放行 —— 与 dashboard 相反,卡片没有布局可被顶掉", () => {
		const { css, warnings } = ok(`[data-bn="self"]{position:relative;border-width:1px}`, "header");
		expect(css).toBe('[data-bn="self"]{position:relative;border-width:1px}');
		expect(warnings).toEqual([]);
	});

	it("fixed / sticky 仍然拒 —— 黑名单放开的是属性,不是这条值域", () => {
		const { css, warnings } = ok(
			'[data-bn="self"]{position:fixed}[data-bn="avatar"]{position:sticky}[data-bn="name"]{position:absolute;top:0}',
			"header",
		);
		expect(css).not.toContain("fixed");
		expect(css).not.toContain("sticky");
		expect(css).toContain("position:absolute;top:0");
		expect(warnings).toHaveLength(2);
	});
});

describe("根块(外框)只认两个挂点", () => {
	it("frame / glass 放行且不加前缀", () => {
		const { css, warnings } = okFrame(
			'[data-bn="frame"]{border-radius:16px}[data-bn="glass"]{background:#fff}',
		);
		expect(css).toContain('[data-bn="frame"]{border-radius:16px}');
		expect(css).toContain('[data-bn="glass"]{background:#fff}');
		expect(selectorLeads(css)).toEqual(['[data-bn="frame"]', '[data-bn="glass"]']);
		expect(warnings).toEqual([]);
	});

	it("根块缺前缀的补 frame,不是 self", () => {
		const { css } = okFrame(".x{color:red}");
		expect(css).toBe('[data-bn="frame"] .x{color:red}');
	});

	it("self 与块的内部挂点在根块里不认识 —— 根块不是块", () => {
		const { css, warnings } = okFrame(
			'[data-bn="self"]{color:red}[data-bn="avatar"]{color:red}[data-bn="glass"]{border-width:1px}',
		);
		expect(css).toBe('[data-bn="glass"]{border-width:1px}');
		expect(warnings).toHaveLength(2);
	});
});

describe("体积闸", () => {
	it("超过 maxCssBytes → error", () => {
		const big = '[data-bn="self"]{border-width:1px}'.repeat(600);
		expect(Buffer.byteLength(big, "utf8")).toBeGreaterThan(CARD_SKIN_LIMITS.maxCssBytes);
		expect(sanitizeCardBlockCss(big, { kind: "live", builtin: "header" }).ok).toBe(false);
		expect(sanitizeCardFrameCss(big).ok).toBe(false);
	});

	it("上限按 UTF-8 字节算 —— 中文注释不该按一个字一格算", () => {
		const big = `/* ${"皮肤注释".repeat(1500)} */\n[data-bn="self"]{color:red}`;
		expect(big.length).toBeLessThan(CARD_SKIN_LIMITS.maxCssBytes);
		expect(Buffer.byteLength(big, "utf8")).toBeGreaterThan(CARD_SKIN_LIMITS.maxCssBytes);
		expect(sanitizeCardBlockCss(big, { kind: "live", builtin: "header" }).ok).toBe(false);
	});

	it("空串 / 全被丢弃 → ok 且产物为空串", () => {
		expect(ok("", "header").css).toBe("");
		expect(ok('[data-bn="price"]{color:red}', "header").css).toBe("");
	});
});

describe("自由选择器的两条补丁(主会话审 diff 加的)", () => {
	it("起头挂点后面紧跟兄弟组合器 → 整条丢(会选到别的块)", () => {
		for (const sel of ['[data-bn="self"] ~ .x', '[data-bn="self"] + div']) {
			const r = sanitizeCardBlockCss(`${sel}{color:red}`, { kind: "live", builtin: "header" });
			expect(r.ok).toBe(true);
			if (r.ok) {
				expect(r.css).toBe("");
				expect(r.warnings.join()).toContain("兄弟组合器");
			}
		}
		// 后代 / 子代照旧;挂点不在头上的兄弟关系也照旧(那是块内部的兄弟)。
		for (const sel of ['[data-bn="self"] > .x', '[data-bn="self"] .a ~ .b', ".a + .b"]) {
			const r = sanitizeCardBlockCss(`${sel}{color:red}`, { kind: "live", builtin: "header" });
			expect(r.ok && r.css !== "").toBe(true);
		}
	});

	it("content 放行字符串字面量与 normal,仍拒 attr() / url()", () => {
		const ok = sanitizeCardBlockCss(
			'[data-bn="self"]::before{content:"▶ LIVE"}[data-bn="self"]::after{content:normal}',
			{ kind: "live" },
		);
		expect(ok.ok && ok.css).toContain('content:"▶ LIVE"');
		expect(ok.ok && ok.css).toContain("content:normal");
		const bad = sanitizeCardBlockCss(
			'[data-bn="self"]::before{content:attr(data-x)}[data-bn="self"]::after{content:url(x)}',
			{ kind: "live" },
		);
		expect(bad.ok && bad.css).toBe("");
	});
});
