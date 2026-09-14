/**
 * 编辑器改草稿的纯函数。
 *
 * 钉四条,各对应一个静默失败:① **回新对象不动原件** —— 就地改的话脏标与预览都察觉不到
 * (界面上值变了、预览一动不动,正是「拧了没反应」那一类);② **越界夹回边界而不是拒**
 * (数字框边敲边过,拒了就永远敲不出两位数);③ **`span` 跟着起始列收** —— 不收的话清洗器
 * 那头直接判越界,主人看到的是「保存失败」而不是「刚才那一下把它挤出去了」;④ **`rowSpan`
 * 为 1 时不写进去**(缺省就是 1,写进去只是 diff 里一行噪音)。
 *
 * 增删块另钉两条:⑤ **新块的 id 与既有的撞了要让开** —— 撞了不换名的话装包门直接判
 * 「块 id 重复」,而主人看到的是保存时一句莫名其妙的报错;⑥ **删块不回收行号** ——
 * 回收等于把主人手摆好的位置全冲掉。
 */

import type { CardSkinManifest } from "@bilibili-notify/contract";
import { CARD_SKIN_LIMITS } from "@bilibili-notify/internal/constants";
import { describe, expect, it } from "vite-plus/test";
import {
	addBlock,
	addCustomBlock,
	adoptCard,
	blockOf,
	canAddBlock,
	cardOf,
	clampInt,
	columnsOf,
	dropCard,
	gridLimits,
	removeBlock,
	setBlockCss,
	setBlockGrid,
	setBlockHtml,
	setBlockShowIf,
	setColumns,
	setFrame,
	setFrameCss,
	setSkinMeta,
	skinMetaError,
} from "../skin-draft-ops";

const manifest = (): CardSkinManifest =>
	({
		schemaVersion: 1,
		name: "测试皮肤",
		cards: {
			live: {
				width: 600,
				css: "",
				blocks: [
					{ id: "cover", kind: "builtin", builtin: "cover", grid: { row: 1, column: 1, span: 12 } },
					{ id: "title", kind: "builtin", builtin: "title", grid: { row: 2, column: 1, span: 6 } },
				],
			},
		},
	}) as unknown as CardSkinManifest;

const gridOf = (m: CardSkinManifest, id: string) =>
	blockOf(cardOf(m, "live"), id)?.grid as {
		row: number;
		column: number;
		span: number;
		rowSpan?: number;
	};

describe("clampInt", () => {
	it("越界夹回边界,不是拒", () => {
		expect(clampInt(0, 1, 12)).toBe(1);
		expect(clampInt(99, 1, 12)).toBe(12);
		expect(clampInt(5, 1, 12)).toBe(5);
	});

	it("空框 / NaN 退到下限 —— 数字框清空时 Number('') 是 NaN,不能让它写进清单", () => {
		expect(clampInt(Number.NaN, 1, 12)).toBe(1);
		expect(clampInt(Number.POSITIVE_INFINITY, 1, 12)).toBe(1);
	});

	it("小数取整 —— 网格没有半列", () => {
		expect(clampInt(3.6, 1, 12)).toBe(4);
	});
});

describe("gridLimits", () => {
	it("跨列的上限跟着起始列收 —— 从第 10 列起最多跨 3 列", () => {
		expect(gridLimits({ row: 1, column: 10, span: 1 }).span.max).toBe(3);
		expect(gridLimits({ row: 1, column: 1, span: 1 }).span.max).toBe(12);
	});
});

