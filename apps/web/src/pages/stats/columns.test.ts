/**
 * 列定义的不变式 —— 守「表头写的是哪个字段,格子里就必须是哪个字段」。
 *
 * 回归:表头与表体曾是两份手写的平行名单,最后三列整体错位一格。表头「直播时长」
 * 那格显示的是开播场次(一个整数),「动态」那格显示的是 `0.1h`。主人添加了一位
 * 正在直播的 UP 之后一眼看出来的 —— 而 typecheck、lint、既有测试全绿。
 */

import { describe, expect, it } from "vite-plus/test";
import type { UpStatsRow } from "../../services/stats";
import { buildStatColumns, type StatColumnId } from "./columns";

const PALETTE = { blue: "#00aeec", pink: "#fb7299", purple: "#a29bfe" };
const FMT = { hours: (v: number) => v.toFixed(1), num: (v: number | null) => String(v ?? "—") };

/** 每个数值字段给一个互不相同的哨兵值,取错字段立刻暴露。 */
const SENTINEL: Record<StatColumnId, number> = {
	net7d: 11,
	netWindow: 22,
	archives: 33,
	liveSessions: 44,
	liveHours: 55,
	dynamics: 66,
	peakViewers: 77,
};

const row: UpStatsRow = {
	uid: "1",
	fans: 1000,
	net1d: 99,
	// 场均时长的分母,不参与表格列。
	liveTimedSessions: 44,
	series: [],
	activity: [],
	avgPeakViewers: null,
	lastActivityAt: null,
	live: false,
	...SENTINEL,
};

describe("buildStatColumns", () => {
	const cols = buildStatColumns(30, PALETTE, FMT);

	it("每列取的都是自己 id 对应的字段 —— 表头和数据不许错位", () => {
		for (const c of cols) {
			expect(c.value(row), `列「${c.label}」(id=${c.id}) 取错了字段`).toBe(SENTINEL[c.id]);
		}
	});

	it("id 不重复,且覆盖全部七个数值维度", () => {
		const ids = cols.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(new Set(ids)).toEqual(new Set(Object.keys(SENTINEL)));
	});

	it("直播时长带 h 后缀,场次与动态是裸整数 —— 单位串了就是错位的信号", () => {
		const cell = (id: StatColumnId) => {
			const c = cols.find((x) => x.id === id);
			if (!c) throw new Error(`缺列 ${id}`);
			return c.format?.(c.value(row)) ?? "";
		};
		expect(cell("liveHours")).toBe("55.0h");
		expect(cell("liveSessions")).toBe("44");
		expect(cell("dynamics")).toBe("66");
	});

	it("窗口天数进表头", () => {
		expect(buildStatColumns(7, PALETTE, FMT)[1]?.label).toBe("近7日粉丝");
		expect(buildStatColumns(90, PALETTE, FMT)[1]?.label).toBe("近90日粉丝");
	});
});
