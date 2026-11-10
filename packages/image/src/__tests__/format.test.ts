/**
 * 卡片上的时刻写法:按**给的时区**排,与进程默认时区无关(全局时区设置,ADR-0021 决策 43)。
 * 期望值是对照时区表手算的,不照实现再算一遍。
 */

import { translate } from "@bilibili-notify/internal/i18n";
import { bindPackageText, PACKAGE_DICTS } from "@bilibili-notify/internal/texts";
import { Settings } from "luxon";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { formatCardTime } from "../format";

afterEach(() => {
	Settings.defaultZone = "system";
});

describe("formatCardTime", () => {
	it.each([
		["zh-CN", "2026/1/2 11:04:05", "2026/1/1 22:04:05"],
		["en", "1/2/2026, 11:04:05 AM", "1/1/2026, 10:04:05 PM"],
		["ja", "2026/1/2 11:04:05", "2026/1/1 22:04:05"],
		["zh-TW", "2026/1/2 上午11:04:05", "2026/1/1 下午10:04:05"],
	] as const)("%s 卡片绝对时间使用当前语言且保留时区与秒", (locale, shanghai, newYork) => {
		const binding = bindPackageText(
			(key, values) => translate(PACKAGE_DICTS[locale].plain, locale, key, values),
			() => locale,
		);
		try {
			expect(formatCardTime(at, "Asia/Shanghai").replace(/\s+/gu, " ")).toBe(shanghai);
			expect(formatCardTime(at, "America/New_York").replace(/\s+/gu, " ")).toBe(newYork);
		} finally {
			binding.dispose();
		}
	});

	/** 2026-01-02T03:04:05Z。 */
	const at = Date.UTC(2026, 0, 2, 3, 4, 5) / 1000;

	it("按给的时区排:上海 +8、纽约一月 -5", () => {
		expect(formatCardTime(at, "Asia/Shanghai")).toBe("2026/1/2 11:04:05");
		expect(formatCardTime(at, "America/New_York")).toBe("2026/1/1 22:04:05");
	});

	it("与进程默认时区无关", () => {
		Settings.defaultZone = "America/Los_Angeles";
		expect(formatCardTime(at, "Asia/Shanghai")).toBe("2026/1/2 11:04:05");
	});
});