describe("setBlockGrid", () => {
	it("回的是新清单,原件一个字节都没动", () => {
		const before = manifest();
		const snapshot = JSON.stringify(before);
		const after = setBlockGrid(before, "live", "title", { column: 3 });
		expect(JSON.stringify(before)).toBe(snapshot);
		expect(after).not.toBe(before);
		expect(gridOf(after, "title").column).toBe(3);
	});

	it("没动到的块原样带着走", () => {
		const after = setBlockGrid(manifest(), "live", "title", { column: 3 });
		expect(gridOf(after, "cover")).toEqual({ row: 1, column: 1, span: 12 });
	});

	it("起始列往右推 → 跨列跟着收,而不是留个越界的数等保存时报错", () => {
		const after = setBlockGrid(manifest(), "live", "cover", { column: 10 });
		expect(gridOf(after, "cover")).toEqual({ row: 1, column: 10, span: 3 });
	});

	it("越界的输入夹回边界", () => {
		const after = setBlockGrid(manifest(), "live", "title", { row: 0, span: 99 });
		expect(gridOf(after, "title").row).toBe(1);
		expect(gridOf(after, "title").span).toBe(12);
	});

	it("rowSpan 为 1 时不落进清单;大于 1 才写", () => {
		const one = setBlockGrid(manifest(), "live", "title", { rowSpan: 1 });
		expect("rowSpan" in gridOf(one, "title")).toBe(false);
		const two = setBlockGrid(manifest(), "live", "title", { rowSpan: 2 });
		expect(gridOf(two, "title").rowSpan).toBe(2);
	});

	it("这套皮肤没定义这种卡 → 原样返回(别凭空造一张出来)", () => {
		const before = manifest();
		expect(setBlockGrid(before, "sc", "title", { row: 2 })).toBe(before);
	});

	it("块 id 对不上 → 清单内容不变", () => {
		const before = manifest();
		const after = setBlockGrid(before, "live", "没这个块", { row: 2 });
		expect(JSON.stringify(after)).toBe(JSON.stringify(before));
	});
});

describe("addBlock", () => {
	it("新块落在最后一行的下一行、整宽 —— 「空行往这儿放」那句话的兑现", () => {
		const added = addBlock(manifest(), "live", "desc");
		if (!added) throw new Error("这张卡还加得下,不该回 null");
		expect(gridOf(added.manifest, added.blockId)).toEqual({ row: 3, column: 1, span: 12 });
	});

	it("id 与既有块撞了就带后缀 —— 撞了不换名的话装包门直接判「块 id 重复」", () => {
		const once = addBlock(manifest(), "live", "title");
		if (!once) throw new Error("加得下");
		expect(once.blockId).toBe("title-2");
		const twice = addBlock(once.manifest, "live", "title");
		expect(twice?.blockId).toBe("title-3");
	});

	it("回的是新清单,原件一个字节都没动", () => {
		const before = manifest();
		const snapshot = JSON.stringify(before);
		const added = addBlock(before, "live", "desc");
		expect(JSON.stringify(before)).toBe(snapshot);
		expect(added?.manifest).not.toBe(before);
	});

	it("一块都没有的卡 → 落在第 1 行", () => {
		const empty = manifest();
		(empty.cards.live as { blocks: unknown[] }).blocks = [];
		expect(
			gridOf(addBlock(empty, "live", "cover")?.manifest as CardSkinManifest, "cover").row,
		).toBe(1);
	});

	it("满了就加不进去 —— canAddBlock 与 addBlock 说的是同一句话", () => {
		const full = manifest();
		(full.cards.live as { blocks: unknown[] }).blocks = Array.from(
			{ length: CARD_SKIN_LIMITS.maxBlocks },
			(_, i) => ({
				id: `b${i}`,
				kind: "builtin",
				builtin: "divider",
				grid: { row: i + 1, column: 1, span: 12 },
			}),
		);
		expect(canAddBlock(cardOf(full, "live"))).toBe(false);
		expect(addBlock(full, "live", "desc")).toBe(null);
	});

	it("这套皮肤没定义这种卡 → 回 null(别凭空造一张出来)", () => {
		expect(addBlock(manifest(), "sc", "amount")).toBe(null);
		expect(canAddBlock(cardOf(manifest(), "sc"))).toBe(false);
	});
});

