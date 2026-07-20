/**
 * 单元测试 — stats 聚合层(纯函数,无 IO)。
 *
 * 这层是全仓**唯一**给 B 站动态类型定语义的地方,所以类型归类的用例写得比较死:
 * 归类一旦漂移,投稿数 / 动态数两个口径会同时错,而且错得很安静。
 */

import { describe, expect, it } from "vite-plus/test";
import {
	classifyDynamic,
	countDynamics,
	dailyActivityCounts,
	dailyFansSeries,
	summarizeLiveSessions,
} from "../aggregate.js";

/** UTC+8 的 getTimezoneOffset() 口径。 */
const TZ_CN = -480;
/** 北京时间 2026-05-16 h 时的 UTC ISO。 */
const CN = (day: number, h: number) => new Date(Date.UTC(2026, 4, day, h - 8, 0, 0)).toISOString();

describe("classifyDynamic — 类型归类策略", () => {
	it("视频投稿算 archive", () => {
		expect(classifyDynamic("DYNAMIC_TYPE_AV")).toBe("archive");
	});

	it("开播伪动态忽略 —— 直播场次由 live 场次记录负责,不能两头都计一次", () => {
		expect(classifyDynamic("DYNAMIC_TYPE_LIVE_RCMD")).toBe("ignored");
		expect(classifyDynamic("DYNAMIC_TYPE_LIVE")).toBe("ignored");
	});

	it("图文 / 纯文字 / 转发算普通动态", () => {
		expect(classifyDynamic("DYNAMIC_TYPE_DRAW")).toBe("dynamic");
		expect(classifyDynamic("DYNAMIC_TYPE_WORD")).toBe("dynamic");
		expect(classifyDynamic("DYNAMIC_TYPE_FORWARD")).toBe("dynamic");
	});

	it("没见过的新类型算普通动态,不静默丢弃", () => {
		expect(classifyDynamic("DYNAMIC_TYPE_SOMETHING_NEW")).toBe("dynamic");
	});
});

describe("countDynamics", () => {
	it("按归类分别计数,开播伪动态不进任何一栏", () => {
		const got = countDynamics([
			{ id: "1", type: "DYNAMIC_TYPE_AV", ts: CN(16, 10) },
			{ id: "2", type: "DYNAMIC_TYPE_AV", ts: CN(16, 11) },
			{ id: "3", type: "DYNAMIC_TYPE_DRAW", ts: CN(16, 12) },
			{ id: "4", type: "DYNAMIC_TYPE_LIVE_RCMD", ts: CN(16, 13) },
		]);
		expect(got).toEqual({ archives: 2, dynamics: 1 });
	});

	it("空输入 → 全 0", () => {
		expect(countDynamics([])).toEqual({ archives: 0, dynamics: 0 });
	});
});

