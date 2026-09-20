/**
 * **卡片皮肤的结构门**(ADR-0014 决策 24 的自动门之一)。
 *
 * 钉一件事:皮肤路径画出来的**形状**对 —— 玻璃层真的是 12 列的网格容器,每个块的 wrapper
 * 都带着 `bn-blk-` 的 class(皮肤自己的 CSS 就挂在它上面)。列数少一列整张卡就错位,而
 * 那种错位在字节基准里只是「又变了一片」,看不出是结构塌了。
 *
 * 原来这份文件里还有一道**门 A**:同一份夹具,一边走旧模板(基准是开工前打的 23 份快照),
 * 一边走「旧版式折成皮肤 → 皮肤渲染器」,两边的块内层逐字节比 —— 它证明的是两条路等价。
 * 旧模板与那条折叠都已退役(决策 24 的 2026-09-18 🔗),门 A 随之合并进
 * `__tests__/card-baseline.test.ts`:那份快照改钉皮肤路径的字节,换基准时两条路是绿的,
 * 所以它继承了这道门的证明。
 */

import { JSDOM } from "jsdom";
import { describe, expect, it } from "vite-plus/test";
import { CARD_FIXTURES } from "../../__tests__/fixtures/card-fixtures";
import { renderViaSkin } from "../../__tests__/fixtures/skin-render";

/** 外框 → 玻璃层。壳恒是这两层,按位置取。 */
function glassOf(html: string): Element {
	const frame = new JSDOM(html).window.document.body.firstElementChild;
	const glass = frame?.firstElementChild;
	if (!glass) throw new Error("这份 HTML 里找不到「外框 > 玻璃层」两层");
	return glass;
}

/**
 * 网格声明的列数。`repeat(n, …)` 读 n,逐列写法(上舰卡那种混了定宽列的)数条目 ——
 * 数出来必须恒是 12:块的 `column` / `span` 都按 12 列算,少一列整张卡就错位。
 */
function columnCount(style: string): number {
	const tracks = /grid-template-columns:([^;]+)/.exec(style)?.[1] ?? "";
	const repeat = /^repeat\((\d+),/.exec(tracks);
	if (repeat) return Number(repeat[1]);
	return (tracks.match(/minmax\([^)]*\)|[\d.]+px|[\d.]+fr/g) ?? []).length;
}

describe("卡片皮肤验收门 B — 结构", () => {
	for (const fixture of CARD_FIXTURES) {
		it(`${fixture.name}:玻璃层是 12 列网格,每块都有 bn-blk- 的 class`, async () => {
			const input = await fixture.build();
			const glass = glassOf(await renderViaSkin(fixture, input));
			const style = glass.getAttribute("style") ?? "";
			expect(style).toContain("display:grid");
			expect(columnCount(style)).toBe(12);
			// 玻璃层的直接孩子是**格子层**(ADR-0018):网格坐标住它身上,而皮肤的
			// `.bn-blk-<id>` 在它里面那一层 —— 这正是「画布画的矩形 = DOM 里一个真盒子」
			// 靠的结构。格子层恰好一个孩子:多一个就说不清画布那个框对应哪一个。
			const cells = [...glass.children];
			expect(cells.length).toBeGreaterThan(0);
			for (const cell of cells) {
				expect(cell.hasAttribute("data-cell")).toBe(true);
				expect(cell.getAttribute("style") ?? "").toContain("grid-row:");
				expect(cell.children).toHaveLength(1);
				const inner = cell.children[0];
				expect([...inner.classList].some((c) => c.startsWith("bn-blk-"))).toBe(true);
				// 坐标不许同时写在内层 —— 写了就等于皮肤那一层也在参与排版,恒等失守。
				expect(inner.getAttribute("style") ?? "").not.toContain("grid-row:");
			}
		});
	}
});
