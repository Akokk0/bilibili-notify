/**
 * 新装的 `ai` 形状(ADR-0037 决策 11):内置人格不落盘 —— `presets` 只装主人自己的(空),
 * 没删过内置就没有 `removedBuiltinPresets` 这一格,顶层人格三格也不再有。
 */

import { describe, expect, it } from "vite-plus/test";
import { AISettingsSchema } from "../common";
import { makeDefaultGlobalConfig } from "../globals";

describe("新装的 ai", () => {
	const ai = makeDefaultGlobalConfig().ai as Record<string, unknown>;

	it("presets 是空数组,没有 removedBuiltinPresets,指针指首份内置", () => {
		expect(ai.presets).toEqual([]);
		expect("removedBuiltinPresets" in ai).toBe(false);
		expect(ai.activePreset).toBe("gentle-maid");
	});

	it("没有顶层 persona / dynamicPrompt / liveSummaryPrompt", () => {
		expect("persona" in ai).toBe(false);
		expect("dynamicPrompt" in ai).toBe(false);
		expect("liveSummaryPrompt" in ai).toBe(false);
	});

	it("老盘上的顶层三格读时剥掉;removedBuiltinPresets 照收", () => {
		const parsed = AISettingsSchema.parse({
			...ai,
			persona: { name: "x" },
			dynamicPrompt: "x",
			liveSummaryPrompt: "x",
			removedBuiltinPresets: ["genki"],
		}) as Record<string, unknown>;
		expect("persona" in parsed).toBe(false);
		expect("dynamicPrompt" in parsed).toBe(false);
		expect(parsed.removedBuiltinPresets).toEqual(["genki"]);
	});

	it("解析后再解析,新装的形状不会长出 removedBuiltinPresets", () => {
		const parsed = AISettingsSchema.parse(ai) as Record<string, unknown>;
		expect("removedBuiltinPresets" in parsed).toBe(false);
	});
});
