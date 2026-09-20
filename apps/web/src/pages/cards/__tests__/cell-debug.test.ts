/**
 * **格子的调试叠层**(ADR-0018 决策 5)—— 真卡上看得见格子,浏览器开发者工具查元素那个样子。
 *
 * 它只有在**格子层存在**之后才做得出来:从前那层 wrapper 会被皮肤捏形状(`justify-self`、
 * `margin`),描出来的框不是格子。现在 `[data-cell]` 是个恒等于格子的真元素,一条 CSS 就够。
 *
 * 四条不肯让步的:
 *
 * 1. **注在 web 这一侧**。出图那条路一个字节都不许动 —— 调试样式绝无可能漏进推送出去的卡,
 *    23 份字节基准也不被它污染。
 * 2. **不占布局**。只用 `outline` 与 `background`:`border` / `padding` 会把每个格子撑大,
 *    那就不是「看这张卡」而是「看另一张卡」了。
 * 3. **只碰 `[data-cell]`**。选到别的东西就等于替皮肤改样子。
 * 4. **关着的时候逐字节不变**。开关关着还留一段注释 / 空 style,「所见即所得」就已经破了。
 *
 * 悬停那一档靠浏览器自己的 `:hover`,不需要脚本 —— 预览框的 `allow-scripts` 照旧不给
 * (ADR-0014 决策 22 那条「同源与脚本永远不许同时给」)。
 */

import { describe, expect, it } from "vite-plus/test";
import { CELL_DEBUG_MODES, type CellDebugMode, withCellDebug } from "../cell-debug";

const PAGE = '<html><head></head><body><div data-cell="t">卡</div></body></html>';

/** 追加进去的那一段(整段 style)。 */
function injected(html: string): string {
	return html.slice(PAGE.indexOf("</body>") === -1 ? 0 : html.indexOf("<style"));
}

describe("withCellDebug — 关着的时候什么都不做", () => {
	it("off → 逐字节不变", () => {
		expect(withCellDebug(PAGE, "off")).toBe(PAGE);
	});

	it("三档都在册,off 是其中一档", () => {
		expect(CELL_DEBUG_MODES).toContain("off");
		expect(CELL_DEBUG_MODES).toContain("hover");
		expect(CELL_DEBUG_MODES).toContain("all");
	});
});

describe("withCellDebug — 开着的时候", () => {
	const on: CellDebugMode[] = ["hover", "all"];

	it("追在 </body> 之前", () => {
		for (const mode of on) {
			const out = withCellDebug(PAGE, mode);
			expect(out.endsWith("</body></html>")).toBe(true);
			expect(out.indexOf("<style")).toBeLessThan(out.indexOf("</body>"));
		}
	});

	// 出图的 HTML 理论上总有 </body>,但预览回来的东西不是我们能打包票的;没有就追在末尾,
	// 别让一段 CSS 凭空消失(那会变成「开关点了没反应」)。
	it("没有 </body> 就追在末尾", () => {
		const out = withCellDebug("<div data-cell='t'></div>", "all");
		expect(out.includes("<style")).toBe(true);
	});

	it("只碰 [data-cell],不碰别的选择器", () => {
		for (const mode of on) {
			const css = injected(withCellDebug(PAGE, mode));
			// 每一条规则的选择器都得含 [data-cell]。
			const selectors = [...css.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim());
			expect(selectors.length).toBeGreaterThan(0);
			for (const sel of selectors) expect(sel).toContain("[data-cell]");
		}
	});

	// 撑大格子的属性一个都不许用 —— 开着调试看到的必须仍是那张真卡。
	it("不占布局:没有 border / padding / margin / width", () => {
		for (const mode of on) {
			const css = injected(withCellDebug(PAGE, mode));
			for (const prop of ["border:", "border-width", "padding", "margin", "width:", "height:"]) {
				expect(css).not.toContain(prop);
			}
			expect(css).toContain("outline");
		}
	});

	it("hover 那一档靠 :hover,不常显底色", () => {
		const css = injected(withCellDebug(PAGE, "hover"));
		expect(css).toContain(":hover");
	});

	/**
	 * **画布指哪一格,真卡就亮哪一格**(2026-09-20 主人要的)。真卡里那个格子由外面打一个
	 * `data-cell-hot` 标记,亮不亮的样子归这段 CSS —— 所以只有调试开着时才看得见,
	 * 正是主人说的「打开格子显示后」。
	 */
	it("两档都带「点亮某一格」那条规则", () => {
		for (const mode of on) {
			const css = injected(withCellDebug(PAGE, mode));
			expect(css).toContain("data-cell-hot");
		}
	});

	it("all 那一档常显轮廓", () => {
		const css = injected(withCellDebug(PAGE, "all"));
		// 有一条不带 `:hover` 的规则在画轮廓。
		const always = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(
			(m) => !m[1].includes(":hover") && m[2].includes("outline"),
		);
		expect(always.length).toBeGreaterThan(0);
	});
});
