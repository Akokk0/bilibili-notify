import { describe, expect, it } from "vite-plus/test";
import type { CardBlockFull } from "../../../types/domain";
import { moveBlock, toggleBlockVisible } from "../layout-ops";

const blocks: CardBlockFull[] = [
	{ id: "a", visible: true },
	{ id: "b", visible: true },
	{ id: "c", visible: true },
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

	it("does not mutate the input array", () => {
		toggleBlockVisible(blocks, "b");
		expect(blocks.find((x) => x.id === "b")?.visible).toBe(true);
	});
});
