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
	coveredActivityTotal,
	coveredDayCount,
	cumulativeFans,
	dayAxis,
	fansKnownCount,
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
		cumulative: [100, 102, 105],
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

describe("cumulativeFans — 粉丝总量曲线", () => {
	/** 只喂这个函数要的两项。字段名写全,免得又跟 `series` 弄混。 */
	const fansRow = (fans: number | null, cumulative: Array<number | null>) => ({
		fans,
		cumulative,
	});

	// 曾经这条线由「当前粉丝数 + 每日净增」**反推**,理由写着「反推是无损的」。
	// 那个前提是错的,两处都推不出来,而且索引信息在只传 net 的那一刻就丢了,
	// 补不回来 —— 所以服务端现在照常把每日末值(cumulative)一并给出。
	it("直接用服务端给的每日末值", () => {
		expect(cumulativeFans(fansRow(1200, [1000, 1100, 1180]))).toEqual([1000, 1100, 1200]);
	});

	it("取的是 cumulative 而不是 series —— 两者类型一模一样,只有这条认得出区别", () => {
		// 回归:调用点一度传着 `series`(每日净增)。走势图于是画出一串 0 附近的
		// 小数,末位被换成几十万的当前粉丝数 —— 一条贴着 0 走、末端垂直拉起的线。
		// 现在签名收整行,传错编译不过;这条守的是函数内部别哪天改回去读 series。
		const row = {
			fans: 1_000_120,
			series: [50, 70, null], // 每日净增
			cumulative: [1_000_000, 1_000_070, null], // 每日末值
		};
		expect(cumulativeFans(row)).toEqual([1_000_000, 1_000_070, 1_000_120]);
	});

	it("末位换成 poller 的最新快照,它比当日最后一条采样更新", () => {
		// 曲线右端点就是 KPI 上那个「当前粉丝数」,两者对不上会很显眼。
		expect(cumulativeFans(fansRow(1200, [1000, 1100, 1180]))[2]).toBe(1200);
	});

	it("窗口最早那天有值就画出来 —— 净增为 null 不代表它没有值", () => {
		// 反推法靠 net 找「上一个有数据的日」,而窗口内第一个有数据的日没有前一日
		// 基线、net 恒为 null,于是被当成没数据跳过:明明由后一天减得出来,曲线却
		// 白白晚起一天。
		expect(cumulativeFans(fansRow(1200, [1000, 1100, 1180]))[0]).toBe(1000);
	});

	it("今天还没采到样本时,前面的点照常保留,不塌成孤零零一个点", () => {
		// 轮询处在风控退避中,或页面在本地零点后几分钟打开:当日净增为 null。
		// 反推法在第一轮就 break,TrendChart 只画得出一个圆点。
		const got = cumulativeFans(fansRow(1200, [1000, 1100, null]));
		expect(got.slice(0, 2)).toEqual([1000, 1100]);
		expect(got).toHaveLength(3);
	});

	it("中间断档保持 null —— 不在图上把没采到的日子连成直线", () => {
		expect(cumulativeFans(fansRow(1300, [1000, null, 1290]))).toEqual([1000, null, 1300]);
	});

	it("当前粉丝未知时不硬凑末位", () => {
		expect(cumulativeFans(fansRow(null, [1000, 1100, null]))).toEqual([1000, 1100, null]);
	});

	it("空序列 → 空结果", () => {
		expect(cumulativeFans(fansRow(1200, []))).toEqual([]);
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

describe("fansKnownCount — 「总粉丝量」是不是全站合计", () => {
	it("只数有粉丝记录的 UP", () => {
		expect(fansKnownCount([row({ fans: 100 }), row({ uid: "2", fans: null })])).toBe(1);
	});

	it("全员有数 → 等于订阅数,标签就不必标注", () => {
		expect(fansKnownCount([row({ fans: 1 }), row({ uid: "2", fans: 0 })])).toBe(2);
	});

	it("0 粉丝算有记录 —— 与「没采到」是两回事", () => {
		expect(fansKnownCount([row({ fans: 0 })])).toBe(1);
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

describe("coveredActivityTotal — 「日均活动」的分子", () => {
	it("只数有采集覆盖的那些天,与 coveredDayCount 同一把尺子", () => {
		// 分子取窗口合计、分母取覆盖天数,是两把不同的尺子:单订阅的 UP 被禁用再启用
		// 会让 fans jsonl 被 dropUid 物理删掉,覆盖天数塌成 1 天,而统计 jsonl 里三个月
		// 的 60 次活动原封不动 —— 卡片于是写着「60.0 次 / 天 · 已记录1日」,紧挨着一张
		// 90 格空了 89 格的热力图。
		const activity = [null, null, 2, 3];
		expect(coveredActivityTotal(activity)).toBe(5);
		expect(coveredDayCount(activity)).toBe(2);
	});

	it("覆盖到的那天真的是 0 就照算 0,不当成没覆盖", () => {
		expect(coveredActivityTotal([0, 0])).toBe(0);
		expect(coveredDayCount([0, 0])).toBe(2);
	});

	it("undefined / 全 null → 0", () => {
		expect(coveredActivityTotal(undefined)).toBe(0);
		expect(coveredActivityTotal([null, null])).toBe(0);
	});
});