describe("dailyFansSeries — 按本地日归并的每日净增", () => {
	const now = new Date(CN(16, 23));

	it("每日净增 = 当日末值 − 前一日末值", () => {
		const samples = [
			{ ts: CN(14, 23), value: 1000 },
			{ ts: CN(15, 10), value: 1050 },
			{ ts: CN(15, 23), value: 1100 },
			{ ts: CN(16, 22), value: 1180 },
		];
		const got = dailyFansSeries(samples, { days: 2, tzOffsetMin: TZ_CN, now });
		expect(got).toEqual([
			{ d: "2026-05-15", net: 100, value: 1100 },
			{ d: "2026-05-16", net: 80, value: 1180 },
		]);
	});

	it("按本地日切分 —— UTC+8 的当日 07:00 属于当天,不能落到前一天", () => {
		const samples = [
			{ ts: CN(15, 23), value: 500 },
			{ ts: CN(16, 7), value: 560 },
		];
		const got = dailyFansSeries(samples, { days: 1, tzOffsetMin: TZ_CN, now });
		expect(got).toEqual([{ d: "2026-05-16", net: 60, value: 560 }]);
	});

	it("某日无样本 → net 为 null,不拿 0 冒充「当天没涨粉」", () => {
		const samples = [
			{ ts: CN(14, 23), value: 1000 },
			{ ts: CN(16, 12), value: 1200 },
		];
		const got = dailyFansSeries(samples, { days: 2, tzOffsetMin: TZ_CN, now });
		expect(got[0]).toEqual({ d: "2026-05-15", net: null, value: null });
		// 15 号没数据,16 号的基线要回退到 14 号的末值
		expect(got[1]).toEqual({ d: "2026-05-16", net: 200, value: 1200 });
	});

	it("窗口内最早一天没有前一日基线 → net 为 null", () => {
		const samples = [{ ts: CN(16, 12), value: 300 }];
		const got = dailyFansSeries(samples, { days: 1, tzOffsetMin: TZ_CN, now });
		expect(got).toEqual([{ d: "2026-05-16", net: null, value: 300 }]);
	});

	it("掉粉 → 负数净增", () => {
		const samples = [
			{ ts: CN(15, 23), value: 900 },
			{ ts: CN(16, 23), value: 850 },
		];
		const got = dailyFansSeries(samples, { days: 1, tzOffsetMin: TZ_CN, now });
		expect(got[0]?.net).toBe(-50);
	});

	it("空样本 → 每天都是 null,长度仍等于 days", () => {
		const got = dailyFansSeries([], { days: 3, tzOffsetMin: TZ_CN, now });
		expect(got).toHaveLength(3);
		expect(got.every((p) => p.net === null)).toBe(true);
	});
});

