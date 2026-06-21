import { describe, expect, it } from "vite-plus/test";
import { countToday, type HistoryEntryView, localDayKey } from "../dashboard";

function entry(ts: string, ok: boolean): HistoryEntryView {
	return { id: ts, ts, source: "dynamic", uid: "1", subscriptionId: "s", targetIds: [], ok };
}

describe("localDayKey", () => {
	it("formats a date as zero-padded local YYYY-MM-DD", () => {
		// 用本地构造器(年,月0基,日,时)→ 与运行时区无关地落在该本地日。
		expect(localDayKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
		expect(localDayKey(new Date(2026, 5, 21, 0, 0))).toBe("2026-06-21");
	});
});

describe("countToday", () => {
	const now = new Date(2026, 5, 21, 12, 0, 0); // 本地 2026-06-21 中午
	// 用本地构造器再转 UTC ISO,模拟后端 new Date().toISOString();往返后仍落在预期本地日,
	// 故测试与 CI 时区无关。todayAt(1)= 本地今天凌晨,在 UTC+8 下 UTC 是昨天 —— 旧 UTC 口径
	// 会漏算,新本地口径应计入。
	const todayAt = (h: number) => new Date(2026, 5, 21, h, 0, 0).toISOString();
	const yesterdayAt = (h: number) => new Date(2026, 5, 20, h, 0, 0).toISOString();

	it("counts pushes and failures within the local day, not the UTC day", () => {
		const entries = [
			entry(todayAt(1), true), // 本地今天凌晨 → 仍应计入今日
			entry(todayAt(23), false), // 本地今天深夜失败
			entry(yesterdayAt(12), true), // 昨天 → 不计入
			entry(yesterdayAt(23), false), // 昨天失败 → 不计入
		];
		expect(countToday(entries, now)).toEqual({ pushes: 2, failures: 1 });
	});

	it("returns zeros when nothing is from today", () => {
		expect(countToday([entry(yesterdayAt(10), false)], now)).toEqual({ pushes: 0, failures: 0 });
	});
});
