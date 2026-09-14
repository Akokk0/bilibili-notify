import { describe, expect, it } from "vite-plus/test";
import { appearanceOnly, hasAppearanceOverride, omitCover, pickCover } from "../style-partition";

// 数据区那三个 show 键 2026-09-14 已退役(ADR-0014 决策 16 的 🔗),字段族从三套减到
// 两套 —— 这份夹具里只剩外观与封面。
const FULL = {
	font: "Full Sans",
	fontAsset: "full.woff2",
	glassClear: true,
	backgroundImages: ["bg1"],
	liveCoverImages: ["cover1", "cover2"],
};

describe("style-partition 字段族拣取", () => {
	it("pickCover 只取封面键", () => {
		expect(pickCover(FULL)).toEqual({ liveCoverImages: ["cover1", "cover2"] });
		expect(pickCover(undefined)).toEqual({});
		expect(pickCover({})).toEqual({});
	});

	it("omitCover 只去封面,外观那几件原样留下", () => {
		const noCover = omitCover(FULL);
		expect(noCover.liveCoverImages).toBeUndefined();
		expect(noCover.font).toBe("Full Sans");
		expect(noCover.backgroundImages).toEqual(["bg1"]);
	});

	it("appearanceOnly 剥掉封面,只留字体/玻璃/背景图", () => {
		const c = appearanceOnly(FULL);
		expect(c).toEqual({
			font: "Full Sans",
			fontAsset: "full.woff2",
			glassClear: true,
			backgroundImages: ["bg1"],
		});
	});

	it("hasAppearanceOverride:纯封面覆盖不算外观覆盖", () => {
		expect(hasAppearanceOverride({ liveCoverImages: ["a"] })).toBe(false);
		expect(hasAppearanceOverride({ font: "F0 Sans" })).toBe(true);
		expect(hasAppearanceOverride({ font: "F0 Sans", liveCoverImages: ["a"] })).toBe(true);
		expect(hasAppearanceOverride(undefined)).toBe(false);
	});
});
