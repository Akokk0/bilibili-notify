import { describe, expect, it } from "vite-plus/test";
import { inQuietHours } from "./quiet-hours";

function at(hour: number): Date {
	const d = new Date(2026, 0, 1, hour, 30, 0);
	return d;
}

describe("inQuietHours()", () => {
	it("returns false when ranges is empty", () => {
		expect(inQuietHours([], at(3))).toBe(false);
	});

	it("matches a same-day range, half-open [start, end)", () => {
		const r = [{ start: 9, end: 18 }];
		expect(inQuietHours(r, at(8))).toBe(false);
		expect(inQuietHours(r, at(9))).toBe(true);
		expect(inQuietHours(r, at(17))).toBe(true);
		expect(inQuietHours(r, at(18))).toBe(false); // end is exclusive
	});

	it("matches a cross-midnight range", () => {
		const r = [{ start: 23, end: 7 }];
		expect(inQuietHours(r, at(22))).toBe(false);
		expect(inQuietHours(r, at(23))).toBe(true);
		expect(inQuietHours(r, at(0))).toBe(true);
		expect(inQuietHours(r, at(6))).toBe(true);
		expect(inQuietHours(r, at(7))).toBe(false); // end is exclusive
	});

	it("OR-combines multiple ranges", () => {
		const r = [{ start: 0, end: 6 }, { start: 22, end: 24 } as { start: number; end: number }];
		// 注:end=24 在 schema 上不允许,但 helper 自身按 r.start < r.end 走,正常匹配
		expect(inQuietHours(r, at(3))).toBe(true);
		expect(inQuietHours(r, at(12))).toBe(false);
		expect(inQuietHours(r, at(23))).toBe(true);
	});
});