describe("summarizeLiveSessions", () => {
	it("统计场次与总时长(只算已闭合的场)", () => {
		const got = summarizeLiveSessions([
			{ startedAt: CN(15, 10), endedAt: CN(15, 13) },
			{ startedAt: CN(16, 20), endedAt: CN(16, 22) },
		]);
		expect(got.sessions).toBe(2);
		expect(got.hours).toBeCloseTo(5, 5);
	});

	it("未闭合的场按「到现在为止」算时长 —— 服务器在 UP 开播中途启动时,这一场不能算 0", () => {
		const now = new Date(Date.parse(CN(16, 22)));
		const got = summarizeLiveSessions([{ startedAt: CN(16, 20), current: true }], {
			now,
			isLive: true,
		});
		expect(got.sessions).toBe(1);
		expect(got.hours).toBeCloseTo(2, 5);
	});

	it("直播中重启:盘上留着关服截断的 end,引擎说在播 → 按到现在算,不冻结在截断点", () => {
		// 20:00 开播 → 22:00 关服(closeOpenSessions 补一帧 end)→ 重启后 bootstrap
		// 又观测到同一场,store 据此打上 current。此刻 23:00 看统计页,这一场已经播了
		// 3 小时,不是被截断的 2 小时 —— 曾经带 endedAt 的场次一律按 endedAt 算,
		// 于是「正在直播时看」这个最常用的时刻恰恰是错的。
		const got = summarizeLiveSessions(
			[{ startedAt: CN(16, 20), endedAt: CN(16, 22), current: true }],
			{ now: new Date(Date.parse(CN(16, 23))), isLive: true },
		);
		expect(got.hours).toBeCloseTo(3, 5);
	});

	it("同一条记录,引擎说不在播 → 照旧按盘上的 end 算,不拿 now 硬凑", () => {
		// 另一种可能的来源:真下播之后又写了一帧同时刻的 start。store 分不出这两者,
		// 所以 `current` 只说「最后一次观测时敞着」,拍板的是 isLive。
		const got = summarizeLiveSessions(
			[{ startedAt: CN(16, 20), endedAt: CN(16, 22), current: true }],
			{ now: new Date(Date.parse(CN(16, 23))), isLive: false },
		);
		expect(got.hours).toBeCloseTo(2, 5);
	});

	it("在播时长会随时间增长 —— 这个数按定义就是时点相关的", () => {
		const s = [{ startedAt: CN(16, 20), current: true }];
		const a = summarizeLiveSessions(s, { now: new Date(Date.parse(CN(16, 21))), isLive: true });
		const b = summarizeLiveSessions(s, { now: new Date(Date.parse(CN(16, 23))), isLive: true });
		expect(b.hours).toBeGreaterThan(a.hours);
	});

	it("崩溃遗留的未闭合 start 不计时长 —— 只有最后一场才可能是真·在播", () => {
		// 5/15 开播后进程被杀,end 帧永远没写;5/16 正常播了一场 2 小时。
		// 若把那条悬空的 start 也按「到现在」算,它会一直涨到滑出时间窗为止。
		const got = summarizeLiveSessions(
			[{ startedAt: CN(15, 10) }, { startedAt: CN(16, 20), endedAt: CN(16, 22) }],
			{ now: new Date(Date.parse(CN(16, 23))), isLive: false },
		);
		expect(got.hours).toBeCloseTo(2, 5);
	});

	it("最后一场未闭合但 UP 此刻并不在播(丢了 end 帧)→ 不计时长", () => {
		// 在播状态由调用方从引擎拿,是唯一权威。没有它就无法区分「正在播」
		// 和「播完了但 end 帧丢了」,后者按到现在算会无限增长。
		const got = summarizeLiveSessions([{ startedAt: CN(16, 20) }], {
			now: new Date(Date.parse(CN(16, 23))),
			isLive: false,
		});
		expect(got.sessions).toBe(1);
		expect(got.hours).toBe(0);
	});

	it("已闭合的场不受 now 影响 —— 历史数据保持幂等", () => {
		const s = [{ startedAt: CN(15, 10), endedAt: CN(15, 13) }];
		const a = summarizeLiveSessions(s, { now: new Date(Date.parse(CN(16, 21))) });
		const b = summarizeLiveSessions(s, { now: new Date(Date.parse(CN(20, 21))) });
		expect(a.hours).toBe(b.hours);
	});

	it("开播时间晚于 now(时钟漂移)时夹成 0,不出负时长", () => {
		const got = summarizeLiveSessions([{ startedAt: CN(16, 22), current: true }], {
			now: new Date(Date.parse(CN(16, 20))),
			isLive: true,
		});
		expect(got.hours).toBe(0);
	});

	it("已闭合与在播混合时两者相加", () => {
		const got = summarizeLiveSessions(
			[
				{ startedAt: CN(15, 10), endedAt: CN(15, 12) },
				{ startedAt: CN(16, 20), current: true },
			],
			{ now: new Date(Date.parse(CN(16, 23))), isLive: true },
		);
		expect(got.sessions).toBe(2);
		// 已闭合的 2h + 在播的 3h
		expect(got.hours).toBeCloseTo(5, 5);
	});

	it("峰值取全窗口最大,场均取各场峰值的平均", () => {
		const got = summarizeLiveSessions([
			{ startedAt: CN(15, 10), endedAt: CN(15, 12), peakViewers: "1万" },
			{ startedAt: CN(16, 10), endedAt: CN(16, 12), peakViewers: "3万" },
		]);
		expect(got.peakViewers).toBe(30000);
		expect(got.avgPeakViewers).toBe(20000);
	});

	it("没有任何峰值样本 → 峰值/场均为 null,不返回 0", () => {
		const got = summarizeLiveSessions([{ startedAt: CN(15, 10), endedAt: CN(15, 12) }]);
		expect(got.peakViewers).toBeNull();
		expect(got.avgPeakViewers).toBeNull();
	});

	it("空输入 → 全零场次、零时长、null 峰值", () => {
		expect(summarizeLiveSessions([])).toEqual({
			sessions: 0,
			hours: 0,
			timedSessions: 0,
			peakViewers: null,
			avgPeakViewers: null,
		});
	});
});

