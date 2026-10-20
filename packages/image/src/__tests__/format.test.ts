/**
 * 卡片上的时刻写法:按**给的时区**排,与进程默认时区无关(全局时区设置,ADR-0021 决策 43)。
 * 期望值是对照时区表手算的,不照实现再算一遍。
 */

import { Settings } from "luxon";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { formatCardTime } from "../format";

afterEach(() => {
	Settings.defaultZone = "system";
});

describe("formatCardTime", () => {
	/** 2026-01-02T03:04:05Z。 */
	const at = Date.UTC(2026, 0, 2, 3, 4, 5) / 1000;

	it("按给的时区排:上海 +8、纽约一月 -5", () => {
		expect(formatCardTime(at, "Asia/Shanghai")).toBe("2026年01月02日 11:04:05");
		expect(formatCardTime(at, "America/New_York")).toBe("2026年01月01日 22:04:05");
	});

	it("与进程默认时区无关", () => {
		Settings.defaultZone = "America/Los_Angeles";
		expect(formatCardTime(at, "Asia/Shanghai")).toBe("2026年01月02日 11:04:05");
	});
});
