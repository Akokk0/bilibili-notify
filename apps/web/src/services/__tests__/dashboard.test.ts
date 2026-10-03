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
			post: 0,
			liveStart: 0,
			liveStreaming: 0,
			liveEnd: 0,
			superchat: 0,
			membership: 0,
			specialDanmaku: 0,
			specialUserEnter: 0,
			...counts,
		},
		total: Object.values(counts).reduce((a, b) => a + (b ?? 0), 0),
		failures: 0,
	});

	it("按 4 家族折叠(live 族含 直播中 / 下播 / special),标签取 MM/DD;计数的键是特性键", () => {
		const out = foldDailyBuckets([
			day("2026-07-01", {
				liveStart: 1,
				liveStreaming: 1,
				liveEnd: 2,
				specialUserEnter: 1,
				specialDanmaku: 1,
				post: 3,
				superchat: 1,
				membership: 2,
			}),
			day("2026-07-02", {}),
		]);
		expect(out).toEqual([
			{ d: "07/01", live: 6, dyn: 3, sc: 1, guard: 2 },
			{ d: "07/02", live: 0, dyn: 0, sc: 0, guard: 0 },
		]);
	});
});
