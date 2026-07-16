import { describe, expect, it } from "vite-plus/test";
import {
	colorOnly,
	hasColorOverride,
	omitCover,
	omitShow,
	pickCover,
	pickShow,
} from "../style-partition";

const FULL = {
	cardColorStart: "#111",
	cardColorEnd: "#222",
	font: "f",
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

	it("colorOnly 同时剥掉 show 与封面,只留颜色/玻璃/背景/字体", () => {
		const c = colorOnly(FULL);
		expect(c).toEqual({
			cardColorStart: "#111",
			cardColorEnd: "#222",
			font: "f",
			glassClear: true,
			backgroundImages: ["bg1"],
		});
	});

	it("hasColorOverride:纯封面覆盖或纯 show 覆盖都不算颜色覆盖", () => {
		expect(hasColorOverride({ liveCoverImages: ["a"] })).toBe(false);
		expect(hasColorOverride({ showFans: false })).toBe(false);
		expect(hasColorOverride({ showFans: false, liveCoverImages: ["a"] })).toBe(false);
		expect(hasColorOverride({ cardColorStart: "#f00" })).toBe(true);
		expect(hasColorOverride(undefined)).toBe(false);
	});
});
