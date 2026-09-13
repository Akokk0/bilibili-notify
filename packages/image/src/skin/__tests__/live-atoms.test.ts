/**
 * **直播卡数据区:两条路画出同样的三件**(ADR-0014 决策 16 的 🔗)。
 *
 * 人气 / 分区 / 粉丝原先由 `cardStyle` 的三个开关(进模板成 `showPopularity` /
 * `showArea` / `showFans` 三个 props)控制显隐,现在拆成了三个原子块 —— 旧路径靠**开关**
 * 收起,皮肤路径靠**迁移时不生成那一块**收起。两种表达必须给出同一张卡:
 *
 * - **旧路径**:模板 + 三个开关按用户的原样传;
 * - **皮肤路径**:`cardLayoutToSkin(…, toggles)` 把开关折进块序列,渲染时三个开关一律
 *   传 `true`(显隐已经由「有没有这块」表达了,再让开关插一手就是两套真值源)。
 *
 * 这条钉的是「同一组开关下,两条路的数据区文案出现与否一致」。它同时是那条接线的守卫:
 * 皮肤路径要真的找得到 `popularity` / `area` / `fans` 三个块渲染器 —— 找不到的话
 * `renderSkinnedCard` 会把整块当「没数据」悄悄收起,类型与别的测试全绿,只有这条会红。
 *
 * 像素级的一致(位置、行距、右对齐)不在这里钉:那是一次性本机像素门的事,这条只管
 * **哪几件出现**,所以不吃字体与截图的抖动,能长期留在门禁里。
 */

import { cardLayoutToSkin, DEFAULT_CARD_LAYOUT } from "@bilibili-notify/internal";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import { createSSRApp, type VNode } from "vue";
import { CARD_FIXTURES } from "../../__tests__/fixtures/card-fixtures";
import { LiveCard, type LiveCardProps } from "../../templates/live-card";
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

describe("直播卡数据区 — 旧路径(开关)与皮肤路径(原子块)显隐一致", () => {
	for (const toggles of COMBOS) {
		it(`${label(toggles)}:两条路出现的文案与开关一致`, async () => {
			const props = await liveProps();

			// 旧路径:开关照用户的原样传。
			const viaTemplate = await html(LiveCard({ ...props, ...toggles }));

			// 皮肤路径:显隐已折进块序列,开关一律真。
			const card = cardLayoutToSkin(DEFAULT_CARD_LAYOUT, undefined, toggles).cards.live;
			if (!card) throw new Error("折不出 live 卡");
			const viaSkin = await html(
				renderSkinnedCard({ kind: "live", card, props: { ...props, ...ALL_ON } }).vnode,
			);

			expect(probe(viaTemplate), "旧路径").toEqual(toggles);
			expect(probe(viaSkin), "皮肤路径").toEqual(toggles);
		});
	}
});
