/**
 * 单元测试 — CSV 导出。
 *
 * 核心守的是**表头与数据同源**:曾经是两份手写平行名单,靠位置对齐。屏幕上那张
 * 表因为同样的写法整体错位过一次(见 columns.ts),CSV 这边零覆盖,错了也没人知道。
 *
 * 所以下面用**哨兵值**:每个数值字段给一个互不相同的数,一旦某列取错字段,
 * 断言立刻能指出错到哪一列 —— 而不是「长度对得上就算过」。
 *
 * 两支订阅都导(ADR-0020):身份那几列是「平台 / UID / 外部 ID」—— 「UID」照旧只放 B 站的 uid(老的导出拿它
 * 对账的照样对得上),拓展行的外部 id 另起一列,不塞进 UID(另一个平台上的另一个人,ADR-0019 决策 73)。
 */

import { describe, expect, it } from "vite-plus/test";
import type { UpStatsRow } from "../../services/stats.js";
import { buildCsv, type CsvWho, csvColumns } from "./csv.js";

/** 每个字段一个独一无二的哨兵值,任何一列取错都会露馅。 */
function sentinel(over: Partial<UpStatsRow> = {}): UpStatsRow {
	return {
		subscriptionId: "s777",
		uid: "777",
		fans: 1,
		net1d: 2,
		net7d: 3,
		netWindow: 4,
		series: [],
		cumulative: [],
		activity: [],
		archives: 5,
		dynamics: 6,
		liveSessions: 7,
		liveHours: 8,
		liveTimedSessions: 9,
		maxViewers: 10,
		avgViewers: 11,
		lastActivityAt: "2026-05-16T00:00:00.000Z",
		live: false,
		...over,
	};
}

/** 拓展行:带拓展 id + 外部 id、不带 uid。 */
function extSentinel(over: Partial<UpStatsRow> = {}): UpStatsRow {
	const { uid: _uid, ...rest } = sentinel(over);
	return { ...rest, subscriptionId: "s-dy", extensionId: "douyin", externalId: "sec-1" };
}

const who: CsvWho = {
	nameOf: (r) => `名字-${r.uid ?? r.externalId}`,
	platformOf: (r) => (r.extensionId === "douyin" ? "抖音" : "B 站"),
};

describe("csvColumns", () => {
	it("窗口天数进表头", () => {
		expect(csvColumns(7).map((c) => c.header)).toContain("近7日粉丝");
		expect(csvColumns(90).map((c) => c.header)).toContain("近90日粉丝");
	});

	it("每一列都取到它自己那个字段 —— 哨兵值逐列对位", () => {
		const cols = csvColumns(30);
		const got = Object.fromEntries(cols.map((c) => [c.header, c.value(sentinel(), who)]));
		expect(got).toEqual({
			"UP 主": "名字-777",
			平台: "B 站",
			UID: "777",
			"外部 ID": "",
			粉丝数: "1",
			近7日粉丝: "3",
			近30日粉丝: "4",
			投稿: "5",
			动态: "6",
			直播场次: "7",
			"直播时长(h)": "8.0",
			单场最高观看: "10",
			最后活动: "2026-05-16T00:00:00.000Z",
		});
	});

	it("拓展行:平台写平台名、外部 id 进自己那一列,UID 空着 —— 外部 id 不塞进 UID", () => {
		const cols = csvColumns(30);
		const got = Object.fromEntries(cols.map((c) => [c.header, c.value(extSentinel(), who)]));
		expect(got).toMatchObject({
			"UP 主": "名字-sec-1",
			平台: "抖音",
			UID: "",
			"外部 ID": "sec-1",
			粉丝数: "1",
			单场最高观看: "10",
		});
	});

	it("列序跟屏幕上那张表一致 —— 上面那条是对象比较,钉不住顺序", () => {
		// 导出的就是屏幕上那张表,两边列序必须同步(见 columns.ts 的分组说明):
		// 「投稿」与「动态」相邻,直播三列成组。只改一边的话这条会红。
		expect(csvColumns(30).map((c) => c.header)).toEqual([
			"UP 主",
			"平台",
			"UID",
			"外部 ID",
			"粉丝数",
			"近7日粉丝",
			"近30日粉丝",
			"投稿",
			"动态",
			"直播场次",
			"直播时长(h)",
			"单场最高观看",
			"最后活动",
		]);
	});
});

describe("buildCsv", () => {
	it("表头列数与数据列数恒等 —— 这是同源写法要保证的第一件事", () => {
		const lines = buildCsv([sentinel(), extSentinel(), sentinel({ uid: "888" })], 30, who).split(
			"\n",
		);
		const width = lines[0]?.split(",").length;
		expect(width).toBe(csvColumns(30).length);
		for (const line of lines.slice(1)) expect(line.split(",")).toHaveLength(width);
	});

	it("无记录写空单元格,不写 0 —— 导出的表要能直接拿去算", () => {
		const csv = buildCsv([sentinel({ fans: null, archives: null, liveHours: null })], 30, who);
		const cells = csv.split("\n")[1]?.split(",") ?? [];
		expect(cells[4]).toBe(""); // 粉丝数
		expect(cells[7]).toBe(""); // 投稿
		expect(cells[10]).toBe(""); // 直播时长
	});

	it("0 照常写 0,不与无记录混为一谈", () => {
		const csv = buildCsv([sentinel({ archives: 0, liveHours: 0 })], 30, who);
		const cells = csv.split("\n")[1]?.split(",") ?? [];
		expect(cells[7]).toBe("0");
		expect(cells[10]).toBe("0.0");
	});

	it("昵称里的逗号 / 引号按 RFC4180 转义,不撕裂列", () => {
		const csv = buildCsv([sentinel()], 30, { ...who, nameOf: () => 'A,B"C' });
		const line = csv.split("\n")[1] ?? "";
		expect(line.startsWith('"A,B""C",')).toBe(true);
		// 转义之后列数仍然对得上 —— 撕裂的话这里会多出一列。
		expect(line.split(",").length).toBeGreaterThanOrEqual(csvColumns(30).length);
	});

	it("空行集也产出表头,导出的文件不会是空的", () => {
		expect(buildCsv([], 30, who)).toBe(
			csvColumns(30)
				.map((c) => c.header)
				.join(","),
		);
	});
});
