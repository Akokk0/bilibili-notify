/**
 * **历史的保留天数只许七档**(ADR-0022 决策 9 下 10-04 的 🔗):`history.retentionDays` 管的是图片与重推原件留几天,
 * 取值 90 / 60 / 30 / 15 / 7 / 3 / 1、默认 30。推送记录的文字不在其内,所以 `app` 里那把 0.x 的老键
 * `historyRetentionDays`(1–365 任意整数)不再认:老值由迁移换算过来。
 */

import { describe, expect, it } from "vite-plus/test";
import { HISTORY_RETENTION_DAY_OPTIONS } from "../../history";
import { GlobalSettingsSchema, HistorySettingsSchema, makeDefaultGlobalSettings } from "../globals";

describe("history.retentionDays", () => {
	it("出厂值 30;缺 `history` 这一节的老设置读进来也是 30", () => {
		expect(makeDefaultGlobalSettings().history).toEqual({ retentionDays: 30 });
		const { history: _dropped, ...withoutHistory } = makeDefaultGlobalSettings();
		expect(GlobalSettingsSchema.parse(withoutHistory).history).toEqual({ retentionDays: 30 });
	});

	it("七档是 90 / 60 / 30 / 15 / 7 / 3 / 1,每一档都收", () => {
		expect([...HISTORY_RETENTION_DAY_OPTIONS]).toEqual([90, 60, 30, 15, 7, 3, 1]);
		for (const days of HISTORY_RETENTION_DAY_OPTIONS) {
			expect(HistorySettingsSchema.parse({ retentionDays: days }).retentionDays).toBe(days);
		}
	});

	it.each([0, 2, 45, 91, 365, 7.5])("七档以外的 %s 不收", (days) => {
		expect(HistorySettingsSchema.safeParse({ retentionDays: days }).success).toBe(false);
	});

	it("`logging` 里没有 historyRetentionDays:写了也读不进来", () => {
		const base = makeDefaultGlobalSettings();
		const parsed = GlobalSettingsSchema.parse({
			...base,
			logging: { ...base.logging, historyRetentionDays: 45 },
		});
		expect(parsed.logging).not.toHaveProperty("historyRetentionDays");
		expect(parsed.history.retentionDays).toBe(30);
	});
});
