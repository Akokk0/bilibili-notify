/**
 * 旧版式 → 卡片皮肤的迁移(ADR-0014 决策 15、17)。
 *
 * 头一条是整份迁移的**判据**:出厂默认版式折出来的那份卡,必须与出厂默认皮肤一字不差。
 * 两边任何一边改了(块顺序、间距、上舰卡的列宽)而另一边没跟上,它当场红 —— 这也是
 * 「升级后用户零感知」的依据。其余几条钉的是版式里那些**用户改得动**的维度:隐藏块不
 * 占行、分割线保留原 id、上舰卡的徽章侧,以及直播卡数据区那三个显隐开关折成的原子块组
 * (ADR-0014 决策 16 的 🔗 —— 那三个开关退役,关过的存量用户折成用原子块拼的派生皮肤)。
 */

import { describe, expect, it } from "vite-plus/test";
import { type CardBlock, type CardLayout, DEFAULT_CARD_LAYOUT, DIVIDER_TYPE } from "./card-layout";
import {
	type CardSkinBlock,
	type CardSkinManifest,
	DEFAULT_CARD_SKIN,
	DEFAULT_FRAME_BG_RULE,
} from "./card-skin";
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

describe("旧版式 → 卡片皮肤 — 直播卡数据区的三个显隐开关", () => {
	const ALL_ON = { showPopularity: true, showArea: true, showFans: true };

	/** 折一份默认版式的 live 卡块序列(带开关)。 */
	const liveBlocks = (toggles: typeof ALL_ON): CardSkinBlock[] =>
		cardLayoutToSkin(DEFAULT_CARD_LAYOUT, undefined, toggles).cards.live?.blocks ?? [];

	/** 只留数据区那几块(前面的 cover / header / title / divider 与后面的 desc 不看)。 */
	const atomsOf = (toggles: typeof ALL_ON): CardSkinBlock[] =>
		liveBlocks(toggles).filter((b) => ["popularity", "area", "fans"].includes(builtinOf(b)));

	it("三个都开:与不传开关逐字相同(数据区还是那个复合块)", () => {
		expect(cardLayoutToSkin(DEFAULT_CARD_LAYOUT, undefined, ALL_ON)).toEqual(
			cardLayoutToSkin(DEFAULT_CARD_LAYOUT),
		);
	});

	it("关掉粉丝:顶行两件各占半边,人气在左、分区在右", () => {
		const atoms = atomsOf({ ...ALL_ON, showFans: false });
		expect(atoms.map(builtinOf)).toEqual(["popularity", "area"]);
		expect(atoms[0].grid).toEqual({ row: 5, column: 1, span: 6 });
		expect(atoms[1].grid).toEqual({ row: 5, column: 7, span: 6 });
		expect(atoms[1].css).toBe('[data-bn="self"]{padding-top:10px;text-align:right}');
	});

	it("关掉分区:人气独占顶行 12 列,粉丝行跟在下一行", () => {
		const atoms = atomsOf({ ...ALL_ON, showArea: false });
		expect(atoms.map(builtinOf)).toEqual(["popularity", "fans"]);
		expect(atoms[0].grid).toEqual({ row: 5, column: 1, span: 12 });
		expect(atoms[1].grid).toEqual({ row: 6, column: 1, span: 12 });
	});

	it("关掉人气:分区独占顶行 12 列,但仍然靠右", () => {
		const atoms = atomsOf({ ...ALL_ON, showPopularity: false });
		expect(atoms.map(builtinOf)).toEqual(["area", "fans"]);
		expect(atoms[0].grid).toEqual({ row: 5, column: 1, span: 12 });
		expect(atoms[0].css).toBe('[data-bn="self"]{padding-top:10px;text-align:right}');
	});

	it("只剩人气 / 只剩分区 / 只剩粉丝:各自通栏独占一行", () => {
		for (const only of ["popularity", "area", "fans"] as const) {
			const toggles = {
				showPopularity: only === "popularity",
				showArea: only === "area",
				showFans: only === "fans",
			};
			const atoms = atomsOf(toggles);
			expect(atoms.map(builtinOf), only).toEqual([only]);
			expect(atoms[0].grid, only).toEqual({ row: 5, column: 1, span: 12 });
		}
	});

	it("三件全关:整组不生成,后面的块也不留空行", () => {
		const blocks = liveBlocks({ showPopularity: false, showArea: false, showFans: false });
		expect(blocks.map(builtinOf)).toEqual(["cover", "header", "title", DIVIDER_TYPE, "desc"]);
		expect(blocks.map((b) => b.grid.row)).toEqual([1, 2, 3, 4, 5]);
	});

	it("data 块的 marginTop 落到该组第一行;顶行整个关掉时落到粉丝行", () => {
		const withTopRow = atomsOf({ ...ALL_ON, showArea: false });
		// 顶行在 → 10px 落在顶行那件,粉丝行只有复刻 gap-1 的 4px。
		expect(withTopRow[0].css).toBe('[data-bn="self"]{padding-top:10px}');
		expect(withTopRow[1].css).toBe('[data-bn="self"]{padding-top:4px}');
		const fansOnly = atomsOf({ showPopularity: false, showArea: false, showFans: true });
		expect(fansOnly[0].css).toBe('[data-bn="self"]{padding-top:10px}');
	});

	it("数据区展开成两行时,它后面的块跟着往下挪一行", () => {
		const blocks = liveBlocks({ ...ALL_ON, showArea: false });
		expect(blocks.map(builtinOf)).toEqual([
			"cover",
			"header",
			"title",
			DIVIDER_TYPE,
			"popularity",
			"fans",
			"desc",
		]);
		expect(blocks.map((b) => b.grid.row)).toEqual([1, 2, 3, 4, 5, 6, 7]);
	});

	it("数据区是首块时,它的 marginTop 照样被丢掉", () => {
		const live: CardBlock[] = [
			{ id: "data", type: "data", visible: true, marginTop: 30 },
			...DEFAULT_CARD_LAYOUT.live.filter((b) => b.type !== "data"),
		];
		const blocks =
			cardLayoutToSkin(layoutWith({ live }), undefined, { ...ALL_ON, showFans: false }).cards.live
				?.blocks ?? [];
		expect(blocks[0].css).toBeUndefined();
		expect(blocks[1].css).toBe('[data-bn="self"]{text-align:right}');
	});

	it("隐藏掉的 data 块不会因为开关而复活", () => {
		const live: CardBlock[] = DEFAULT_CARD_LAYOUT.live.map((b) =>
			b.type === "data" ? { ...b, visible: false } : b,
		);
		const blocks =
			cardLayoutToSkin(layoutWith({ live }), undefined, { ...ALL_ON, showFans: false }).cards.live
				?.blocks ?? [];
		expect(blocks.map(builtinOf)).toEqual(["cover", "header", "title", DIVIDER_TYPE, "desc"]);
	});
});

