/**
 * 单元测试 — 能力画像的归一化。
 *
 * 这层单独抽出来是因为雷达图最容易「看起来很合理但算错」:六根轴都在 0..1 之间,
 * 画出来永远是个像模像样的多边形,口径错了肉眼根本发现不了。所以把口径全部钉在
 * 这里,`RadarChart` 只剩下摆坐标的活。
 */

import { describe, expect, it } from "vite-plus/test";
import type { UpStatsRow } from "../../services/stats.js";
import { buildRadarAxes, normalizeAxis } from "./radar.js";

function row(over: Partial<UpStatsRow> = {}): UpStatsRow {
	return {
		uid: "1",
		fans: 10_000,
		net1d: 10,
		net7d: 100,
		netWindow: 100,
		series: [],
		activity: [],
		archives: 2,
		dynamics: 5,
		liveSessions: 1,
		liveHours: 3,
		liveTimedSessions: 0,
		peakViewers: 500,
		avgPeakViewers: 500,
		lastActivityAt: null,
		live: false,
		...over,
	};
}

describe("normalizeAxis — null 不得当成 0", () => {
	it("值为 null → null(调用方要画成「无记录」,而不是零长度的轴)", () => {
		expect(normalizeAxis(null, [1, 2, null])).toBeNull();
	});

	it("组内全是 null → null", () => {
		expect(normalizeAxis(null, [null, null])).toBeNull();
	});

	it("别人是 null 不影响自己的归一化", () => {
		expect(normalizeAxis(10, [10, null])).toBe(1);
	});

	it("真实的 0 归一到圆心,而不是 null", () => {
		expect(normalizeAxis(0, [0, 10])).toBe(0);
	});
});

describe("normalizeAxis — 相对位置", () => {
	it("组内最大值满格", () => {
		expect(normalizeAxis(10, [2, 6, 10])).toBe(1);
	});

	it("计数类以 0 为圆心,不因为组内最小值非零就被抬起来", () => {
		// 只订阅 5 和 10 两位:5 应当是半格,而不是「组内垫底 → 0」。
		expect(normalizeAxis(5, [5, 10])).toBe(0.5);
	});

	it("全组同为 0 → 一律回到圆心,不是满格", () => {
		expect(normalizeAxis(0, [0, 0])).toBe(0);
	});

	it("全组同为一个非零值 → 并列满格", () => {
		expect(normalizeAxis(5, [5, 5])).toBe(1);
	});
});

describe("normalizeAxis — 掉粉必须区分得出来", () => {
	it("掉得多和掉得少不再是同一个值(旧实现把负数一律压成 0)", () => {
		const worst = normalizeAxis(-10_000, [-10_000, -100]);
		const mild = normalizeAxis(-100, [-10_000, -100]);
		expect(worst).toBe(0);
		expect(mild as number).toBeGreaterThan(0);
	});

	it("全组都在掉粉时,谁也拿不到满格 —— 满格留给「0 净增」", () => {
		expect(normalizeAxis(-100, [-10_000, -100]) as number).toBeLessThan(1);
	});

	it("有涨有跌时,0 净增落在圆心与满格之间", () => {
		const v = normalizeAxis(0, [-5000, 15_000]) as number;
		expect(v).toBeGreaterThan(0);
		expect(v).toBeLessThan(1);
	});

	it("涨得最多的满格,跌得最多的到圆心", () => {
		expect(normalizeAxis(15_000, [-5000, 15_000])).toBe(1);
		expect(normalizeAxis(-5000, [-5000, 15_000])).toBe(0);
	});
});

describe("normalizeAxis — 对数刻度(粉丝数是重尾分布)", () => {
	it("小 UP 不再被大 UP 压成一根针", () => {
		const linear = normalizeAxis(50_000, [50_000, 2_000_000]) as number;
		const log = normalizeAxis(50_000, [50_000, 2_000_000], "log") as number;
		expect(log).toBeGreaterThan(linear);
	});

	it("最大值仍然满格", () => {
		expect(normalizeAxis(2_000_000, [50_000, 2_000_000], "log")).toBeCloseTo(1, 10);
	});

	it("0 仍然在圆心", () => {
		expect(normalizeAxis(0, [0, 2_000_000], "log")).toBe(0);
	});

	it("组内出现负值时退回线性 —— 对数在负半轴没有定义", () => {
		expect(normalizeAxis(-100, [-10_000, -100], "log")).toBe(
			normalizeAxis(-100, [-10_000, -100], "linear"),
		);
	});
});

