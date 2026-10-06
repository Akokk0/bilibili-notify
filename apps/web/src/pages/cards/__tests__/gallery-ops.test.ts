import { describe, expect, it } from "vite-plus/test";
import { moveSelected, removeFromGallery, toggleSelected } from "../gallery-ops";

describe("toggleSelected", () => {
	it("appends an unselected id (selection order = rotation order)", () => {
		expect(toggleSelected(["a"], "b")).toEqual(["a", "b"]);
	});
	it("removes an already-selected id", () => {
		expect(toggleSelected(["a", "b", "c"], "b")).toEqual(["a", "c"]);
	});
	it("does not mutate the input", () => {
		const input = ["a"];
		toggleSelected(input, "b");
		expect(input).toEqual(["a"]);
	});
});

describe("removeFromGallery", () => {
	it("drops a deleted id from the current selection", () => {
		expect(removeFromGallery(["a", "b", "c"], "b")).toEqual(["a", "c"]);
	});
	it("is a no-op when the id was not selected", () => {
		expect(removeFromGallery(["a", "c"], "b")).toEqual(["a", "c"]);
	});
});

describe("moveSelected", () => {
	it("reorders the rotation sequence", () => {
		expect(moveSelected(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
	});
	it("is a no-op when from === to", () => {
		expect(moveSelected(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
	});
});
