/**
 * **格子层**(ADR-0018)—— 画布画的那个矩形,DOM 里得真有一个盒子与它同宽同高。
 *
 * 这是那道**常驻门**。它钉的是**结构**,不是几何:门禁跑 jsdom,而 jsdom 没有布局引擎
 * (`getBoundingClientRect()` 一律回 0,ADR-0014 决策 20 把拖拽几何拆成纯函数正是为此),
 * 这里量不出任何一个盒子有多宽。
 *
 * 几何那一半归**本机那道门**:`node .bn-design/pixel-gate/cell-identity.mjs` —— 真 Chrome
 * 拿这 23 份字节基准逐块比「轨道 + 跨度算出来的格子」与 `[data-cell]` 的 rect。它与像素门
 * 并排住在那个**不入库**的目录里(需要本机 Chrome,CI 的干净安装没有),改完渲染器的落位
 * 或对齐要手动跑一次。2026-09-20 首次跑通 23/23;验红:拿掉 `place-self:stretch` 重打基准
 * 之后是 20/23。
 *
 * 两层各管一件事:
 *
 * - **外层 `[data-cell]`** 是格子。网格坐标与层次注在它身上(**限高的高度不在** ——
 *   见下面那条的理由),而它**皮肤够不着**:清洗器强制每条块 CSS 以 `[data-bn="self"]`
 *   打头,渲染器把 `self` 翻成
 *   `.bn-blk-<id>`,而那个 class 挂在内层。所以「class 在内层」是本门最要紧的一条,
 *   不是风格问题:class 一旦挪到外层,皮肤写一句 `justify-self:start` 就能把格子捏小,
 *   恒等当场没了。
 * - **内层** 是皮肤的自留地:`data-block`、`.bn-blk-<id>`、资产变量都在这里,皮肤想
 *   收缩、想溢出,随它 —— ADR-0018 决策 1 明说内容溢不溢出不归画布管。
 *
 * 验红:把外层那一层删掉、或把网格坐标注回内层,这一组必须整片红。
 */

import { type CardSkinCard, DEFAULT_CARD_SKIN } from "@bilibili-notify/internal";
import { renderToString } from "@vue/server-renderer";
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { createSSRApp } from "vue";
import { CARD_FIXTURES } from "../../__tests__/fixtures/card-fixtures";
import type { GuardCardProps } from "../../templates/guard-card";
import type { LiveCardProps } from "../../templates/live-card";
import { renderSkinnedCard } from "../render-skin";

let liveProps: LiveCardProps;
let guardProps: GuardCardProps;

beforeAll(async () => {
	const live = CARD_FIXTURES.find((f) => f.name === "live-streaming");
	const guard = CARD_FIXTURES.find((f) => f.name === "guard-captain");
	if (!live || !guard) throw new Error("夹具表里少了 live-streaming / guard-captain");
	liveProps = (await live.build()).props as unknown as LiveCardProps;
	guardProps = (await guard.build()).props as unknown as GuardCardProps;
});

const builtin = (
	id: string,
	name: string,
	grid: CardSkinCard["blocks"][number]["grid"],
	over: Record<string, unknown> = {},
): CardSkinCard["blocks"][number] =>
	({ id, kind: "builtin", builtin: name, grid, ...over }) as CardSkinCard["blocks"][number];

async function liveDoc(blocks: CardSkinCard["blocks"]): Promise<Document> {
	const { vnode } = renderSkinnedCard({
		kind: "live",
		card: { width: 600, blocks },
		props: liveProps,
	});
	return new JSDOM(await renderToString(createSSRApp({ render: () => vnode }))).window.document;
}

/** 外层那个盒子的 inline style。 */
const cellStyle = (doc: Document, id: string): string =>
	doc.querySelector(`[data-cell="${id}"]`)?.getAttribute("style") ?? "";

/** 内层(皮肤的自留地)那个盒子的 inline style。 */
const innerStyle = (doc: Document, id: string): string =>
	doc.querySelector(`.bn-blk-${id}`)?.getAttribute("style") ?? "";

