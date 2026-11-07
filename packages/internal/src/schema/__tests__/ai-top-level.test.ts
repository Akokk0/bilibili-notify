/**
 * AI 设置在核心设置的顶层(3a-38 提交 ④:原先在 `defaults.ai`)。
 *
 * 钉:`ai` 是顶层必填的一段(缺了抛,同今天的 `defaults.ai`);`defaults` 里再写 `ai` 被剥掉、不抛、不影响顶层;
 * 出厂值就是 `DEFAULT_AI`;里面的键(含 `activePreset`)原样在顶层 `ai` 里。
 */

import { describe, expect, it } from "vite-plus/test";
import { AiSettingsSchema } from "../common";
import { DEFAULT_AI, GlobalSettingsSchema, makeDefaultGlobalSettings } from "../globals";

describe("顶层 ai", () => {
	it("全新安装:ai 在顶层、等于出厂的 AI 设置,activePreset 在里面", () => {
		const g = makeDefaultGlobalSettings();
		expect(g.ai).toEqual(AiSettingsSchema.parse(DEFAULT_AI));
		expect(typeof g.ai.activePreset).toBe("string");
	});

	it("顶层缺 ai 就抛(必填、不带 default,同今天的 defaults.ai)", () => {
		const g = makeDefaultGlobalSettings() as unknown as Record<string, unknown>;
		delete g.ai;
		expect(GlobalSettingsSchema.safeParse(g).success).toBe(false);
	});

	it("`defaults` 里写老位置的 ai 被剥掉、不抛,也不影响顶层 ai", () => {
		const base = makeDefaultGlobalSettings();
		const g = { ...base, defaults: { ...base.defaults, ai: { ...base.ai, enabled: true } } };
		const parsed = GlobalSettingsSchema.parse(g);
		expect("ai" in parsed.defaults).toBe(false);
		expect(parsed.ai).toEqual(base.ai);
	});
});
