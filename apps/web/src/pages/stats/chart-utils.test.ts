/**
 * 单元测试 — 图表纯函数工具。
 *
 * 这些函数单独抽出来是因为图表本身只能靠肉眼验:把「数字怎么格式化」「序列在
 * 哪里断开」「取值范围怎么算」钉在测试里,SVG 组件就只剩下摆坐标的活。
 */

import { describe, expect, it } from "vite-plus/test";
import {
	compactSeries,
	dash,
	extent,
	formatSignedWan,
	formatWan,
	heatAxisLabels,
	heatCellStyle,
	niceTicks,
	signTone,
	splitSegments,
} from "./chart-utils.js";

describe("formatWan", () => {
	it("万以下原样取整", () => {
		expect(formatWan(0)).toBe("0");
		expect(formatWan(9999)).toBe("9999");
		expect(formatWan(123.6)).toBe("124");
	});

	it("万以上压缩成一位小数", () => {
		expect(formatWan(15000)).toBe("1.5万");
		expect(formatWan(12345)).toBe("1.2万");
	});

	it("整万不留 .0 尾巴", () => {
		expect(formatWan(20000)).toBe("2万");
	});

	it("百万以上不留小数(位数已经够多了)", () => {
		expect(formatWan(15473000)).toBe("1547万");
	});

	it("负数按绝对值决定档位,保留符号", () => {
		expect(formatWan(-15000)).toBe("-1.5万");
	});
});

describe("formatSignedWan", () => {
	it("正数带 +,负数带真减号", () => {
		expect(formatSignedWan(1200)).toBe("+1200");
		expect(formatSignedWan(-1200)).toBe("−1200");
	});

	it("0 视为正向,显示 +0", () => {
		expect(formatSignedWan(0)).toBe("+0");
	});

	it("大数走万压缩", () => {
		expect(formatSignedWan(-82000)).toBe("−8.2万");
	});
});

describe("splitSegments — null 断点", () => {
	it("无 null → 单段", () => {
		expect(splitSegments([1, 2, 3])).toEqual([[0, 1, 2]]);
	});

	it("中间的 null 把序列切成两段", () => {
		expect(splitSegments([1, 2, null, 4, 5])).toEqual([
			[0, 1],
			[3, 4],
		]);
	});

	it("首尾的 null 不产生空段", () => {
		expect(splitSegments([null, 1, 2, null])).toEqual([[1, 2]]);
	});

	it("孤立的单点自成一段 —— 折线画不出来,但散点要保住", () => {
		expect(splitSegments([null, 5, null, 7, null])).toEqual([[1], [3]]);
	});

	it("全 null → 无段", () => {
		expect(splitSegments([null, null])).toEqual([]);
	});

	it("空输入 → 无段", () => {
		expect(splitSegments([])).toEqual([]);
	});
});

describe("extent — 忽略 null 的取值范围", () => {
	it("取最小最大", () => {
		expect(extent([3, 1, 4, 1, 5])).toEqual({ min: 1, max: 5 });
	});

	it("跳过 null", () => {
		expect(extent([null, 2, null, 8])).toEqual({ min: 2, max: 8 });
	});

	it("全 null → null(调用方据此不渲染,而不是画一条 0 线)", () => {
		expect(extent([null, null])).toBeNull();
	});

	it("空输入 → null", () => {
		expect(extent([])).toBeNull();
	});

	it("单点 → min === max,由调用方负责撑开", () => {
		expect(extent([7])).toEqual({ min: 7, max: 7 });
	});
});