describe("格子层 — 一块两层", () => {
	it("外层挂 data-cell=<块 id>,内层挂 data-block 与 .bn-blk-<id>", async () => {
		const doc = await liveDoc([builtin("t", "title", { row: 2, column: 3, span: 4 })]);
		const cell = doc.querySelector('[data-cell="t"]');
		expect(cell).not.toBeNull();
		const inner = cell?.firstElementChild;
		expect(inner?.getAttribute("data-block")).toBe("title");
		expect(inner?.className).toBe("bn-blk-t");
	});

	// 这一条是恒等的根:class 一旦挪到外层,皮肤的 `[data-bn="self"]` 规则就直接改格子。
	it("外层不带那个 class —— 皮肤的 self 规则结构上选不中它", async () => {
		const doc = await liveDoc([builtin("t", "title", { row: 1, column: 1, span: 6 })]);
		expect(doc.querySelector('[data-cell="t"]')?.className).toBe("");
		expect(doc.querySelector(".bn-blk-t")?.hasAttribute("data-cell")).toBe(false);
	});

	it("网格坐标只在外层,内层一个字节都没有", async () => {
		const doc = await liveDoc([builtin("t", "title", { row: 2, column: 3, span: 4 })]);
		// 行号被压成 1(第 2 行是唯一一行);列与跨度原样 —— 画布算格子用的就是这对数。
		expect(cellStyle(doc, "t")).toContain("grid-row:1 / span 1");
		expect(cellStyle(doc, "t")).toContain("grid-column:3 / span 4");
		expect(innerStyle(doc, "t")).not.toContain("grid-row");
		expect(innerStyle(doc, "t")).not.toContain("grid-column");
	});

	// 外层得是网格容器,内层才仍然是 grid item —— 皮肤写的 `justify-self` / `align-self`
	// 参照系一样大,行为与今天一字不差。
	it("外层是网格容器,两层都带 min-width:0", async () => {
		const doc = await liveDoc([builtin("t", "title", { row: 1, column: 1, span: 6 })]);
		expect(cellStyle(doc, "t")).toContain("display:grid");
		expect(cellStyle(doc, "t")).toContain("min-width:0");
		expect(innerStyle(doc, "t")).toContain("min-width:0");
	});

	/**
	 * 🔴 这两句是 2026-09-20 真机量出来的,当时 5 张卡的像素红了 —— 少一句就不是
	 * 「多包一层」而是**改外观**,而两道门里只有本机那道几何门看得见。
	 *
	 * - `place-self:stretch`:外框写了 `align-items:center`(上舰卡的玻璃层正是)时,
	 *   格子层不显式 stretch 就缩成内容高再居中,它就不再等于格子了 —— 实测上舰卡的
	 *   用户名胶囊从「贴行底 y=20」变成「整格居中 y=10」。
	 * - `place-items:inherit`:把外框的默认对齐透给内层。不写的话,没有自己写
	 *   `align-self` 的块会从「跟着外框居中」变成「填满格子」。
	 */
	it("外层显式 place-self:stretch + place-items:inherit", async () => {
		const doc = await liveDoc([builtin("t", "title", { row: 1, column: 1, span: 6 })]);
		expect(cellStyle(doc, "t")).toContain("place-self:stretch");
		expect(cellStyle(doc, "t")).toContain("place-items:inherit");
	});
});

