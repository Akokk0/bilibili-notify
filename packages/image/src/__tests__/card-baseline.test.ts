/**
 * 七种推送卡片的**现状快照** —— 出图的自动基准门(ADR-0014 决策 24 的 2026-09-18 🔗)。
 *
 * 钉的是**皮肤那条路**画出的完整 HTML 字节(含 UnoCSS 生成的整段 CSS)。从前这份基准钉的
 * 是旧模板的输出,另有一道门比「旧版式折成皮肤」与旧模板两条路是否一致;旧模板与那条折叠
 * 都已退役,两者合并成这一份:**出厂默认皮肤画出来的字节,钉住不许悄悄变**。换基准那一刻
 * 两条路的一致性是绿的,所以这份快照继承了原来那道门的证明。
 *
 * 与本包「只测块装配契约、不测 HTML / CSS 拼装」的惯例仍然冲突,冲突依旧是**有意的**:
 * 任何改动只要动了出图,这里就整片红 —— 那正是它该做的事。红了**先看变化对不对**,确认
 * 是想要的再 `-u` 重生成,别反过来把标尺改短。
 *
 * **挂点不再剥**(从前比的是重构前后,挂点是纯附加的所以要剥掉)。现在基准两边都是皮肤路径,
 * `data-bn` 挂点是皮肤 CSS 的公开 API,掉了就该红。挂点有没有挂串块仍归 `card-hooks.test.ts`。
 *
 * 夹具住在 `fixtures/card-fixtures.ts`;其中四份专测「非默认版式也画得对」,各自配的皮肤卡
 * 在 `fixtures/skin-render.ts`。
 */

import { describe, expect, it } from "vite-plus/test";
import { buildDynamicNode } from "../templates/dynamic-content";
import { CARD_FIXTURES, LIVE_RCMD_DYNAMIC } from "./fixtures/card-fixtures";
import { renderViaSkin } from "./fixtures/skin-render";

/** 把一份渲染结果钉进 `__snapshots__/card-baseline/<名字>.html`。 */
async function snap(name: string, html: string): Promise<void> {
	await expect(html).toMatchFileSnapshot(`./__snapshots__/card-baseline/${name}.html`);
}

const GROUPS = [...new Set(CARD_FIXTURES.map((f) => f.group))];

for (const group of GROUPS) {
	describe(`卡片渲染基准 — ${group}`, () => {
		for (const fixture of CARD_FIXTURES.filter((f) => f.group === group)) {
			it(fixture.label, async () => {
				await snap(fixture.name, await renderViaSkin(fixture, await fixture.build()));
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
