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
	blockOf,
	canAddBlock,
	cardOf,
	clampInt,
	columnsOf,
	gridLimits,
	removeBlock,
	setBlockGrid,
	setColumns,
	setFrame,
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