describe("格子层 — 哪些声明跟着搬到外层", () => {
	// 内层的 z-index 只在外层那一格里生效,压不过隔壁块 —— 搬错层这条会红。
	it("层次注在外层", async () => {
		const doc = await liveDoc([
			builtin("t", "title", { row: 1, column: 1, span: 6, z: 3 } as never),
		]);
		expect(cellStyle(doc, "t")).toContain("z-index:3");
		expect(innerStyle(doc, "t")).not.toContain("z-index");
	});

	it("不写层次 → 两层都一个 z-index 都没有", async () => {
		const doc = await liveDoc([builtin("t", "title", { row: 1, column: 1, span: 6 })]);
		// ⚠️ 先证明这两层**真的存在**:没有外层时 `cellStyle` 回空串,底下两条
		// 「不含 z-index」不做任何事就过了(断言「不出现」时最常见的那种假绿)。
		expect(cellStyle(doc, "t")).toContain("grid-column");
		expect(innerStyle(doc, "t")).toContain("min-width:0");
		expect(cellStyle(doc, "t")).not.toContain("z-index");
		expect(innerStyle(doc, "t")).not.toContain("z-index");
	});

	/**
	 * 🔴 限高**留在内层**,不跟 `z` 一起搬上去(2026-09-20 实测改判 ADR-0018 决策 2 原文)。
	 * 搬上去的话内层会 `stretch`,把自己的外边距从高度里扣掉 —— 动态卡封面实测 336 → 332,
	 * 整张卡短了 4px。而且它本来就是**块**声明自己多高,格子的高度归行轨道。
	 */
	it("限高(heightFromRows)的高度留在内层,不搬去格子层", async () => {
		const doc = await liveDoc([builtin("c", "cover", { row: 1, column: 1, span: 12, rowSpan: 3 })]);
		expect(innerStyle(doc, "c")).toContain("height:168px");
		expect(cellStyle(doc, "c")).toContain("grid-row:1 / span 3");
		expect(cellStyle(doc, "c")).not.toContain("height:");
	});

	// 资产变量是给皮肤 CSS 用的,皮肤写在内层,变量就得在内层(或它的祖先)—— 留在内层,
	// 与 class 同一个元素,和今天一样。
	it("资产变量留在内层", async () => {
		// 解析不出的资产**一个字节都不注**(`assetVarsStyle` 那条规矩),所以这条必须真给
		// 一个能解析的 `resolveAsset` —— 不给的话两条断言都对着空串过,是假绿。
		const { vnode } = renderSkinnedCard({
			kind: "live",
			card: {
				width: 600,
				blocks: [
					builtin("t", "title", { row: 1, column: 1, span: 6 }, { assets: { bg: "asset:a.png" } }),
				],
			},
			props: liveProps,
			resolveAsset: () => "data:image/png;base64,AAAA",
		});
		const doc = new JSDOM(await renderToString(createSSRApp({ render: () => vnode }))).window
			.document;
		expect(innerStyle(doc, "t")).toContain("--bn-asset-bg:");
		expect(cellStyle(doc, "t")).toContain("grid-column");
		expect(cellStyle(doc, "t")).not.toContain("--bn-asset-bg:");
	});
});

describe("格子层 — 自带 data-block 的块", () => {
	// 上舰徽章的块根自带 `data-block="badge"`,今天靠 `selfLabelled` 躲开「一块两个
	// data-block」。加了外层之后这个特例照旧成立:外层挂的是 data-cell,不是 data-block。
	it("上舰徽章:外层是 data-cell,DOM 里仍只有一个 [data-block]", async () => {
		const { vnode } = renderSkinnedCard({
			kind: "guard",
			card: DEFAULT_CARD_SKIN.cards.guard as CardSkinCard,
			props: guardProps,
		});
		const doc = new JSDOM(await renderToString(createSSRApp({ render: () => vnode }))).window
			.document;
		expect(doc.querySelectorAll('[data-block="badge"]')).toHaveLength(1);
		const cell = doc.querySelector('[data-cell="badge"]');
		expect(cell).not.toBeNull();
		expect(cell?.hasAttribute("data-block")).toBe(false);
		expect(cell?.getAttribute("style")).toContain("grid-column:9 / span 4");
	});

	// 出厂皮肤每一块都得有自己的格子 —— 少一个就是画布上有个框在 DOM 里没有对应物。
	it("出厂上舰卡的五个块,一块一个格子层", async () => {
		const { vnode } = renderSkinnedCard({
			kind: "guard",
			card: DEFAULT_CARD_SKIN.cards.guard as CardSkinCard,
			props: guardProps,
		});
		const doc = new JSDOM(await renderToString(createSSRApp({ render: () => vnode }))).window
			.document;
		expect(
			[...doc.querySelectorAll("[data-cell]")].map((el) => el.getAttribute("data-cell")),
		).toEqual(["avatar", "user", "master", "text", "badge"]);
	});
});
