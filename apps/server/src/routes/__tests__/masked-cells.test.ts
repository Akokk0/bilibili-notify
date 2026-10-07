import { describe, expect, it } from "vite-plus/test";
import { maskedCellsFailure } from "../masked-cells.js";

/** 写入体里的密钥遮挡 → 400:认形状(只有一个字符串键 `masked`),issues 指到每一格。 */
describe("maskedCellsFailure", () => {
	it("干净的体回 undefined", () => {
		expect(maskedCellsFailure({ a: "x", b: { c: [1, { d: null }] } })).toBeUndefined();
		expect(maskedCellsFailure(null)).toBeUndefined();
		expect(maskedCellsFailure("masked")).toBeUndefined();
	});

	it("嵌套的遮挡逐格列出路径(含数组下标)", () => {
		const failure = maskedCellsFailure({
			config: { accessToken: { masked: "••••••••" } },
			list: [{ k: 1 }, { token: { masked: "a" } }],
		});
		expect(failure).toMatchObject({ ok: false, code: "invalid" });
		expect(failure?.issues?.map((i) => i.path)).toEqual([
			["config", "accessToken"],
			["list", 1, "token"],
		]);
	});

	it("带别的键的、masked 不是字符串的,是普通数据,不拦", () => {
		expect(maskedCellsFailure({ a: { masked: "x", n: 1 } })).toBeUndefined();
		expect(maskedCellsFailure({ a: { masked: 1 } })).toBeUndefined();
	});
});
