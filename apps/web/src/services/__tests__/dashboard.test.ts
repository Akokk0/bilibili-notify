import { describe, expect, it } from "vite-plus/test";
import { type DailyHistoryCountView, foldDailyBuckets, localDayKey } from "../dashboard";

describe("localDayKey", () => {
	it("formats a date as zero-padded local YYYY-MM-DD", () => {
		// 用本地构造器(年,月0基,日,时)→ 与运行时区无关地落在该本地日。
		expect(localDayKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
		expect(localDayKey(new Date(2026, 5, 21, 0, 0))).toBe("2026-06-21");
	});
});

describe("foldDailyBuckets", () => {
	const day = (
		d: string,
		counts: Partial<DailyHistoryCountView["counts"]>,
	): DailyHistoryCountView => ({
		d,
		counts: {
			dynamic: 0,
			live: 0,
			sc: 0,
			guard: 0,
			"special-danmaku": 0,
			"special-enter": 0,
			"live-summary": 0,
			...counts,
		},
		total: Object.values(counts).reduce((a, b) => a + (b ?? 0), 0),
		failures: 0,
	});

	it("按 4 源族折叠(live 族含 summary/special),标签取 MM/DD", () => {
		const out = foldDailyBuckets([
			day("2026-07-01", {
				live: 1,
				"live-summary": 2,
				"special-enter": 1,
				"special-danmaku": 1,
				dynamic: 3,
				sc: 1,
				guard: 2,
			}),
			day("2026-07-02", {}),
		]);
		expect(out).toEqual([
			{ d: "07/01", live: 5, dyn: 3, sc: 1, guard: 2 },
			{ d: "07/02", live: 0, dyn: 0, sc: 0, guard: 0 },
		]);
	});
});
