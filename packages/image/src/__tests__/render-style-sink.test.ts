/**
 * **`<style>` 这个出口自己的守卫**(2026-09-19 审查)。
 *
 * `<style>` 在 HTML 里是 RAWTEXT:里头**唯一**能终止它的是 `</style`。而 `renderCard`
 * 是靠**字符串拼**把几段 CSS 塞进去的,所以只要拼进去的那段带着 `</`,样式表就提前
 * 关掉,后面那截照 HTML 解析 —— `<script>` 成了真的脚本节点。出图跑的是
 * `--no-sandbox` 的 puppeteer,且那页 JS 必须开着(`waitForCondition` 靠它)。
 *
 * 上游(`apps/server` 的皮肤 CSS 清洗器)已经整份拒掉 `</` 了。**这一组仍然要有**,
 * 理由是 `renderCard` 看不见那个承诺:它是 `packages/image` 的公共入口,`extraCss`
 * 的契约里从来没写过「传进来的一定洗过」。判据照
 * `wiring-needs-its-own-guard` / `guards-pin-shape-not-property`:把 `sealStyleBody`
 * 那一层拆掉(直接拼 `${extraCss}`),这一组必须红。
 */

import { JSDOM } from "jsdom";
import { describe, expect, it } from "vite-plus/test";
import { h } from "vue";
import { renderCard } from "../render";

const Tiny = () => h("div", { class: "text-[12px]" }, "卡");

const PAYLOAD = `[data-bn~="self"]::before{content:"</style><script>window.PWNED=1</script>"}`;

describe("<style> 出口不许被提前关掉", () => {
	it("extraCss 里的 </style> 不产生脚本节点", async () => {
		const html = await renderCard(Tiny, {}, { extraCss: PAYLOAD });
		const doc = new JSDOM(html).window.document;
		expect(doc.querySelectorAll("script")).toHaveLength(0);
		// 样式表只能有一份 —— 提前关掉的话后半截会再开一个,或者整个 <head> 结构走样。
		expect(doc.querySelectorAll("style")).toHaveLength(1);
	});

	it("画出来的东西不变 —— `\\/` 在 CSS 字符串里就是 `/`", async () => {
		const html = await renderCard(Tiny, {}, { extraCss: PAYLOAD });
		const style = new JSDOM(html).window.document.querySelector("style");
		expect(style?.textContent).toContain(String.raw`<\/style>`);
		expect(style?.textContent).not.toContain("</style>");
	});

	it("不含 `</` 的 CSS 一个字节都不动 —— 像素基准不受影响", async () => {
		const plain = `[data-bn~="self"]{color:red;content:"a > b"}`;
		const html = await renderCard(Tiny, {}, { extraCss: plain });
		expect(html).toContain(plain);
	});
});