describe("removeBlock", () => {
	it("删掉选中那块,其余原样带着走", () => {
		const after = removeBlock(manifest(), "live", "title");
		expect(cardOf(after, "live")?.blocks.map((b) => b.id)).toEqual(["cover"]);
		expect(gridOf(after, "cover")).toEqual({ row: 1, column: 1, span: 12 });
	});

	it("回的是新清单,原件一个字节都没动", () => {
		const before = manifest();
		const snapshot = JSON.stringify(before);
		const after = removeBlock(before, "live", "title");
		expect(JSON.stringify(before)).toBe(snapshot);
		expect(after).not.toBe(before);
	});

	it("id 对不上 / 没这种卡 → 原样返回", () => {
		const before = manifest();
		expect(removeBlock(before, "live", "没这个块")).toBe(before);
		expect(removeBlock(before, "sc", "amount")).toBe(before);
	});
});

describe("setFrame", () => {
	it("卡宽夹在门里 —— 越界的数落进清单,主人看到的是保存时一句报错", () => {
		expect(cardOf(setFrame(manifest(), "live", { width: 99 }), "live")?.width).toBe(
			CARD_SKIN_LIMITS.width.min,
		);
		expect(cardOf(setFrame(manifest(), "live", { width: 9999 }), "live")?.width).toBe(
			CARD_SKIN_LIMITS.width.max,
		);
	});

	it("间距写 0 = 把键删掉 —— 0 与不写在出图上同义,留个 0 只是 diff 里的噪音", () => {
		const withGap = setFrame(manifest(), "live", { gapRow: 12 });
		expect(cardOf(withGap, "live")?.gap).toEqual({ row: 12 });
		const back = setFrame(withGap, "live", { gapRow: 0 });
		expect("gap" in (cardOf(back, "live") as object)).toBe(false);
	});

	it("只改行距时列距原样留着", () => {
		const both = setFrame(manifest(), "live", { gapRow: 8, gapColumn: 6 });
		const after = setFrame(both, "live", { gapRow: 10 });
		expect(cardOf(after, "live")?.gap).toEqual({ row: 10, column: 6 });
	});

	it("回的是新清单,原件一个字节都没动;没这种卡就原样返回", () => {
		const before = manifest();
		const snapshot = JSON.stringify(before);
		const after = setFrame(before, "live", { width: 500 });
		expect(JSON.stringify(before)).toBe(snapshot);
		expect(after).not.toBe(before);
		expect(setFrame(before, "sc", { width: 500 })).toBe(before);
	});
});

describe("columnsOf / setColumns", () => {
	it("没写 columns 时算出来的是 12 等分 —— 编辑器照它画那 12 行", () => {
		expect(columnsOf(cardOf(manifest(), "live"))).toEqual(
			Array.from({ length: CARD_SKIN_LIMITS.columns }, () => ({ fr: 1 })),
		);
	});

	it("传 undefined = 删掉整份 columns(回到 12 等分)", () => {
		const custom = setColumns(manifest(), "live", [{ px: 40 }]);
		expect(cardOf(custom, "live")?.columns).toHaveLength(CARD_SKIN_LIMITS.columns);
		const back = setColumns(custom, "live", undefined);
		expect("columns" in (cardOf(back, "live") as object)).toBe(false);
	});

	it("不足 12 项就补等分、超了就截断 —— 装包门只收恰好 12 项", () => {
		const short = setColumns(manifest(), "live", [{ px: 40 }, { fr: 2 }]);
		const cols = cardOf(short, "live")?.columns;
		expect(cols).toHaveLength(CARD_SKIN_LIMITS.columns);
		expect(cols?.[0]).toEqual({ px: 40 });
		expect(cols?.[1]).toEqual({ fr: 2 });
		expect(cols?.[11]).toEqual({ fr: 1 });
	});

	it("越界的列宽夹回门里,px 收到两位小数", () => {
		const cols = cardOf(
			setColumns(manifest(), "live", [{ px: 43.756 }, { fr: 99 }]),
			"live",
		)?.columns;
		expect(cols?.[0]).toEqual({ px: 43.76 });
		expect(cols?.[1]).toEqual({ fr: CARD_SKIN_LIMITS.columns });
	});
});

