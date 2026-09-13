import { describe, expect, it } from "vite-plus/test";
import type { CardStyle } from "../../../types/globals";
import { applyToAllKinds, resolveKindStyle, setKindField } from "../perkind";

const base: CardStyle = {
	enabled: true,
	font: "Base Sans",
	fontAsset: "base.woff2",
	showPopularity: true,
	showArea: true,
	showFans: true,
	backgroundImages: [],
	liveCoverImages: [],
	glassClear: false,
};

describe("resolveKindStyle", () => {
	it("returns the base when the kind has no override", () => {
		expect(resolveKindStyle(base, {}, "live")).toEqual(base);
	});
	it("overlays the kind's overridden fields over the base", () => {
		const s = resolveKindStyle(base, { live: { font: "Live Sans" } }, "live");
		expect(s.font).toBe("Live Sans");
		expect(s.fontAsset).toBe("base.woff2"); // 未覆盖字段继承基准
	});
	it("does not leak one kind's override to another", () => {
		const byKind = { live: { backgroundImages: ["live.png"] } };
		expect(resolveKindStyle(base, byKind, "dynamic").backgroundImages).toEqual([]);
	});
});

describe("setKindField", () => {
	it("writes a single field into that kind's override layer", () => {
		const next = setKindField({}, "sc", "font", "SC Sans");
		expect(next.sc?.font).toBe("SC Sans");
	});
	it("merges with an existing override and does not mutate input", () => {
		const input = { sc: { font: "SC Sans" } };
		const next = setKindField(input, "sc", "backgroundImages", ["a.png"]);
		expect(next.sc).toEqual({ font: "SC Sans", backgroundImages: ["a.png"] });
		expect(input.sc).toEqual({ font: "SC Sans" }); // 原对象不变
	});
});

describe("applyToAllKinds", () => {
	it("promotes the active kind's effective style to the base and clears all per-kind overrides", () => {
		const byKind = { live: { font: "Live Sans" }, sc: { fontAsset: "sc.woff2" } };
		const out = applyToAllKinds(base, byKind, "live");
		expect(out.base.font).toBe("Live Sans");
		expect(out.byKind).toEqual({});
	});
});