describe("旧版式 → 卡片皮肤 — 上舰卡", () => {
	it("徽章在右:内容 1-8 列、徽章 9-12 列跨满内容的行", () => {
		const blocks = blocksOf(DEFAULT_CARD_LAYOUT, "guard");
		expect(blocks.map((b) => b.id)).toEqual(["name", "text", "badge"]);
		expect(blocks[0].grid).toEqual({ row: 1, column: 1, span: 8 });
		expect(blocks[2].grid).toEqual({ row: 1, column: 9, span: 4, rowSpan: 2 });
	});

	it("徽章那 4 列是定宽的,合起来正好 175px(徽章图的边长)", () => {
		const columns = cardLayoutToSkin(DEFAULT_CARD_LAYOUT).cards.guard?.columns ?? [];
		expect(columns).toHaveLength(12);
		expect(columns.slice(0, 8)).toEqual(Array.from({ length: 8 }, () => ({ fr: 1 })));
		const badge = columns.slice(8);
		expect(badge.every((c) => "px" in c)).toBe(true);
		expect(badge.reduce((s, c) => s + ("px" in c ? c.px : 0), 0)).toBe(175);
	});

	it("徽章在左:定宽的那 4 列跟着挪到最前", () => {
		const guard = { badgeSide: "left" as const, blocks: DEFAULT_CARD_LAYOUT.guard.blocks };
		const columns = cardLayoutToSkin(layoutWith({ guard })).cards.guard?.columns ?? [];
		expect(columns.slice(0, 4).every((c) => "px" in c)).toBe(true);
		expect(columns.slice(4)).toEqual(Array.from({ length: 8 }, () => ({ fr: 1 })));
	});

	it("内容块补回原内容列的内边距:左右恒 16,上下 12 只落在首 / 末块", () => {
		const blocks = blocksOf(DEFAULT_CARD_LAYOUT, "guard");
		expect(blocks[0].css).toBe('[data-bn="self"]{padding:12px 16px 0px;align-self:start}');
		expect(blocks[1].css).toBe('[data-bn="self"]{padding:0px 16px 12px;align-self:end}');
	});

	it("徽章那一格占满卡高、内部垂直居中、贴第一行的顶", () => {
		const blocks = blocksOf(DEFAULT_CARD_LAYOUT, "guard");
		expect(blocks[2].css).toBe(
			'[data-bn="self"]{height:190px;display:flex;align-items:center;align-self:start}',
		);
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
		// 首块的上边距被 12px 的容器内边距顶掉、贴顶;中间块只有自己的上边距;
		// 末块两样都有(自己的 8px + 容器的 12px)并贴底。三块都带镜像。
		const MIRROR = "display:flex;flex-direction:column;align-items:flex-end;text-align:right";
		expect(blocks[1].css).toBe(
			`[data-bn="self"]{padding:12px 16px 0px;align-self:start;${MIRROR}}`,
		);
		expect(blocks[2].css).toBe(`[data-bn="self"]{padding:8px 16px 0px;${MIRROR}}`);
		expect(blocks[3].css).toBe(`[data-bn="self"]{padding:8px 16px 12px;align-self:end;${MIRROR}}`);
	});
});

