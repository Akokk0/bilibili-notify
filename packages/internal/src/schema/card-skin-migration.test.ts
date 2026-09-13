/**
 * 旧版式 → 卡片皮肤的迁移(ADR-0014 决策 15、17)。
 *
 * 头一条是整份迁移的**判据**:出厂默认版式折出来的那份卡,必须与出厂默认皮肤一字不差。
 * 两边任何一边改了(块顺序、间距、上舰卡的列宽)而另一边没跟上,它当场红 —— 这也是
 * 「升级后用户零感知」的依据。其余几条钉的是版式里那些**用户改得动**的维度:隐藏块不
 * 占行、分割线保留原 id、上舰卡的徽章侧。
 */

import { describe, expect, it } from "vite-plus/test";
import { type CardBlock, type CardLayout, DEFAULT_CARD_LAYOUT, DIVIDER_TYPE } from "./card-layout";
import { type CardSkinBlock, DEFAULT_CARD_SKIN } from "./card-skin";
import { cardLayoutToSkin } from "./card-skin-migration";

/** 一份 v7 版式:除了指定的卡种,其余照出厂默认。 */
function layoutWith(over: Partial<CardLayout>): CardLayout {
	return { ...DEFAULT_CARD_LAYOUT, ...over };
}

const blocksOf = (layout: CardLayout, kind: "live" | "dynamic" | "sc" | "guard"): CardSkinBlock[] =>
	cardLayoutToSkin(layout).cards[kind]?.blocks ?? [];

/** 折出来的块一律是内置块(自定义块只能由用户在编辑器里加)。 */
const builtinOf = (b: CardSkinBlock): string => (b.kind === "builtin" ? b.builtin : "custom");

describe("旧版式 → 卡片皮肤 — 默认版式折出来就是默认皮肤", () => {
	it("cardLayoutToSkin(DEFAULT_CARD_LAYOUT).cards 与 DEFAULT_CARD_SKIN.cards 一字不差", () => {
		expect(cardLayoutToSkin(DEFAULT_CARD_LAYOUT).cards).toEqual(DEFAULT_CARD_SKIN.cards);
	});

	it("包元信息(版本 / 名字)照抄 base", () => {
		const skin = cardLayoutToSkin(DEFAULT_CARD_LAYOUT);
		expect(skin.schemaVersion).toBe(DEFAULT_CARD_SKIN.schemaVersion);
		expect(skin.dataVersion).toBe(DEFAULT_CARD_SKIN.dataVersion);
		expect(skin.name).toBe(DEFAULT_CARD_SKIN.name);
	});
});

describe("旧版式 → 卡片皮肤 — 竖栈卡", () => {
	it("按数组顺序编行号、12 列整跨", () => {
		const blocks = blocksOf(DEFAULT_CARD_LAYOUT, "live");
		expect(blocks.map((b) => b.grid.row)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(blocks.every((b) => b.grid.column === 1 && b.grid.span === 12)).toBe(true);
	});

	it("隐藏的块不生成,也不留空行", () => {
		const live: CardBlock[] = DEFAULT_CARD_LAYOUT.live.map((b) =>
			b.type === "title" ? { ...b, visible: false } : b,
		);
		const blocks = blocksOf(layoutWith({ live }), "live");
		expect(blocks.map(builtinOf)).toEqual(["cover", "header", DIVIDER_TYPE, "data", "desc"]);
		expect(blocks.map((b) => b.grid.row)).toEqual([1, 2, 3, 4, 5]);
	});

	it("marginTop 折成 self 的 padding-top;首块不写", () => {
		const blocks = blocksOf(DEFAULT_CARD_LAYOUT, "live");
		expect(blocks[0].css).toBeUndefined();
		expect(blocks[1].css).toBe('[data-bn="self"]{padding-top:14px}');
	});

	it("首块自带的 marginTop 被丢掉(旧渲染器把首块上边距交给卡片框架,折过来不能凭空多一段)", () => {
		// 出厂默认版式的首块都没有 marginTop,所以这条得自己造一份 —— 不造的话「首块不写」
		// 那一支永远走不到,改坏了也不会红。
		const live: CardBlock[] = DEFAULT_CARD_LAYOUT.live.map((b, i) =>
			i === 0 ? { ...b, marginTop: 30 } : b,
		);
		expect(blocksOf(layoutWith({ live }), "live")[0].css).toBeUndefined();
	});

	it("分割线保留原 id(可多份)", () => {
		const blocks = blocksOf(DEFAULT_CARD_LAYOUT, "dynamic");
		expect(blocks.filter((b) => builtinOf(b) === DIVIDER_TYPE).map((b) => b.id)).toEqual([
			"divider-1",
			"divider-2",
		]);
	});
});

describe("旧版式 → 卡片皮肤 — 上舰卡", () => {
	it("徽章在右:内容 1-8 列、徽章 9-12 列跨满内容的行", () => {
		const blocks = blocksOf(DEFAULT_CARD_LAYOUT, "guard");
		expect(blocks.map((b) => b.id)).toEqual(["name", "text", "badge"]);
		expect(blocks[0].grid).toEqual({ row: 1, column: 1, span: 8 });
		expect(blocks[2].grid).toEqual({ row: 1, column: 9, span: 4, rowSpan: 2 });
	});

	it("徽章在左:徽章 1-4 列排在最前、内容 5-12 列并右对齐", () => {
		const guard = {
			badgeSide: "left" as const,
			blocks: [
				{ id: "text", type: "text", visible: true },
				{ id: "divider-1", type: DIVIDER_TYPE, visible: true, marginTop: 8 },
				{ id: "name", type: "name", visible: true, marginTop: 8 },
			],
		};
		const blocks = blocksOf(layoutWith({ guard }), "guard");
		expect(blocks.map((b) => b.id)).toEqual(["badge", "text", "divider-1", "name"]);
		expect(blocks[0].grid).toEqual({ row: 1, column: 1, span: 4, rowSpan: 3 });
		expect(blocks[1].grid).toEqual({ row: 1, column: 5, span: 8 });
		// 首块只加镜像、不加上边距;后面的块两样都有。
		expect(blocks[1].css).toBe(
			'[data-bn="self"]{display:flex;flex-direction:column;align-items:flex-end;text-align:right}',
		);
		expect(blocks[3].css).toBe(
			'[data-bn="self"]{padding-top:8px;display:flex;flex-direction:column;align-items:flex-end;text-align:right}',
		);
	});
});
