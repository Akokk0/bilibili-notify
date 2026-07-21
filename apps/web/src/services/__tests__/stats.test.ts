/**
 * 单元测试 — 数据统计页的前端派生逻辑。
 *
 * 页面上的每个数字都从 `/api/stats/overview` 的一次响应派生,所以派生规则错了
 * 不会报错、只会安静地显示错的数。重点守护 `null`(无记录)在各处的传播:
 * 它绝不能在求和 / 反推 / 分档的路上悄悄变成 0。
 */

import type { StatsOverviewResponse, UpStatsRow } from "@bilibili-notify/contract";
import { describe, expect, it } from "vite-plus/test";
import {
	activityLevel,
	computeTotals,
	coveredDayCount,
	cumulativeFans,
	dayAxis,
	sparseLabels,
} from "../stats.js";

function row(over: Partial<UpStatsRow> = {}): UpStatsRow {
	return {
		uid: "1",
		fans: 100,
		net1d: 1,
		net7d: 7,
		netWindow: 30,
		series: [1, 2, 3],
		activity: [0, 1, 2],
		archives: 1,
		dynamics: 2,
		liveSessions: 1,
		liveHours: 2,
		liveTimedSessions: 0,
		peakViewers: 1000,
		avgPeakViewers: 1000,
		lastActivityAt: null,
		live: false,
		...over,
	};
}

const res = (rows: UpStatsRow[], days = 3): StatsOverviewResponse => ({ days, rows });

describe("computeTotals", () => {
	it("逐项求和", () => {
		const t = computeTotals(res([row(), row({ uid: "2" })]));
		expect(t.fans).toBe(200);
		expect(t.net7d).toBe(14);
		expect(t.archives).toBe(2);
		expect(t.liveSessions).toBe(2);
	});

	it("某位 UP 无记录时跳过它,而不是把整站算成 null", () => {
		const t = computeTotals(res([row({ fans: 100 }), row({ uid: "2", fans: null })]));
		expect(t.fans).toBe(100);
	});

	it("计数类也按无记录汇总:全员 null → null,部分有数 → 只加有数的", () => {
		// 曾经这几项走 `reduce((a,r) => a + r.x, 0)`,「没记录」被加成 0,
		// 于是整站合计永远给得出一个数 —— null 这个事实在汇总层就没了。
		const allNull = computeTotals(
			res([
				row({ archives: null, liveHours: null }),
				row({ uid: "2", archives: null, liveHours: null }),
			]),
		);
		expect(allNull.archives).toBeNull();
		expect(allNull.liveHours).toBeNull();

		const partial = computeTotals(
			res([row({ archives: 3, liveSessions: 2 }), row({ uid: "2", archives: null })]),
		);
		expect(partial.archives).toBe(3);
		expect(partial.liveSessions).toBe(3);
	});

	it("全员都无记录 → null,不是 0", () => {
		const t = computeTotals(
			res([row({ fans: null, net7d: null }), row({ uid: "2", fans: null, net7d: null })]),
		);
		expect(t.fans).toBeNull();
		expect(t.net7d).toBeNull();
	});

	it("序列逐位相加,某位全 null 则该位保持 null", () => {
		const t = computeTotals(
			res([row({ series: [1, null, 3] }), row({ uid: "2", series: [10, null, 30] })]),
		);
		expect(t.series).toEqual([11, null, 33]);
	});

	it("某位只有部分 UP 有数 → 按有数的那些求和", () => {
		const t = computeTotals(
			res([row({ series: [1, 2, 3] }), row({ uid: "2", series: [null, null, 30] })]),
		);
		expect(t.series).toEqual([1, 2, 33]);
	});

	it("activity 逐位相加,全员都没记录的那位保持 null —— 覆盖天数据此判定", () => {
		const t = computeTotals(
			res([row({ activity: [null, 1, 2] }), row({ uid: "2", activity: [null, null, 5] })]),
		);
		expect(t.activity).toEqual([null, 1, 7]);
		expect(coveredDayCount(t.activity)).toBe(2);
	});

	it("统计当前在播人数", () => {
		const t = computeTotals(res([row({ live: true }), row({ uid: "2", live: false })]));
		expect(t.liveNow).toBe(1);
	});
});