describe("buildRadarAxes", () => {
	it("涨粉势头吃整个窗口的净增,与页面顶部选的天数同步", () => {
		// 用 netWindow 而不是 net7d:切到近90日时其余五轴都按 90 天算,
		// 涨粉势头却还是 7 天的话,同一张图里就有两把尺子。
		const a = row({ uid: "1", net7d: 1, netWindow: 9000 });
		const b = row({ uid: "2", net7d: 9000, netWindow: 1 });
		const axis = buildRadarAxes(a, [a, b])?.find((x) => x.label === "涨粉势头");
		expect(axis?.value).toBe(1);
	});

	it("六根轴各取各的字段 —— 哨兵值逐轴对位", () => {
		// 曾经只断言了「涨粉势头」与「粉丝规模」两根,其余四根仅被 toHaveLength(6)
		// 数了个数:把「投稿量」的 pick 换成 r.dynamics 照样全绿。这里给每个字段一个
		// 互不相同的哨兵值,任何一轴接错线都会在 display 上露馅。
		const a = row({
			uid: "1",
			fans: 1000,
			netWindow: 11,
			archives: 22,
			dynamics: 33,
			liveSessions: 44,
			liveHours: 55,
		});
		const b = row({ uid: "2", fans: 2000 });
		const byLabel = Object.fromEntries(
			(buildRadarAxes(a, [a, b]) ?? []).map((x) => [x.label, x.display]),
		);
		expect(byLabel.投稿量).toBe("22 个");
		expect(byLabel.动态量).toBe("33 条");
		expect(byLabel.开播场次).toBe("44 场");
		expect(byLabel.直播时长).toBe("55h");
	});

	it("某维度无记录 → 该轴 value 为 null,不拿 0 顶格", () => {
		// 无采集覆盖时这几项是 null。归一化成 0 会把「不知道」画成「垫底」,
		// 那根轴看着就是这位 UP 在这个维度上最差 —— 而事实是我们没在记。
		const a = row({ uid: "1", archives: null, liveHours: null });
		const b = row({ uid: "2", archives: 10, liveHours: 10 });
		const byLabel = Object.fromEntries(
			(buildRadarAxes(a, [a, b]) ?? []).map((x) => [x.label, x.value]),
		);
		expect(byLabel.投稿量).toBeNull();
		expect(byLabel.直播时长).toBeNull();
	});

	it("只订阅 1 位 UP 时不出图 —— 六根轴全会是满格,零信息量", () => {
		const only = row({ uid: "1" });
		expect(buildRadarAxes(only, [only])).toBeNull();
	});

	it("两位起就能画", () => {
		const a = row({ uid: "1" });
		const b = row({ uid: "2", fans: 50_000 });
		expect(buildRadarAxes(a, [a, b])).toHaveLength(6);
	});

	it("每根轴都带上原始值 —— 半径只表达相对位置,真值必须并排给出", () => {
		const a = row({ uid: "1", netWindow: -8200 });
		const b = row({ uid: "2", netWindow: 12_000 });
		const axes = buildRadarAxes(a, [a, b]);
		expect(axes?.find((x) => x.label === "涨粉势头")?.display).toBe("−8200");
	});

	it("无记录的维度标成「无记录」且 value 为 null", () => {
		const a = row({ uid: "1", fans: null });
		const b = row({ uid: "2" });
		const axis = buildRadarAxes(a, [a, b])?.find((x) => x.label === "粉丝规模(当前)");
		expect(axis?.value).toBeNull();
		expect(axis?.display).toBe("无记录");
	});

	it("掉粉的 UP 在涨粉势头上不会满格", () => {
		const a = row({ uid: "1", netWindow: -500 });
		const b = row({ uid: "2", netWindow: -100 });
		const axis = buildRadarAxes(a, [a, b])?.find((x) => x.label === "涨粉势头");
		expect(axis?.value as number).toBeLessThan(1);
	});
});
