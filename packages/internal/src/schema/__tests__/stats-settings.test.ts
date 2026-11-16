/**
 * **数据统计的总开关**(ADR-0027 决策 9、16):顶层一节 `stats`,只有一格 `enabled`,默认开。
 * 老设置文件与老备份里没有这一节 —— 靠 schema 的默认值补成开着,不走迁移。
 */

import { describe, expect, it } from "vite-plus/test";
import {
	DEFAULT_STATS_SETTINGS,
	GlobalSettingsSchema,
	makeDefaultGlobalSettings,
	StatsSettingsSchema,
} from "../globals";

describe("stats.enabled", () => {
	it("出厂开着;缺 `stats` 这一节的老设置读进来也是开着", () => {
		expect(DEFAULT_STATS_SETTINGS).toEqual({ enabled: true });
		expect(makeDefaultGlobalSettings().stats).toEqual({ enabled: true });
		const { stats: _dropped, ...withoutStats } = makeDefaultGlobalSettings();
		expect(GlobalSettingsSchema.parse(withoutStats).stats).toEqual({ enabled: true });
	});

	it("`stats` 节在、但没写 enabled:也是开着", () => {
		expect(StatsSettingsSchema.parse({})).toEqual({ enabled: true });
	});

	it("关掉的值原样读回,不被默认值盖掉", () => {
		const base = makeDefaultGlobalSettings();
		expect(GlobalSettingsSchema.parse({ ...base, stats: { enabled: false } }).stats.enabled).toBe(
			false,
		);
	});

	it("不是布尔的不收", () => {
		expect(StatsSettingsSchema.safeParse({ enabled: "no" }).success).toBe(false);
	});

	it("总开关仍在顶层；订阅默认只包含可单独开启的播放量采集", () => {
		const settings = makeDefaultGlobalSettings();
		expect(settings.stats).toEqual({ enabled: true });
		expect(settings.defaults.stats).toEqual({ videoViews: false });
		expect(settings.defaults.stats).not.toHaveProperty("enabled");
	});
});
