import { describe, expect, it } from "vite-plus/test";
import {
	moveSelected,
	removeAssetFromByKind,
	removeAssetFromStyle,
	removeFromGallery,
	toggleSelected,
} from "../gallery-ops";

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

// ---- 删盘清扫:资产删除后从样式对象的图列表里剔除该 id(见 Cards 页 sweep) ----

describe("removeAssetFromStyle", () => {
	it("从 liveCoverImages 里剔除", () => {
		expect(removeAssetFromStyle({ liveCoverImages: ["g", "r"] }, "g")).toEqual({
			liveCoverImages: ["r"],
		});
	});
	it("缺省字段保持缺省(不凭空造数组),其余键原样保留", () => {
		const style: { font: string; liveCoverImages?: string[] } = { font: "F0 Sans" };
		const out = removeAssetFromStyle(style, "g") as Record<string, unknown>;
		expect(out).toEqual({ font: "F0 Sans" });
		expect("liveCoverImages" in out).toBe(false);
	});
	it("未引用时返回等值对象", () => {
		expect(removeAssetFromStyle({ liveCoverImages: ["a"] }, "x")).toEqual({
			liveCoverImages: ["a"],
		});
	});
});

describe("removeAssetFromByKind", () => {
	it("逐 kind 清扫图列表,非列表键不动", () => {
		expect(
			removeAssetFromByKind(
				{
					live: { liveCoverImages: ["g"], font: "F0 Sans" },
					dynamic: { liveCoverImages: ["g", "r"] },
					sc: { fontAsset: "sc.woff2" },
				},
				"g",
			),
		).toEqual({
			live: { liveCoverImages: [], font: "F0 Sans" },
			dynamic: { liveCoverImages: ["r"] },
			sc: { fontAsset: "sc.woff2" },
		});
	});
});
