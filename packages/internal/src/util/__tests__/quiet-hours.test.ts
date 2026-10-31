import { describe, expect, it } from "vite-plus/test";
import { inQuietHours } from "../quiet-hours";

const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

function at(hour: number): Date {
	const d = new Date(2026, 0, 1, hour, 30, 0);
	return d;
}

describe("inQuietHours()", () => {
	it("returns false when ranges is empty", () => {
		expect(inQuietHours([], at(3), localTimezone)).toBe(false);
	});

	it("matches a same-day range, half-open [start, end)", () => {
		const r = [{ start: 9, end: 18 }];
		expect(inQuietHours(r, at(8), localTimezone)).toBe(false);
		expect(inQuietHours(r, at(9), localTimezone)).toBe(true);
		expect(inQuietHours(r, at(17), localTimezone)).toBe(true);
		expect(inQuietHours(r, at(18), localTimezone)).toBe(false); // end is exclusive
	});

	it("matches a cross-midnight range", () => {
		const r = [{ start: 23, end: 7 }];
		expect(inQuietHours(r, at(22), localTimezone)).toBe(false);
		expect(inQuietHours(r, at(23), localTimezone)).toBe(true);
		expect(inQuietHours(r, at(0), localTimezone)).toBe(true);
		expect(inQuietHours(r, at(6), localTimezone)).toBe(true);
		expect(inQuietHours(r, at(7), localTimezone)).toBe(false); // end is exclusive
	});

	it("OR-combines multiple ranges", () => {
		const r = [{ start: 0, end: 6 }, { start: 22, end: 24 } as { start: number; end: number }];
		// 注:end=24 在 schema 上不允许,但 helper 自身按 r.start < r.end 走,正常匹配
		expect(inQuietHours(r, at(3), localTimezone)).toBe(true);
		expect(inQuietHours(r, at(12), localTimezone)).toBe(false);
		expect(inQuietHours(r, at(23), localTimezone)).toBe(true);
	});
});

// Same instant, different wall clocks; independent of the test machine TZ.
describe("quiet hours in the configured timezone", () => {
	it("uses the configured wall hour, including a cross-midnight range", () => {
		const at = new Date("2026-01-01T18:30:00.000Z");
		const ranges = [{ start: 23, end: 7 }];
		expect(inQuietHours(ranges, at, "UTC")).toBe(false);
		expect(inQuietHours(ranges, at, "Asia/Shanghai")).toBe(true);
	});
	it("treats both repeated DST hours alike and excludes the end", () => {
		const ranges = [{ start: 1, end: 2 }];
		expect(inQuietHours(ranges, new Date("2026-11-01T05:30:00Z"), "America/New_York")).toBe(true);
		expect(inQuietHours(ranges, new Date("2026-11-01T06:30:00Z"), "America/New_York")).toBe(true);
		expect(inQuietHours(ranges, new Date("2026-11-01T07:00:00Z"), "America/New_York")).toBe(false);
	});
});
