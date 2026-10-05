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
 * 是想要的再 `-u` 重生成**并在批准的像素差清单(`approved-card-diffs.ts`)末尾记一条**:
 * 光 `-u` 不记,每个样例后面那道清单检查照样红(守卫 10,ADR-0028 决策 2)。别反过来把
 * 标尺改短。
 *
 * **挂点不再剥**(从前比的是重构前后,挂点是纯附加的所以要剥掉)。现在基准两边都是皮肤路径,
 * `data-bn` 挂点是皮肤 CSS 的公开 API,掉了就该红。挂点有没有挂串块仍归 `card-hooks.test.ts`。
 *
 * 夹具住在 `fixtures/card-fixtures.ts`;其中四份专测「非默认版式也画得对」,各自配的皮肤卡
 * 在 `fixtures/skin-render.ts`。
 *
 * 十份 `dynamic-*` 的输入是 `Post` 字面量(`fixtures/post-fixtures.ts`),B 站原始夹具与「原始数据 → `Post`」
 * 的那一腿在 `packages/dynamic` 的 `post-from-dynamic.test.ts`。**这十份必须仍在这里按原顺序渲染**:UnoCSS 的
 * 生成器进程内只有一个,属性层会把前面渲染过的卡用到的 `--un-*` 变量带进后面的卡(醒目留言 / 上舰 / 锐评 / 词云
 * 排在动态卡后面),挪走几份、顺序一变,后面那些快照的字节就跟着动。
 */

import { describe, expect, it } from "vite-plus/test";
import { APPROVED_CARD_DIFFS } from "./approved-card-diffs";
import { cardDiffIssues, cardHtmlHash, orphanedCardDiffIssues } from "./card-diff-check";
import { CARD_FIXTURES } from "./fixtures/card-fixtures";
import { renderViaSkin } from "./fixtures/skin-render";

/**
 * 把一份渲染结果钉进 `__snapshots__/card-baseline/<名字>.html`,再对一遍清单。
 *
 * 先比快照、后比清单:变了的时候先看到字节 diff,`-u` 之后才轮到清单要那一条。hash 取的是
 * 这次渲染出的字符串,不读快照文件(别的 checkout 上换行可能被改写)。
 */
async function snap(name: string, html: string): Promise<void> {
	await expect(html).toMatchFileSnapshot(`./__snapshots__/card-baseline/${name}.html`);
	expect(cardDiffIssues(name, cardHtmlHash(html), APPROVED_CARD_DIFFS)).toEqual([]);
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

describe("批准的像素差清单", () => {
	it("清单里点名的样例都还有夹具 —— 改名、删夹具、打错字不留死条目", () => {
		expect(
			orphanedCardDiffIssues(
				CARD_FIXTURES.map((f) => f.name),
				APPROVED_CARD_DIFFS,
			),
		).toEqual([]);
	});
});
