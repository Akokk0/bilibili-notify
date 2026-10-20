/**
 * 全局时区的两条规矩(ADR-0021 决策 43):哪些写法收得下、某一刻的偏移怎么算。
 * 期望值取 IANA 时区库里已知的那些,不从被测函数算。
 */

import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_TIMEZONE, isTimezone, timezoneOffsetMinutes } from "../timezone";

describe("isTimezone", () => {
	it.each(["Asia/Shanghai", "UTC", "America/New_York", "Asia/Kolkata", "Etc/GMT-8"])(
		"%s 收得下",
		(name) => {
			expect(isTimezone(name)).toBe(true);
		},
	);

	it.each(["Mars/Base", "", "UTC+8", "+08:00", " Asia/Shanghai"])("%s 不收", (name) => {
		expect(isTimezone(name)).toBe(false);
	});

	it("大小写不规范、但 Intl 认得的照收 —— 不比规范名", () => {
		expect(isTimezone("asia/shanghai")).toBe(true);
	});
});

describe("timezoneOffsetMinutes", () => {
	const january = new Date("2026-01-15T12:00:00Z");
	const july = new Date("2026-07-15T12:00:00Z");

	it("UTC+8 是 -480,UTC 是 0", () => {
		expect(timezoneOffsetMinutes("Asia/Shanghai", january)).toBe(-480);
		expect(timezoneOffsetMinutes("Etc/GMT-8", july)).toBe(-480);
		expect(timezoneOffsetMinutes("UTC", january)).toBe(0);
	});

	it("印度是 -330", () => {
		expect(timezoneOffsetMinutes("Asia/Kolkata", january)).toBe(-330);
	});

	it("纽约一月 300、七月 240", () => {
		expect(timezoneOffsetMinutes("America/New_York", january)).toBe(300);
		expect(timezoneOffsetMinutes("America/New_York", july)).toBe(240);
	});

	it("与进程时区无关:换成 America/Los_Angeles 照样成立", () => {
		const inZone = (tz: string, fn: () => void) => {
			const before = process.env.TZ;
			process.env.TZ = tz;
			try {
				fn();
			} finally {
				if (before === undefined) delete process.env.TZ;
				else process.env.TZ = before;
			}
		};
		inZone("America/Los_Angeles", () => {
			expect(timezoneOffsetMinutes("Asia/Shanghai", january)).toBe(-480);
			expect(timezoneOffsetMinutes("America/New_York", july)).toBe(240);
		});
	});

	it("默认值就是北京", () => {
		expect(DEFAULT_TIMEZONE).toBe("Asia/Shanghai");
	});
});