describe("setBlockCss / setFrameCss", () => {
	const CSS = '[data-bn="self"]{color:red}';

	it("写进去的就是那一份;清空 = 把键删掉(清洗器那头也把洗空的当没写)", () => {
		const withCss = setBlockCss(manifest(), "live", "title", CSS);
		expect(blockOf(cardOf(withCss, "live"), "title")?.css).toBe(CSS);
		const cleared = setBlockCss(withCss, "live", "title", "   ");
		expect("css" in (blockOf(cardOf(cleared, "live"), "title") as object)).toBe(false);
	});

	it("外框 CSS 同理", () => {
		const withCss = setFrameCss(manifest(), "live", CSS);
		expect(cardOf(withCss, "live")?.css).toBe(CSS);
		expect("css" in (cardOf(setFrameCss(withCss, "live", ""), "live") as object)).toBe(false);
	});

	it("回的是新清单,原件一个字节都没动;对不上的块 / 卡原样返回", () => {
		const before = manifest();
		const snapshot = JSON.stringify(before);
		expect(setBlockCss(before, "live", "title", CSS)).not.toBe(before);
		expect(JSON.stringify(before)).toBe(snapshot);
		expect(setBlockCss(before, "live", "没这个块", CSS)).toBe(before);
		expect(setBlockCss(before, "sc", "title", CSS)).toBe(before);
		expect(setFrameCss(before, "sc", CSS)).toBe(before);
	});
});

describe("setBlockShowIf", () => {
	it("选一个字段就写进去,选「总是显示」把键删掉", () => {
		const gated = setBlockShowIf(manifest(), "live", "title", "live.isStreaming");
		expect(blockOf(cardOf(gated, "live"), "title")?.showIf).toBe("live.isStreaming");
		const always = setBlockShowIf(gated, "live", "title", undefined);
		expect("showIf" in (blockOf(cardOf(always, "live"), "title") as object)).toBe(false);
	});

	it("回的是新清单,原件一个字节都没动;对不上的块 / 卡原样返回", () => {
		const before = manifest();
		const snapshot = JSON.stringify(before);
		expect(setBlockShowIf(before, "live", "title", "live.isEnded")).not.toBe(before);
		expect(JSON.stringify(before)).toBe(snapshot);
		expect(setBlockShowIf(before, "live", "没这个块", "live.isEnded")).toBe(before);
		expect(setBlockShowIf(before, "sc", "title", "live.isEnded")).toBe(before);
	});
});

describe("addCustomBlock / setBlockHtml", () => {
	it("自定义块也落在最底下那一行,自带一段能看见的起手 HTML", () => {
		const added = addCustomBlock(manifest(), "live");
		if (!added) throw new Error("加得下");
		const block = blockOf(cardOf(added.manifest, "live"), added.blockId);
		expect(block?.kind).toBe("custom");
		expect((block as { html: string }).html.trim()).not.toBe("");
		expect(gridOf(added.manifest, added.blockId)).toEqual({ row: 3, column: 1, span: 12 });
	});

	it("第二个自定义块换个 id —— 撞名在装包门那头是「块 id 重复」", () => {
		const one = addCustomBlock(manifest(), "live");
		if (!one) throw new Error("加得下");
		const two = addCustomBlock(one.manifest, "live");
		expect(two?.blockId).not.toBe(one.blockId);
	});

	it("改 HTML → 写进那一块;内置块没有 html 可改,原样返回", () => {
		const one = addCustomBlock(manifest(), "live");
		if (!one) throw new Error("加得下");
		const edited = setBlockHtml(one.manifest, "live", one.blockId, "<div>{up.name}</div>");
		expect((blockOf(cardOf(edited, "live"), one.blockId) as { html: string }).html).toBe(
			"<div>{up.name}</div>",
		);
		expect(setBlockHtml(edited, "live", "title", "<div>x</div>")).toBe(edited);
	});
});

