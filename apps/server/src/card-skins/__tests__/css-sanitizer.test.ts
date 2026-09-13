/**
 * 卡片皮肤 CSS 清洗层(ADR-0014 决策 13)。
 *
 * 核心与 dashboard 皮肤同一份实现(`skins/scoped-css.ts`),所以这一组**只钉卡片这档
 * 的参数**:挂点集合按块收窄、`@keyframes` 不放行、上限是 `CARD_SKIN_LIMITS.maxCssBytes`。
 * 通用红线(逐段挂 hook、属性白名单、转义写法、`!important`)那边已经钉死,这里挑
 * 「参数一改就会松」的几条各留一个哨兵。
 */

import { CARD_SKIN_LIMITS } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { sanitizeCardBlockCss, sanitizeCardFrameCss } from "../css-sanitizer.js";

function ok(css: string, builtin?: string, kind: "live" | "sc" = "live") {
	const res = sanitizeCardBlockCss(css, { kind, builtin });
	expect(res.ok).toBe(true);
	if (!res.ok) throw new Error("unreachable");
	return { css: res.css, warnings: res.warnings };
}

function okFrame(css: string) {
	const res = sanitizeCardFrameCss(css);
	expect(res.ok).toBe(true);
	if (!res.ok) throw new Error("unreachable");
	return { css: res.css, warnings: res.warnings };
}

describe("挂点按块收窄", () => {
	it("self 与该块的内部挂点放行,产物保留 hook 形式(翻译是渲染器的事)", () => {
		const { css, warnings } = ok(
			`[data-bn="self"]{padding-top:12px;border-radius:8px}
			[data-bn="avatar"]{border-radius:999px}
			[data-bn="self"] [data-bn="name"]{color:#fb7299}`,
			"header",
		);
		expect(css).toContain('[data-bn="self"]');
		expect(css).toContain('[data-bn="avatar"]{border-radius:999px}');
		expect(css).toContain('[data-bn="self"] [data-bn="name"]');
		// padding-* 不在视觉白名单里 —— 只剩 border-radius 那一条。
		expect(warnings.some((w) => w.includes("padding-top"))).toBe(true);
	});

	/**
	 * 挂点是**按块**分的,不是一张全卡通票 —— 更不是全仓通票。两个例子都得有:
	 *
	 * - `popularity` 是**同一张直播卡**里「直播数据」块的挂点。写进「主播信息」块必须
	 *   丢掉 —— 只按卡种取并集的写法在这一条上才会露馅(按卡种取并集时 `price` 照样
	 *   丢,那条一个人守不住)。
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
		expect(warnings.join()).toContain("不在 hook 白名单");
	});

	it("别的卡种的挂点整条丢弃并告警", () => {
		const { css, warnings } = ok(
			`[data-bn="price"]{color:red}
			[data-bn="avatar"]{border-width:2px}`,
			"header",
		);
		expect(css).not.toContain("price");
		expect(css).toContain("border-width:2px");
		expect(warnings.join()).toContain("不在 hook 白名单");
	});

	it("同一个挂点名换个块就该放行 —— sc/amount 认识 price", () => {
		const { css, warnings } = ok(`[data-bn="price"]{color:red}`, "amount", "sc");
		expect(css).toContain('[data-bn="price"]{color:red}');
		expect(warnings).toEqual([]);
	});

	it("自定义块(没有 builtin)只有 self —— 内置块的挂点一个都不认", () => {
		const { css, warnings } = ok(
			`[data-bn="self"]{color:#111}
			[data-bn="avatar"]{border-radius:999px}`,
		);
		expect(css).toContain('[data-bn="self"]{color:#111}');
		expect(css).not.toContain("avatar");
		expect(warnings.join()).toContain("不在 hook 白名单");
	});

	it("认不出的块名不静默 —— 只按 self 洗,并且说出来", () => {
		const { css, warnings } = ok(`[data-bn="self"]{color:#111}`, "no-such-block");
		expect(css).toContain('[data-bn="self"]');
		expect(warnings[0]).toContain("no-such-block");
	});

	/**
	 * 「每一段都得挂 hook」只管**有没有**挂点,不管那一段里**还有别的什么**。挂点在场
	 * 时,同一段里掺进来的 class / 标签 / id 全靠「件件都得在白名单里」那一问拦 ——
	 * 而下面那条「光秃秃的选择器」测不到它(那些段一个挂点都没有,前一道闸先把它们收了)。
	 *
	 * 拦不住的话,皮肤就能顺着渲染器的内部 class / id 精确点名某一个元素:挂点契约的
	 * 全部意义正是「真实选择器是实现细节」,这一条松了,内部重构就开始碰断存量皮肤。
	 */
	it("挂了 hook 也不行:同一段里掺了 class / 标签 / id → 整条丢弃", () => {
		for (const evil of [
			'[data-bn="self"].bn-row{color:red}',
			'div[data-bn="self"]{color:red}',
			'#card[data-bn="self"]{color:red}',
			'[data-bn="self"][class~="bn-row"]{color:red}',
		]) {
			const { css, warnings } = ok(evil, "header");
			expect(css, evil).toBe("");
			expect(warnings.join(), evil).toContain("不在 hook 白名单");
		}
	});

	it("class / id / 标签 / 通配选择器一律整条丢弃", () => {
		const { css, warnings } = ok(
			`.bn-card{color:red}
			#root{color:red}
			div{color:red}
			*{color:red}
			[data-bn="self"]{border-width:1px}`,
			"header",
		);
		expect(css).not.toContain("color");
		expect(css).toContain("border-width:1px");
		expect(warnings).toHaveLength(4);
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

describe("声明白名单", () => {
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

	it("白名单外的属性逐条丢弃", () => {
		const { css, warnings } = ok(
			`[data-bn="self"]{display:none;pointer-events:none;visibility:hidden;color:#fff}`,
			"header",
		);
		expect(css).toBe('[data-bn="self"]{color:#fff}');
		expect(warnings).toHaveLength(3);
	});
});

describe("position 只归伪元素", () => {
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

	it("宿主(非伪元素)写 position 一律丢弃", () => {
		const { css, warnings } = ok(`[data-bn="self"]{position:relative;border-width:1px}`, "header");
		expect(css).not.toContain("position");
		expect(css).toContain("border-width:1px");
		expect(warnings.join()).toContain("position");
	});
});

describe("根块(外框)只认两个挂点", () => {
	it("frame / glass 放行", () => {
		const { css, warnings } = okFrame(
			'[data-bn="frame"]{border-radius:16px}[data-bn="glass"]{background:#fff}',
		);
		expect(css).toContain('[data-bn="frame"]{border-radius:16px}');
		expect(css).toContain('[data-bn="glass"]{background:#fff}');
		expect(warnings).toEqual([]);
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
		expect(ok("div{color:red}", "header").css).toBe("");
	});
});
