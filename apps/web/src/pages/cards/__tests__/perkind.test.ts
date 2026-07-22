import { describe, expect, it } from "vite-plus/test";
import type { CardStyle } from "../../../types/globals";
import { applyToAllKinds, explicitByKind, resolveKindStyle, setKindField } from "../perkind";

const base: CardStyle = {
	enabled: true,
	cardColorStart: "#base-start",
	cardColorEnd: "#base-end",
	font: "PingFang SC, sans-serif",
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

describe("explicitByKind", () => {
	// PATCH 走 JSON Merge Patch 语义:**键消失 = 该字段不改**,只有显式 null 才是
	// 删除。所以「关掉某类型的单独样式」必须把那个键写成 null 送出去 —— 直接回传
	// 一个 delete 过的 map,在网络上等于什么都没说。
	it("关掉的类型必须显式写成 null,而不是让键消失", () => {
		expect(explicitByKind({ live: { cardColorStart: "#live" } })).toEqual({
			live: { cardColorStart: "#live" },
			dynamic: null,
			sc: null,
			guard: null,
		});
	});

	it("全部关掉时四个键都是 null", () => {
		expect(explicitByKind({})).toEqual({ live: null, dynamic: null, sc: null, guard: null });
	});

	it("留着的类型原样下发,不被 null 误伤", () => {
		const out = explicitByKind({ sc: { cardColorEnd: "#sc" }, guard: { glassClear: true } });
		expect(out.sc).toEqual({ cardColorEnd: "#sc" });
		expect(out.guard).toEqual({ glassClear: true });
		expect(out.live).toBeNull();
		expect(out.dynamic).toBeNull();
	});
});