describe("adoptCard / dropCard", () => {
	const source = () => cardOf(manifest(), "live") as NonNullable<ReturnType<typeof cardOf>>;

	it("接管:把出厂那张卡整份抄进来,而且连块都是新的一份(不是同一批对象)", () => {
		const src = source();
		const after = adoptCard(manifest(), "sc", src);
		expect(cardOf(after, "sc")?.blocks).toHaveLength(2);
		// 钉的是**引用**:源是 react-query 缓存里出厂皮肤的那一份,共用同一批块对象的话,
		// 哪天有人写了个就地改的 op,改的就是缓存里的出厂皮肤。
		expect(cardOf(after, "sc")).not.toBe(src);
		expect(cardOf(after, "sc")?.blocks[0]).not.toBe(src.blocks[0]);
	});

	it("已经有这种卡就不动它 —— 接管只对空着的卡种开口", () => {
		const before = manifest();
		expect(adoptCard(before, "live", source())).toBe(before);
	});

	it("交还:整张卡从清单里消失(出图时跟着出厂默认)", () => {
		const before = manifest();
		const after = dropCard(before, "live");
		expect("live" in after.cards).toBe(false);
		expect(dropCard(after, "live")).toBe(after);
		expect(JSON.stringify(before)).toBe(JSON.stringify(manifest()));
	});
});

/**
 * 皮肤级的元信息(名字 / 作者 / 说明)。装皮肤时定下的名字从前**再也改不了** ——
 * 编辑器与皮肤库都没有入口。
 *
 * 钉三条静默失败:① 可选的两项留空要**删键**(留个空串,皮肤库那行就显示一个空作者 /
 * 空说明,看着像坏了);② 名字留空**照样存进草稿**,让上层当场说「皮肤得有个名字」——
 * 悄悄保留旧名的话,主人会看到一个「怎么删都弹回去」的框;③ patch 语义,没给的键不动。
 */
describe("setSkinMeta", () => {
	it("改名回一份新的,原件一个字没动", () => {
		const before = manifest();
		const after = setSkinMeta(before, { name: "青柠" });
		expect(after.name).toBe("青柠");
		expect(before.name).toBe("测试皮肤");
		expect(after).not.toBe(before);
	});

	it("作者 / 说明留空 → 删键(不是存个空串)", () => {
		const withMeta = setSkinMeta(manifest(), { author: "伦伦酱", description: "试的" });
		expect(withMeta.author).toBe("伦伦酱");
		expect(withMeta.description).toBe("试的");

		const cleared = setSkinMeta(withMeta, { author: "  ", description: "" });
		expect("author" in cleared).toBe(false);
		expect("description" in cleared).toBe(false);
	});

	it("名字留空照样落进草稿 —— 拦是上层的事,不在这儿偷偷弹回去", () => {
		expect(setSkinMeta(manifest(), { name: "" }).name).toBe("");
	});

	it("没给的键不动", () => {
		const withAuthor = setSkinMeta(manifest(), { author: "伦伦酱" });
		const renamed = setSkinMeta(withAuthor, { name: "青柠" });
		expect(renamed.author).toBe("伦伦酱");
		expect(renamed.cards.live?.blocks).toHaveLength(2);
	});
});

/**
 * 存不存得下去 —— 保存钮照它变灰。**不能让主人按下去吃一个 400**:装包门那头只会回
 * 一句「name: 太短」,而主人根本不知道是哪儿的名字(块也有 id、字体也有 family)。
 */
describe("skinMetaError", () => {
	it("名字空了 / 全是空格 → 说出是哪儿不对", () => {
		expect(skinMetaError(setSkinMeta(manifest(), { name: "" }))).toBe("皮肤得有个名字");
		expect(skinMetaError(setSkinMeta(manifest(), { name: "   " }))).toBe("皮肤得有个名字");
	});

	it.each([
		["name", "皮肤名", CARD_SKIN_LIMITS.name.max],
		["author", "作者", CARD_SKIN_LIMITS.author.max],
		["description", "说明", CARD_SKIN_LIMITS.description.max],
	])("%s 超上限 → 说出是哪一项、超了多少(三个框都不截断)", (key, label, max) => {
		const long = "绫".repeat(max + 1);
		const err = skinMetaError(setSkinMeta(manifest(), { [key]: long }));
		expect(err).toContain(label);
		expect(err).toContain(String(max));
	});

	it("正常的皮肤没有错", () => {
		expect(skinMetaError(manifest())).toBeNull();
	});
});