describe("niceTicks — 人类可读的坐标刻度", () => {
	it("刻度是整齐的档位,不是把范围均分五份", () => {
		// 直接均分会得到 -855 / 3134 / 7124 这种毛刺数字
		const { ticks } = niceTicks(-855, 15000);
		expect(ticks.every((t) => Number.isInteger(t / 5000) || Number.isInteger(t / 1000))).toBe(true);
	});

	it("范围被撑到刻度边界,数据不会顶到图顶或图底", () => {
		const { min, max, ticks } = niceTicks(120, 4800);
		expect(min).toBeLessThanOrEqual(120);
		expect(max).toBeGreaterThanOrEqual(4800);
		expect(ticks[0]).toBe(min);
		expect(ticks.at(-1)).toBe(max);
	});

	it("跨越正负时,0 必然落在某个刻度上(零基线要画得准)", () => {
		expect(niceTicks(-3000, 8000).ticks).toContain(0);
	});

	it("全正数据也能包含 0 作为基线", () => {
		expect(niceTicks(0, 15000).ticks).toContain(0);
	});

	it("全负数据同样包含 0", () => {
		expect(niceTicks(-15000, 0).ticks).toContain(0);
	});

	it("刻度单调递增且不重复", () => {
		const { ticks } = niceTicks(-855, 15000);
		expect([...new Set(ticks)]).toEqual(ticks);
		expect([...ticks].sort((a, b) => a - b)).toEqual(ticks);
	});

	it("刻度数量控制在 3..7,再多就糊了", () => {
		for (const [lo, hi] of [
			[0, 1],
			[-855, 15000],
			[0, 3],
			[-2, 2],
			[1000, 1001],
		]) {
			const { ticks } = niceTicks(lo as number, hi as number);
			expect(ticks.length).toBeGreaterThanOrEqual(3);
			expect(ticks.length).toBeLessThanOrEqual(7);
		}
	});

	it("min === max(数据全等)时也能撑开一个可用范围", () => {
		const { min, max, ticks } = niceTicks(500, 500);
		expect(max).toBeGreaterThan(min);
		expect(ticks.length).toBeGreaterThanOrEqual(3);
	});

	it("零范围(全 0)退化成一个含 0 的对称范围", () => {
		const { ticks } = niceTicks(0, 0);
		expect(ticks).toContain(0);
	});
});

describe("niceTicks — includeZero 关掉时(累计值类图表)", () => {
	it("不把 0 拉进范围 —— 否则百万级曲线会被压成贴顶直线", () => {
		const { min } = niceTicks(2_260_000, 2_270_000, { includeZero: false });
		expect(min).toBeGreaterThan(2_000_000);
	});

	it("范围仍然覆盖数据且刻度整齐", () => {
		const { min, max, ticks } = niceTicks(2_260_000, 2_270_000, { includeZero: false });
		expect(min).toBeLessThanOrEqual(2_260_000);
		expect(max).toBeGreaterThanOrEqual(2_270_000);
		expect(ticks.length).toBeGreaterThanOrEqual(3);
	});
});

describe("compactSeries — 迷你图去空洞", () => {
	it("丢掉 null,只留有数据的点", () => {
		expect(compactSeries([null, 1, null, 2, 3])).toEqual([1, 2, 3]);
	});

	it("全 null → 空数组(调用方据此不渲染)", () => {
		expect(compactSeries([null, null])).toEqual([]);
	});

	it("无空洞时原样返回", () => {
		expect(compactSeries([1, 2, 3])).toEqual([1, 2, 3]);
	});
});

describe("dash —— 「没记录」与「确实是 0」必须写法不同", () => {
	it("null / undefined → 「—」", () => {
		expect(dash(null)).toBe("—");
		expect(dash(undefined)).toBe("—");
	});

	it("0 就写 0,不当成缺失", () => {
		expect(dash(0)).toBe("0");
	});

	it("透传格式化函数", () => {
		expect(dash(2.34, (n) => n.toFixed(1))).toBe("2.3");
		expect(dash(null, (n) => n.toFixed(1))).toBe("—");
	});
});

