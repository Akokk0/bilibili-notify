/**
 * **覆盖层是网格兄弟,不是谁的孩子**(ADR-0014 决策 8 的 2026-09-18 🔗)。
 *
 * 直播状态角标从前长在封面块**里面**(`position:absolute` 贴着封面右上角),所以它整块
 * 挪不走、单独关不掉。拆开之后角标是一块独立的原子块,与封面**占同一片格子、层次更高**,
 * 位置靠 `align-self` / `justify-self` / `margin` 说 —— 不引入看不懂的隐形底板块。
 *
 * 这份钉的就是「兄弟」这件事:
 * - 角标在网格里与封面平级,不在封面的子树里(嵌回去的话,拖走角标会把封面一起带走);
 * - 两块的 `grid-row` 起始行相同(不同行就不叫「叠在封面上」了);
 * - 角标那层 `z-index` 压得住封面。
 *
 * ⚠️ 光看出图看不出区别 —— 嵌套与并列画出来的像素是一样的,像素门与字节门都拦不住。
 */

import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { CARD_FIXTURES } from "../../__tests__/fixtures/card-fixtures";
import { renderViaDefaultSkin } from "../../__tests__/fixtures/skin-render";

let doc: Document;

beforeAll(async () => {
	const fixture = CARD_FIXTURES.find((f) => f.name === "live-streaming");
	if (!fixture) throw new Error("夹具表里没有 live-streaming");
	const built = await fixture.build();
	doc = new JSDOM(await renderViaDefaultSkin("live", built.props, built.options)).window.document;
});

/** 网格里那一块的**格子层**(`[data-cell]`)—— 网格坐标住它身上(ADR-0018)。 */
function blk(id: string): HTMLElement {
	const el = doc.querySelector<HTMLElement>(`[data-cell="${id}"]`);
	if (!el) throw new Error(`默认直播皮肤上没有「${id}」这一块`);
	return el;
}

/** 格子层的 inline `grid-row` 起始行。 */
function rowOf(el: HTMLElement): string {
	const m = /grid-row:(\d+)/.exec(el.getAttribute("style") ?? "");
	if (!m) throw new Error(`这一块的 style 里没有 grid-row:${el.getAttribute("style")}`);
	return m[1];
}

describe("直播状态角标 — 与封面是网格兄弟", () => {
	it("角标不在封面的子树里", () => {
		expect(blk("cover").contains(blk("status"))).toBe(false);
	});

	it("两块同一个网格容器的直接孩子", () => {
		expect(blk("status").parentElement).toBe(blk("cover").parentElement);
	});

	it("两块从同一行起 —— 这才叫叠在封面上", () => {
		expect(rowOf(blk("status"))).toBe(rowOf(blk("cover")));
	});

	it("角标那层压得住封面", () => {
		expect(blk("status").getAttribute("style")).toContain("z-index:");
		expect(blk("cover").getAttribute("style")).not.toContain("z-index:");
	});

	it("角标贴在右上角:自己收成内容宽、靠上靠右", () => {
		const css = doc.querySelector("style")?.textContent ?? "";
		const rule = /\.bn-blk-status\{([^}]*)\}/.exec(css)?.[1] ?? "";
		expect(rule).toContain("align-self:start");
		expect(rule).toContain("justify-self:end");
	});

	it("封面块里只剩一张图,状态文字搬去角标那块了", () => {
		expect(blk("cover").querySelectorAll("img").length).toBe(1);
		expect(blk("cover").textContent?.trim()).toBe("");
		expect(blk("status").textContent).toBe("直播中");
	});
});