describe("dailyActivityCounts — 逐日活动次数(热力图数据源)", () => {
	const now = new Date(CN(16, 23));
	const opts = { days: 3, tzOffsetMin: TZ_CN, now };

	it("动态 / 投稿 / 开播都算一次活动,按本地日归并", () => {
		const got = dailyActivityCounts(
			[
				{ id: "a", type: "DYNAMIC_TYPE_AV", ts: CN(15, 10) },
				{ id: "b", type: "DYNAMIC_TYPE_WORD", ts: CN(15, 20) },
				{ id: "c", type: "DYNAMIC_TYPE_DRAW", ts: CN(16, 9) },
			],
			[{ startedAt: CN(16, 21), endedAt: CN(16, 22) }],
			opts,
		);
		// 14 号无活动、15 号两条动态、16 号一条动态 + 一场直播
		expect(got).toEqual([0, 2, 2]);
	});

	it("开播伪动态不计 —— 否则一场直播会同时算进动态和开播", () => {
		const got = dailyActivityCounts(
			[{ id: "a", type: "DYNAMIC_TYPE_LIVE_RCMD", ts: CN(16, 10) }],
			[{ startedAt: CN(16, 10), endedAt: CN(16, 12) }],
			opts,
		);
		expect(got.at(-1)).toBe(1);
	});

	it("长度恒等于 days,无活动的日子是 0", () => {
		expect(dailyActivityCounts([], [], opts)).toEqual([0, 0, 0]);
	});

	it("窗口外的事件不计入", () => {
		const got = dailyActivityCounts(
			[{ id: "old", type: "DYNAMIC_TYPE_WORD", ts: CN(1, 10) }],
			[],
			opts,
		);
		expect(got).toEqual([0, 0, 0]);
	});
});

describe("summarizeLiveSessions — 时长已知的场次数", () => {
	it("时长未知的场次不进 timedSessions,免得把场均时长稀释掉", () => {
		// 场均时长 = 总时长 ÷ 场次。悬空那场时长未知、按 0 计,若它也进分母,
		// 「一场 4 小时 + 一场未知」会算成场均 2 小时 —— 两场里没有任何一场是 2 小时。
		const got = summarizeLiveSessions(
			[{ startedAt: CN(15, 10), endedAt: CN(15, 14) }, { startedAt: CN(16, 20) }],
			{ now: new Date(Date.parse(CN(16, 23))), isLive: false },
		);
		expect(got.sessions).toBe(2);
		expect(got.hours).toBeCloseTo(4, 5);
		expect(got.timedSessions).toBe(1);
	});

	it("在播那场算「时长已知」—— 它的时长是有意义的进行时数字", () => {
		const got = summarizeLiveSessions([{ startedAt: CN(16, 20), current: true }], {
			now: new Date(Date.parse(CN(16, 22))),
			isLive: true,
		});
		expect(got.timedSessions).toBe(1);
	});

	it("全部闭合时与场次数一致", () => {
		const got = summarizeLiveSessions([
			{ startedAt: CN(15, 10), endedAt: CN(15, 13) },
			{ startedAt: CN(16, 20), endedAt: CN(16, 22) },
		]);
		expect(got.timedSessions).toBe(2);
	});

	it("闭合但时长为负(时钟回拨)的场次同样不进分母", () => {
		// 回归:`timedSessions++` 曾在 `ms > 0` 判断之外无条件执行,于是这一场
		// **不计时长却计分母** —— 一场 4 小时 + 一场坏数据 = 场均 2 小时,
		// 又回到了这组测试开头要杜绝的那个数。end 早于 start 只可能是坏数据,
		// 与「悬空未闭合」一样属于时长未知,不是时长为零。
		const got = summarizeLiveSessions([
			{ startedAt: CN(15, 10), endedAt: CN(15, 14) },
			{ startedAt: CN(16, 20), endedAt: CN(16, 19) },
		]);
		expect(got.sessions).toBe(2);
		expect(got.hours).toBeCloseTo(4, 5);
		expect(got.timedSessions).toBe(1);
	});

	it("end 时刻解析不出来的场次不进分母", () => {
		const got = summarizeLiveSessions([
			{ startedAt: CN(15, 10), endedAt: CN(15, 14) },
			{ startedAt: CN(16, 20), endedAt: "不是时间" },
		]);
		expect(got.hours).toBeCloseTo(4, 5);
		expect(got.timedSessions).toBe(1);
	});
});

