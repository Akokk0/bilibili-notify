/**
 * 对比表的 CSV 导出 —— 表头与取值的**唯一**来源。
 *
 * 拆出来的理由与 `columns.ts` 完全相同,而且是同一个坑的第二现场:屏幕上那张表
 * 曾经由「表头数组 + 手写 `<td>`」两份平行名单拼出来,插一列就整体错位;那次修
 * 干净了,CSV 这边却原样复刻着同一个反模式 —— 而且它一行测试都没有,错位了只会
 * 安静地导出一份列名与数据对不上的表格,拿去做统计的人还以为是自己算错了。
 *
 * 现在表头与取值绑在同一个对象上,插列 / 删列 / 换顺序都不可能只改一半。
 * 纯函数,不碰 DOM —— 下载那几行留在调用方,这里可以直接被测试拿去跑。
 */

import type { UpStatsRow } from "../../services/stats";

/** 一列:表头文案与取值绑在一起,位置即对应关系,不再靠人肉对齐两个数组。 */
export interface CsvColumn {
	header: string;
	/** `nameOf` 由调用方注入 —— UP 昵称在缓存的 profile 里,不在统计行上。 */
	value: (r: UpStatsRow, nameOf: (uid: string) => string) => string;
}

/**
 * 无记录写空单元格,不写 0。
 *
 * 导出的表是要拿去继续算的,一个假的 0 会污染下游的平均值 —— 与页面上显示「—」
 * 是同一条口径,只是 CSV 里空单元格才是惯例写法。
 */
const cell = (v: number | null, fmt: (n: number) => string = String) => (v === null ? "" : fmt(v));

export function csvColumns(days: number): CsvColumn[] {
	return [
		{ header: "UP 主", value: (r, nameOf) => nameOf(r.uid) },
		{ header: "UID", value: (r) => r.uid },
		{ header: "粉丝数", value: (r) => cell(r.fans) },
		{ header: "近7日粉丝", value: (r) => cell(r.net7d) },
		{ header: `近${days}日粉丝`, value: (r) => cell(r.netWindow) },
		// 列序跟着屏幕上那张表走(见 columns.ts):导出的就是它,两边不一致的话
		// 拿 CSV 对屏幕的人会以为自己看串行了。
		{ header: "投稿", value: (r) => cell(r.archives) },
		{ header: "动态", value: (r) => cell(r.dynamics) },
		{ header: "直播场次", value: (r) => cell(r.liveSessions) },
		{ header: "直播时长(h)", value: (r) => cell(r.liveHours, (n) => n.toFixed(1)) },
		{ header: "峰值观看", value: (r) => cell(r.peakViewers) },
		{ header: "最后活动", value: (r) => r.lastActivityAt ?? "" },
	];
}

/** 昵称里出现逗号 / 引号 / 换行会撕裂列,按 RFC4180 转义。 */
function escapeCell(s: string): string {
	return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** 生成完整 CSV 文本(不含 BOM —— 那是下载环节的事)。 */
export function buildCsv(
	rows: readonly UpStatsRow[],
	days: number,
	nameOf: (uid: string) => string,
): string {
	const cols = csvColumns(days);
	const head = cols.map((c) => escapeCell(c.header)).join(",");
	const body = rows.map((r) => cols.map((c) => escapeCell(c.value(r, nameOf))).join(","));
	return [head, ...body].join("\n");
}
