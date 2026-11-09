import { afterEach, describe, expect, it } from "vite-plus/test";
import { i18n } from "../../i18n/index.js";
import { maskedCellsFailure } from "../masked-cells.js";

afterEach(() => i18n.set({ locale: "zh-CN", voice: "maid" }));

it.each([
	[
		"en",
		"Omit this field if unchanged",
		"A secret mask is not a new value and cannot be written back.",
	],
	[
		"ja",
		"変更しない場合はこの項目を送信しないでください",
		"秘密値のマスクは新しい値ではないため、書き戻せません。",
	],
	["zh-TW", "未修改時請勿傳入此欄位", "秘密值的遮罩不是新值，無法寫回。"],
] as const)("%s:密钥遮罩提示本地化,逐格路径不变且不回显值", (locale, summary, reason) => {
	i18n.set({ locale, voice: "plain" });
	const body = {
		key: { masked: "Original masked value" },
		nested: [{ password: { masked: "Another masked value" } }],
	};
	const original = structuredClone(body);
	const result = maskedCellsFailure(body);
	expect(result).toMatchObject({
		ok: false,
		code: "invalid",
		issues: [
			{ path: ["key"], message: reason },
			{ path: ["nested", 0, "password"], message: reason },
		],
	});
	expect(result?.message).toContain(summary);
	expect(JSON.stringify(result)).not.toContain("masked value");
	expect(body).toEqual(original);
	expect(maskedCellsFailure({ key: "Original plaintext", optional: null })).toBeUndefined();
});

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
