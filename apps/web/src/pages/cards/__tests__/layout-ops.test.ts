import { describe, expect, it } from "vite-plus/test";
import type { CardBlockFull } from "../../../types/domain";
import {
	addDivider,
	DIVIDER_TYPE,
	moveBlock,
	removeBlock,
	setBlockMargin,
	toggleBlockVisible,
} from "../layout-ops";

const blocks: CardBlockFull[] = [
	{ id: "a", type: "a", visible: true },
	{ id: "b", type: "b", visible: true },
	{ id: "c", type: "c", visible: true },
];

describe("moveBlock", () => {
	it("moves a block from one index to another, preserving the rest", () => {
		expect(moveBlock(blocks, 0, 2).map((b) => b.id)).toEqual(["b", "c", "a"]);
		expect(moveBlock(blocks, 2, 0).map((b) => b.id)).toEqual(["c", "a", "b"]);
	});

	it("does not mutate the input array", () => {
		moveBlock(blocks, 0, 2);
		expect(blocks.map((b) => b.id)).toEqual(["a", "b", "c"]);
	});

	it("is a no-op when from === to", () => {
		expect(moveBlock(blocks, 1, 1).map((b) => b.id)).toEqual(["a", "b", "c"]);
	});
});

describe("toggleBlockVisible", () => {
	it("flips only the targeted block's visibility", () => {
		const out = toggleBlockVisible(blocks, "b");
		expect(out.find((x) => x.id === "b")?.visible).toBe(false);
		expect(out.find((x) => x.id === "a")?.visible).toBe(true);
		expect(out.find((x) => x.id === "c")?.visible).toBe(true);
	});
});

describe("addDivider", () => {
	it("appends a visible divider with a unique sequential id", () => {
		const out = addDivider(blocks);
		const last = out[out.length - 1];
		expect(last).toMatchObject({ id: "divider-1", type: DIVIDER_TYPE, visible: true });
	});

	it("bumps the divider number past existing dividers", () => {
		const withDiv = addDivider(blocks); // divider-1
		const out = addDivider(withDiv);
		expect(out[out.length - 1].id).toBe("divider-2");
	});
});

describe("removeBlock", () => {
	it("removes the block with the given id, leaving the rest", () => {
		const out = removeBlock(blocks, "b");
		expect(out.map((x) => x.id)).toEqual(["a", "c"]);
	});
});

describe("setBlockMargin", () => {
	it("sets the top margin on the targeted block only", () => {
		const out = setBlockMargin(blocks, "b", 16);
		expect(out.find((x) => x.id === "b")?.marginTop).toBe(16);
		expect(out.find((x) => x.id === "a")?.marginTop).toBeUndefined();
	});

	it("clears the margin when value is undefined", () => {
		const withMargin = setBlockMargin(blocks, "b", 8);
		const out = setBlockMargin(withMargin, "b", undefined);
		expect(out.find((x) => x.id === "b")?.marginTop).toBeUndefined();
	});
});