describe("summarizeLiveSessions — 在播那场靠标记认,不靠数组位置", () => {
	it("被标记 current 的场次即使不在末尾,也按「到现在」计时长", () => {
		// listLiveSessions 按 startedAt 认场次,早先的场次可能被重新打开 ——
		// 于是「敞开的那场」不再必然排在数组末尾。靠位置猜会记到错的那场头上。
		const got = summarizeLiveSessions(
			[{ startedAt: CN(16, 1), current: true }, { startedAt: CN(16, 2) }],
			{ now: new Date(Date.parse(CN(16, 5))), isLive: true },
		);
		// 在播的是 01:00 那场 → 4h;末尾那场是悬空记录,不计时长。
		expect(got.hours).toBeCloseTo(4, 5);
	});

	it("没有任何场次被标记 current → 都是悬空记录,一律不计时长", () => {
		const got = summarizeLiveSessions([{ startedAt: CN(16, 1) }, { startedAt: CN(16, 2) }], {
			now: new Date(Date.parse(CN(16, 5))),
			isLive: true,
		});
		expect(got.hours).toBe(0);
	});
});

describe("summarizeLiveSessions — isLive 是悬空记录的止损闸门", () => {
	// 覆盖缺口回归:所有 `current: true` 的用例此前都配 `isLive: true`,所有
	// `isLive: false` 的用例都用不带 `current` 的场次 —— 两个守卫只在对角线上
	// 被验过,于是把 `&& opts.isLive === true` 整条删掉,全仓测试照样全绿。
	//
	// 这个守卫拦的是:进程被杀 → 场次留着 `current` 标记 → 重启回来时 UP 早已
	// 下播。若只认 `current`,这条悬空记录会一路涨到滑出时间窗为止(90 天窗口
	// ≈ 2160 小时),把「直播时长 Top」彻底冲垮。
	it("标了 current 但 UP 此刻并不在播 → 不计时长,也不进分母", () => {
		const got = summarizeLiveSessions([{ startedAt: CN(16, 20), current: true }], {
			now: new Date(Date.parse(CN(18, 20))), // 两天后才重启回来
			isLive: false,
		});
		expect(got.sessions).toBe(1);
		expect(got.hours).toBe(0);
		expect(got.timedSessions).toBe(0);
	});

	it("缺省不传 isLive 时按「不在播」处理 —— 拿不到权威状态宁可少算", () => {
		const got = summarizeLiveSessions([{ startedAt: CN(16, 20), current: true }], {
			now: new Date(Date.parse(CN(18, 20))),
		});
		expect(got.hours).toBe(0);
		expect(got.timedSessions).toBe(0);
	});
});

describe("summarizeLiveSessions — 观看数字符串的解析", () => {
	// 覆盖缺口回归:测试数据此前只用过「万」和裸数字,「亿」分支和解析失败分支
	// 从没被碰过 —— 把亿的乘数改成 ×1、或让解析失败返回 0,都无人发现。
	const withPeak = (peak: string) => [
		{ startedAt: CN(16, 20), endedAt: CN(16, 22), peakViewers: peak },
	];

	it("「亿」按 1e8 换算,不是当成裸数字", () => {
		expect(summarizeLiveSessions(withPeak("1.2亿")).peakViewers).toBe(120_000_000);
	});

	it("「万」按 1e4 换算", () => {
		expect(summarizeLiveSessions(withPeak("1.2万")).peakViewers).toBe(12_000);
	});

	it("裸数字原样取用", () => {
		expect(summarizeLiveSessions(withPeak("9500")).peakViewers).toBe(9500);
	});

	it("解析不出的字符串整场跳过,不是当成 0 混进平均值", () => {
		// 「未知不是零」——一个静默的 0 会把场均峰值拖下水,而且看不出来。
		const got = summarizeLiveSessions([
			{ startedAt: CN(15, 10), endedAt: CN(15, 12), peakViewers: "1万" },
			{ startedAt: CN(16, 20), endedAt: CN(16, 22), peakViewers: "看不懂" },
		]);
		expect(got.peakViewers).toBe(10_000);
		expect(got.avgPeakViewers).toBe(10_000);
	});

	it("所有场次的峰值都解析不出 → null,而不是 0", () => {
		const got = summarizeLiveSessions(withPeak("???"));
		expect(got.peakViewers).toBeNull();
		expect(got.avgPeakViewers).toBeNull();
	});
});
