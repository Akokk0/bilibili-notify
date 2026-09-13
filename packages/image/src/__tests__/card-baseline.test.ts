/**
 * 七种推送卡片的**现状快照**(模板重构的验收基准)。
 *
 * 这份文件刻意钉的是 `renderCard()` 出的**完整 HTML 字节**(含 UnoCSS 生成的整段
 * CSS),与本包「只测块装配契约、不测 HTML / CSS 拼装」的惯例是直接冲突的 —— 冲突
 * 是**有意的,且只限模板重构期**:接下来要把各模板拆成块,验收标准就是「重构前后逐
 * 字节一致」,那就只有字节本身能当基准。重构落地后这份基准要么删掉、要么降级成几条
 * 结构断言;别把它当长期的版式测试用 —— 任何 restyle 都会让它整片变红,那正是它此刻
 * 该做的事。
 *
 * **自此基准守的是「剥掉挂点属性后的字节」**:比较前先把 ` data-bn="…"` 整个抹掉
 * (`stripCardHooks`)。原因是 ADR-0014 决策 9 —— 皮肤要能单独选中复合块内部的部件
 * (头像 / 名字 / 封面 / 角标…),办法是给这些**已经存在的**元素加一个 `data-bn` 属性。
 * 那是**纯附加**的:不多一个元素、不动一个 class、不改一处 inline style,所以剥掉它
 * 之后必须与重构前逐字节相同。快照文件因此一份没重生成 —— 一旦某处挂点是靠「多包一层
 * span」实现的,剥完仍会多出那层壳,这里当场红,这正是它该做的事。挂点本身有没有挂对、
 * 有没有挂串块,归 `card-hooks.test.ts` 管。
 *
 * 夹具住在 `fixtures/card-fixtures.ts`(与挂点对表共用一份);夹具刻意铺开各模板的条件
 * 分支,让一次重构能一次照出问题。
 */

import { describe, expect, it } from "vite-plus/test";
import { renderCard } from "../render";
import { buildDynamicNode } from "../templates/dynamic-content";
import { CARD_FIXTURES, LIVE_RCMD_DYNAMIC, stripCardHooks } from "./fixtures/card-fixtures";

/** 把一份渲染结果(剥掉挂点后)钉进 `__snapshots__/card-baseline/<名字>.html`。 */
async function snap(name: string, html: string): Promise<void> {
	await expect(stripCardHooks(html)).toMatchFileSnapshot(
		`./__snapshots__/card-baseline/${name}.html`,
	);
}

const GROUPS = [...new Set(CARD_FIXTURES.map((f) => f.group))];

for (const group of GROUPS) {
	describe(`卡片渲染基准 — ${group}`, () => {
		for (const fixture of CARD_FIXTURES.filter((f) => f.group === group)) {
			it(fixture.label, async () => {
				const { component, props, options } = await fixture.build();
				await snap(fixture.name, await renderCard(component, props, options));
			});
		}
	});
}

describe("卡片渲染基准 — 动态卡(无快照)", () => {
	it("dynamic-live-rcmd 没有快照 —— 开播动态在 buildDynamicNode 里直接抛，压根到不了 renderCard", async () => {
		// 现状即如此(`throw new Error("直播开播动态，不做处理")`):开播走直播卡那条路,
		// 动态卡不处理。重构后若这条不再抛,是行为变化,这里会红。
		await expect(
			buildDynamicNode(LIVE_RCMD_DYNAMIC, false, { time: () => "刚刚", num: String }),
		).rejects.toThrow("直播开播动态");
	});
});