/**
 * 退役的渐变起 / 止色(ADR-0014 决策 15 的 🔗)。存量用户改过的颜色升级时折进派生皮肤的
 * **外框 CSS**,而不是留成变量 —— 这几条钉的是「换掉那条规则,不是再加一条」。
 */
describe("旧版式 → 卡片皮肤 — 退役的渐变色", () => {
	const G = { start: "#ff0000", end: "#00ff00" };
	const RULE = (s: string, e: string) =>
		`[data-bn="frame"]{background:var(--bn-card-bg-image,linear-gradient(to right bottom,${s},${e}))}`;
	/** 默认那张卡的整段 css,只把出厂 frame 规则换成给定的那条(玻璃层等其余规则原样跟着)。 */
	const withRule = (kind: keyof CardSkinManifest["cards"], rule: string): string =>
		(DEFAULT_CARD_SKIN.cards[kind]?.css ?? "").replace(DEFAULT_FRAME_BG_RULE, rule);

	it("不传 colors → 外框 CSS 一字不动", () => {
		expect(cardLayoutToSkin(DEFAULT_CARD_LAYOUT).cards.live?.css).toBe(
			DEFAULT_CARD_SKIN.cards.live?.css,
		);
	});

	it("全局一份颜色 → 五种吃用户色的卡外框渐变都换掉", () => {
		const skin = cardLayoutToSkin(DEFAULT_CARD_LAYOUT, undefined, undefined, { base: G });
		for (const kind of ["live", "dynamic", "roastBoard", "roastSolo", "wordcloud"] as const) {
			expect(skin.cards[kind]?.css).toBe(withRule(kind, RULE(G.start, G.end)));
		}
	});

	it("SC / 上舰不吃用户色 —— 档位色那条规则原样留着", () => {
		const skin = cardLayoutToSkin(DEFAULT_CARD_LAYOUT, undefined, undefined, { base: G });
		expect(skin.cards.sc?.css).toBe(DEFAULT_CARD_SKIN.cards.sc?.css);
		expect(skin.cards.guard?.css).toBe(DEFAULT_CARD_SKIN.cards.guard?.css);
	});

	it("按卡种给的颜色压过全局那份,其余卡种仍用全局那份", () => {
		const kindG = { start: "#111111", end: "#222222" };
		const skin = cardLayoutToSkin(DEFAULT_CARD_LAYOUT, undefined, undefined, {
			base: G,
			byKind: { live: kindG },
		});
		expect(skin.cards.live?.css).toBe(withRule("live", RULE(kindG.start, kindG.end)));
		expect(skin.cards.dynamic?.css).toBe(withRule("dynamic", RULE(G.start, G.end)));
	});

	it("**换掉**默认那条规则而不是追加 —— 整段 CSS 里只有一条 frame background", () => {
		const css = cardLayoutToSkin(DEFAULT_CARD_LAYOUT, undefined, undefined, { base: G }).cards.live
			?.css;
		expect(css?.match(/\[data-bn="frame"\]\{background:/g)?.length).toBe(1);
		expect(css).not.toContain("#e0c3fc");
	});

	it("上舰卡那条「档位渐变 + 玻璃层高度」的复合 CSS 不被颜色改动波及", () => {
		const skin = cardLayoutToSkin(DEFAULT_CARD_LAYOUT, undefined, undefined, {
			base: G,
			byKind: { guard: G },
		});
		expect(skin.cards.guard?.css).toMatch(/\[data-bn="glass"\]\{[^}]*height:190px/);
		expect(skin.cards.guard?.css).not.toContain(G.start);
	});
});