describe("niceTicks —— 整数量程不产出小数刻度", () => {
	it("全 0 的净增序列:刻度是 [-1,0,1],不是 [-1,-0.5,0,0.5,1]", () => {
		// 数据全等时区间被撑成 [-1,1],step 吸附到 0.5。渲染层用 `Math.round(tv)` 打标签,
		// 于是五条网格线标成 −1 / −0 / +0 / +1 / +1 —— 相邻两两重复,一根高度 1 的柱子
		// 会被读成落在两条「+1」线之间。粉丝净增是人数,0.5 个粉丝没有意义。
		const { ticks } = niceTicks(0, 0, { integer: true });
		expect(ticks).toEqual([-1, 0, 1]);
	});

	it("取整后的标签互不重复 —— 这才是那条 bug 的可观测面", () => {
		const { ticks } = niceTicks(0, 0, { integer: true });
		expect(new Set(ticks.map((t) => Math.round(t))).size).toBe(ticks.length);
	});

	it("量程够大时 integer 不改变既有吸附结果", () => {
		expect(niceTicks(0, 100, { integer: true })).toEqual(niceTicks(0, 100));
		expect(niceTicks(-30, 120, { integer: true })).toEqual(niceTicks(-30, 120));
	});
});

describe("heatAxisLabels —— 横轴刻度不能整体差一天", () => {
	it("最左是「天数−1」天前:最右那格是今天,不占一天跨度", () => {
		// 曾经直接写 `{days.length}天前` → 30 日窗口的最左格标成「30天前」,
		// 实际是 29 天前;而同屏净增柱状图用 `length−1−i`,两条横轴对不上。
		expect(heatAxisLabels(30)).toEqual(["29天前", "19天前", "10天前", "今天"]);
	});

	it("短窗口同样按 length−1 分配", () => {
		expect(heatAxisLabels(7)).toEqual(["6天前", "4天前", "2天前", "今天"]);
	});

	it("退化输入不产出负数刻度", () => {
		expect(heatAxisLabels(1)).toEqual(["0天前", "0天前", "0天前", "今天"]);
		expect(heatAxisLabels(0)).toEqual(["0天前", "0天前", "0天前", "今天"]);
	});
});

describe("heatCellStyle —— 无记录与零活动必须一眼可分", () => {
	// 回归:两者曾都是实心格、只差一点亮度(实测对比度 1.09:1),于是「还没开始
	// 采集」在页面上读作「这位 UP 什么都没发」。这组测试钉的是**区分手段本身**,
	// 不只是「两个值不相等」—— 单纯不等的两个近似灰照样看不出差别。
	it("无记录是空心描边,零活动是实心", () => {
		const none = heatCellStyle(null, "#ff0000");
		const zero = heatCellStyle(0, "#ff0000");
		expect(none.background).toBe("transparent");
		expect(none.boxShadow).toContain("inset");
		expect(zero.background).not.toBe("transparent");
		expect(zero.boxShadow).toBeUndefined();
	});

	it("有活动的格子一律实心,不带描边 —— 描边是无记录的专属信号", () => {
		for (const v of [1, 2, 3, 4, 9]) {
			const s = heatCellStyle(v, "#ff0000");
			expect(s.background).not.toBe("transparent");
			expect(s.boxShadow).toBeUndefined();
		}
	});

	it("活跃度越高底色越不透明", () => {
		const alphas = [1, 2, 3, 4].map((v) => heatCellStyle(v, "#ff0000").background);
		expect(alphas).toEqual(["#ff000044", "#ff000077", "#ff0000aa", "#ff0000dd"]);
	});

	it("活跃度超出色阶上限时夹到最深一档,不是越界成 undefined", () => {
		expect(heatCellStyle(99, "#ff0000").background).toBe("#ff0000dd");
	});
});

describe("signTone —— null 是独立一档,不能归零", () => {
	it("无记录既不是涨也不是跌", () => {
		expect(signTone(null)).toBe("unknown");
		expect(signTone(undefined)).toBe("unknown");
	});

	it("零净增算涨(与既有配色口径一致),负数算跌", () => {
		expect(signTone(0)).toBe("positive");
		expect(signTone(1)).toBe("positive");
		expect(signTone(-1)).toBe("negative");
	});
});
