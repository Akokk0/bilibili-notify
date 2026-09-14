/**
 * 编辑器改草稿的纯函数。
 *
 * 钉四条,各对应一个静默失败:① **回新对象不动原件** —— 就地改的话脏标与预览都察觉不到
 * (界面上值变了、预览一动不动,正是「拧了没反应」那一类);② **越界夹回边界而不是拒**
 * (数字框边敲边过,拒了就永远敲不出两位数);③ **`span` 跟着起始列收** —— 不收的话清洗器
 * 那头直接判越界,主人看到的是「保存失败」而不是「刚才那一下把它挤出去了」;④ **`rowSpan`
 * 为 1 时不写进去**(缺省就是 1,写进去只是 diff 里一行噪音)。
 */

import type { CardSkinManifest } from "@bilibili-notify/contract";
import { describe, expect, it } from "vite-plus/test";
import { blockOf, cardOf, clampInt, gridLimits, setBlockGrid } from "../skin-draft-ops";

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
