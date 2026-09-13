import { describe, expect, it } from "vite-plus/test";
import {
	appearanceOnly,
	hasAppearanceOverride,
	omitCover,
	omitShow,
	pickCover,
	pickShow,
} from "../style-partition";

const FULL = {
	font: "Full Sans",
	fontAsset: "full.woff2",
	glassClear: true,
	showPopularity: false,
	showArea: true,
	showFans: false,
	backgroundImages: ["bg1"],
	liveCoverImages: ["cover1", "cover2"],
};

describe("style-partition 字段族拣取", () => {
	it("pickShow 只取 show 三键;pickCover 只取封面键", () => {
		expect(pickShow(FULL)).toEqual({ showPopularity: false, showArea: true, showFans: false });
		expect(pickCover(FULL)).toEqual({ liveCoverImages: ["cover1", "cover2"] });
		expect(pickShow(undefined)).toEqual({});
		expect(pickCover({})).toEqual({});
	});

	it("omitShow 只去 show(保留封面);omitCover 只去封面(保留 show)", () => {
		const noShow = omitShow(FULL);
		expect(noShow.showPopularity).toBeUndefined();
		expect(noShow.liveCoverImages).toEqual(["cover1", "cover2"]);
		const noCover = omitCover(FULL);
		expect(noCover.liveCoverImages).toBeUndefined();
		expect(noCover.showArea).toBe(true);
	});

	it("appearanceOnly 同时剥掉 show 与封面,只留字体/玻璃/背景图", () => {
		const c = appearanceOnly(FULL);
		expect(c).toEqual({
			font: "Full Sans",
			fontAsset: "full.woff2",
			glassClear: true,
			backgroundImages: ["bg1"],
		});
	});

	it("hasAppearanceOverride:纯封面覆盖或纯 show 覆盖都不算外观覆盖", () => {
		expect(hasAppearanceOverride({ liveCoverImages: ["a"] })).toBe(false);
		expect(hasAppearanceOverride({ showFans: false })).toBe(false);
		expect(hasAppearanceOverride({ showFans: false, liveCoverImages: ["a"] })).toBe(false);
		expect(hasAppearanceOverride({ font: "F0 Sans" })).toBe(true);
		expect(hasAppearanceOverride(undefined)).toBe(false);
	});
});
