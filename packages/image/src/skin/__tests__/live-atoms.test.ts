/**
 * **直播卡数据区:摆哪几块就画哪几件**(ADR-0014 决策 16 的 🔗)。
 *
 * 人气 / 分区 / 粉丝原先由三个开关控制显隐,开关早已退役 —— 块级的 `showIf` 管不到复合块
 * 内部的一行,所以它们拆成了三个**原子块**,「想少显示哪件」= 皮肤里不摆那一块。
 *
 * 这条真正钉的是**那条接线**:皮肤路径要真的找得到 `popularity` / `area` / `fans` 三个块
 * 渲染器 —— 找不到的话 `renderSkinnedCard` 会把整块当「没数据」悄悄收起,类型与别的测试
 * 全绿,只有这条会红。所以它一块一块地摆、一件一件地数。
 *
 * 像素级的一致(位置、行距、右对齐)不在这里钉:那是本机像素门的事,这条只管**哪几件出现**,
 * 所以不吃字体与截图的抖动,能长期留在门禁里。
 */

import { type CardSkinCard, DEFAULT_CARD_SKIN } from "@bilibili-notify/internal";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import { createSSRApp, type VNode } from "vue";
import { CARD_FIXTURES } from "../../__tests__/fixtures/card-fixtures";
import type { LiveCardProps } from "../../templates/live-card";
import { renderSkinnedCard } from "../render-skin";

interface Toggles {
	showPopularity: boolean;
	showArea: boolean;
	showFans: boolean;
}

const ALL_ON: Toggles = { showPopularity: true, showArea: true, showFans: true };

/** 八种组合:全开 + 七种「至少关一个」。 */
const COMBOS: Toggles[] = [true, false].flatMap((showPopularity) =>
	[true, false].flatMap((showArea) =>
		[true, false].map((showFans) => ({ showPopularity, showArea, showFans })),
	),
);

const label = (t: Toggles): string =>
	`人气${t.showPopularity ? "开" : "关"} 分区${t.showArea ? "开" : "关"} 粉丝${t.showFans ? "开" : "关"}`;

/** 块 id ↔ 那一件。 */
const ATOM_OF: Record<keyof Toggles, string> = {
	showPopularity: "popularity",
	showArea: "area",
	showFans: "fans",
};

/** 出厂默认皮肤的直播卡,只留这组开关要的那几块(其余块一并去掉,数起来干净)。 */
function cardWith(toggles: Toggles): CardSkinCard {
	const card = DEFAULT_CARD_SKIN.cards.live;
	if (!card) throw new Error("出厂默认皮肤缺 live 卡");
	const want = (Object.keys(ATOM_OF) as (keyof Toggles)[])
		.filter((k) => toggles[k])
		.map((k) => ATOM_OF[k]);
	const blocks = want.map((id, i) => {
		const block = card.blocks.find((b) => b.id === id);
		if (!block) throw new Error(`默认皮肤的直播卡没有「${id}」这一块`);
		return { ...block, grid: { row: i + 1, column: 1, span: 12 } };
	});
	return { ...card, blocks };
}

/** 与基准 / 挂点对表共用的那份直播卡夹具(直播中,三件都有数据)。 */
async function liveProps(): Promise<LiveCardProps> {
	const fixture = CARD_FIXTURES.find((f) => f.name === "live-streaming");
	if (!fixture) throw new Error("找不到 live-streaming 夹具");
	return (await fixture.build()).props as unknown as LiveCardProps;
}

const html = async (vnode: VNode): Promise<string> =>
	await renderToString(createSSRApp({ render: () => vnode }));

/** 数据区那三件的文案各自出现了没有。三句在直播卡里都只出现在数据区。 */
function probe(rendered: string): Toggles {
	return {
		showPopularity: rendered.includes("人气："),
		showArea: rendered.includes("分区："),
		showFans: rendered.includes("粉丝数"),
	};
}

describe("直播卡数据区 — 摆哪几块就画哪几件", () => {
	for (const toggles of COMBOS) {
		it(`${label(toggles)}:出现的文案与摆进去的那几块一致`, async () => {
			const props = await liveProps();
			const viaSkin = await html(
				renderSkinnedCard({ kind: "live", card: cardWith(toggles), props }).vnode,
			);
			// 验红:把 `blocks/live.tsx` 里 popularity / area / fans 任一个渲染器改成回 null
			// (皮肤路径会把它当「没数据」静默收起),这条当场红。
			expect(probe(viaSkin)).toEqual(toggles);
		});
	}

	it("三件都摆上 → 三件都画,一件不少", async () => {
		const props = await liveProps();
		const viaSkin = await html(
			renderSkinnedCard({ kind: "live", card: cardWith(ALL_ON), props }).vnode,
		);
		expect(probe(viaSkin)).toEqual(ALL_ON);
	});
});
