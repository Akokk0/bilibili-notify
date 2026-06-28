import { describe, expect, it } from "vite-plus/test";
import type { CardStyle } from "../../../types/globals";
import { applyToAllKinds, resolveKindStyle, setKindField } from "../perkind";

const base: CardStyle = {
	enabled: true,
	cardColorStart: "#base-start",
	cardColorEnd: "#base-end",
	font: "PingFang SC, sans-serif",
	showPopularity: true,
	showArea: true,
	showFans: true,
	backgroundImages: [],
	glassClear: false,
};

describe("resolveKindStyle", () => {
	it("returns the base when the kind has no override", () => {
		expect(resolveKindStyle(base, {}, "live")).toEqual(base);
	});
	it("overlays the kind's overridden fields over the base", () => {
		const s = resolveKindStyle(base, { live: { cardColorStart: "#live" } }, "live");
		expect(s.cardColorStart).toBe("#live");
		expect(s.cardColorEnd).toBe("#base-end"); // 未覆盖字段继承基准
	});
	it("does not leak one kind's override to another", () => {
		const byKind = { live: { backgroundImages: ["live.png"] } };
		expect(resolveKindStyle(base, byKind, "dynamic").backgroundImages).toEqual([]);
	});
});

describe("setKindField", () => {
	it("writes a single field into that kind's override layer", () => {
		const next = setKindField({}, "sc", "cardColorStart", "#sc");
		expect(next.sc?.cardColorStart).toBe("#sc");
	});
	it("merges with an existing override and does not mutate input", () => {
		const input = { sc: { cardColorStart: "#sc" } };
		const next = setKindField(input, "sc", "backgroundImages", ["a.png"]);
		expect(next.sc).toEqual({ cardColorStart: "#sc", backgroundImages: ["a.png"] });
		expect(input.sc).toEqual({ cardColorStart: "#sc" }); // 原对象不变
	});
});

describe("applyToAllKinds", () => {
	it("promotes the active kind's effective style to the base and clears all per-kind overrides", () => {
		const byKind = { live: { cardColorStart: "#live" }, sc: { cardColorEnd: "#sc" } };
		const out = applyToAllKinds(base, byKind, "live");
		expect(out.base.cardColorStart).toBe("#live");
		expect(out.byKind).toEqual({});
	});
});