describe("cumulativeFans — 由当前值与每日净增反推累计曲线", () => {
	it("末位是当前粉丝数,往前逐日减去净增", () => {
		// 净增 [_, +10, +20],当前 200 → 前一天 180,再前一天 170
		expect(cumulativeFans(200, [5, 10, 20])).toEqual([170, 180, 200]);
	});

	it("断档那天保持 null,差值记到它**之前**那个有数据的日上", () => {
		// 服务端的 net 是「当日末值 − 前一个**有数据**的日的末值」,不是「减前一天」。
		// d1 没记录时,d2 的 20 是相对 d0 的,所以 200−20=180 属于 d0 —— 曾经无条件
		// 记到 d1 上,于是没记录的那天被画出一个编来的值,真正有值的那天反倒空着,
		// 整条曲线在断档处错位一天(停机 6 天就错 6 天)。
		expect(cumulativeFans(200, [5, null, 20])).toEqual([180, null, 200]);
	});

	it("连续断档也只把值落在有数据的那几天上", () => {
		// d1 d2 皆无记录,d3 的 30 相对 d0 → 100−30=70 属于 d0。
		expect(cumulativeFans(100, [5, null, null, 30])).toEqual([70, null, null, 100]);
	});

	it("当前粉丝数未知 → 整条曲线都是 null", () => {
		expect(cumulativeFans(null, [1, 2, 3])).toEqual([null, null, null]);
	});

	it("空序列 → 空结果", () => {
		expect(cumulativeFans(100, [])).toEqual([]);
	});
});

describe("dayAxis", () => {
	it("长度等于 days,末位是今天", () => {
		const now = new Date("2026-05-16T12:00:00.000Z");
		const axis = dayAxis(3, now);
		expect(axis).toHaveLength(3);
		expect(axis.at(-1)).toBe(
			new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10),
		);
	});

	it("相邻两格恰好差一天", () => {
		// 上面那条「末位是今天」把实现的时区换算公式原样抄了一遍(重言式),实现错了
		// 它跟着错;「递增无重复」也拦不住步长变大。而步长一旦不是一天,热力图与
		// 服务端 dailyFansSeries 的分桶就对不上,整条轴指向错误的日期。
		const axis = dayAxis(5, new Date("2026-05-16T12:00:00.000Z"));
		for (let i = 1; i < axis.length; i++) {
			const gap = Date.parse(`${axis[i]}T00:00:00Z`) - Date.parse(`${axis[i - 1]}T00:00:00Z`);
			expect(gap).toBe(86_400_000);
		}
	});

	it("按天严格递增,无重复", () => {
		const axis = dayAxis(10, new Date("2026-05-16T12:00:00.000Z"));
		expect(new Set(axis).size).toBe(10);
		expect([...axis].sort()).toEqual(axis);
	});
});

describe("sparseLabels", () => {
	it("末位固定标「今天」", () => {
		expect(sparseLabels(dayAxis(30)).at(-1)).toBe("今天");
	});

	it("其余只在等距位置留标签,避免糊成一片", () => {
		const labels = sparseLabels(dayAxis(30), 6);
		expect(labels.filter(Boolean).length).toBeLessThan(8);
	});

	it("标签确实落在等距位置上,而且真的有几个", () => {
		// 回归:这组测试原本只有上面那条**上界**断言,于是「除今天外全部返回空串」
		// 也能全绿 —— 它声称在验的等距分布其实一条都没验到。
		const labels = sparseLabels(dayAxis(30), 6);
		const marked = labels.map((l, i) => (l ? i : -1)).filter((i) => i >= 0);
		expect(marked).toEqual([5, 11, 17, 23, 29]);
		expect(labels[29]).toBe("今天");
		expect(labels[23]).toBe("6日前");
		expect(labels[5]).toBe("24日前");
	});

	it("非标签位一律是空串,不是 undefined —— 渲染层直接当 falsy 用", () => {
		const labels = sparseLabels(dayAxis(30), 6);
		expect(labels[0]).toBe("");
		expect(labels).toHaveLength(30);
	});
});

describe("coveredDayCount — 「日均」类指标的分母", () => {
	it("只数有记录的天 —— null 是「我们没在记」,不是「那天零活动」", () => {
		// 采集才跑了 2 天却选了近 30 日时,分母若用窗口天数,12 次活动会算成
		// 0.4 次/天(应为 6.0)。同一屏里热力图已经把那 28 天画成空心「无记录」,
		// 分母却仍把它们当成实实在在的 28 天。
		expect(coveredDayCount([null, null, 0, 3])).toBe(2);
	});

	it("零活动的那天照样算覆盖 —— 我们在记,只是没事发生", () => {
		expect(coveredDayCount([0, 0, 0])).toBe(3);
	});

	it("全无记录 / 缺数据 → 0,由调用方决定怎么显示", () => {
		expect(coveredDayCount([null, null])).toBe(0);
		expect(coveredDayCount(undefined)).toBe(0);
		expect(coveredDayCount([])).toBe(0);
	});
});

describe("activityLevel — 活跃度分档", () => {
	it("无记录保持 null", () => {
		expect(activityLevel(null)).toBeNull();
	});

	it("0 次活动是 0 档(与无记录区分)", () => {
		expect(activityLevel(0)).toBe(0);
	});

	it("按 1 / 2 / 3-4 / 5+ 分档", () => {
		expect(activityLevel(1)).toBe(1);
		expect(activityLevel(2)).toBe(2);
		expect(activityLevel(4)).toBe(3);
		expect(activityLevel(99)).toBe(4);
	});
});
