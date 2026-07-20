/**
 * UP 主数据对比表的列定义 —— 表头与单元格的**唯一**来源。
 *
 * 拆出来是因为踩过:表头由一个 `cols` 数组生成、表体是一串手写 `<td>`,两份平行
 * 名单各自维护。有人插了一列之后,「直播场次 / 直播时长 / 动态」三列的数据整体
 * 错位一格 —— 表头写着「直播时长」的格子里显示的是场次数,「动态」那格显示的是
 * `0.1h`。typecheck 全绿(每个 `<td>` 单看都合法),测试也测不到,只有肉眼看得出。
 *
 * 现在每列自带取值函数,表头和数据从同一个数组渲染,顺序天然一致。列的取值必须
 * 是它自己 `id` 对应的字段 —— 这条不变式由 `columns.test.ts` 钉死。
 */

import type { UpStatsRow } from "../../services/stats";
import { dash } from "./chart-utils";

/** 可进表的数值字段。`UpStatsRow` 里的字符串 / 数组字段不参与排序与展示。 */
export type StatColumnId =
	| "net7d"
	| "netWindow"
	| "archives"
	| "liveSessions"
	| "liveHours"
	| "dynamics"
	| "peakViewers";

export interface StatColumn {
	id: StatColumnId;
	label: string;
	/** 取该列的原始值。排序与展示共用同一个入口,不会一个取 A 一个取 B。 */
	value: (r: UpStatsRow) => number | null;
	/**
	 * `delta` 走 DeltaTag(带正负号与涨跌配色),`text` 按 `format` 出纯文本。
	 * 放在数据层而不是让调用方 switch,是为了让「这列长什么样」跟着列走。
	 */
	kind: "delta" | "text";
	/** `kind: "text"` 时的格式化;缺省按 `num()` 处理由调用方兜。 */
	format?: (v: number | null) => string;
	/** 数字的着色;缺省用次要文本色。 */
	color?: string;
}

export interface ColumnPalette {
	blue: string;
	pink: string;
	purple: string;
}

/**
 * 组装列定义。`days` 进来只为拼「近N日粉丝」的表头,`palette` 由页面注入 ——
 * 颜色常量必须是十六进制字面量(见 Stats.tsx 的说明),不在这里重复定义。
 */
export function buildStatColumns(
	days: number,
	palette: ColumnPalette,
	fmt: { hours: (v: number) => string; num: (v: number | null) => string },
): StatColumn[] {
	return [
		{ id: "net7d", label: "近7日粉丝", value: (r) => r.net7d, kind: "delta" },
		{ id: "netWindow", label: `近${days}日粉丝`, value: (r) => r.netWindow, kind: "delta" },
		{
			id: "archives",
			label: "投稿",
			value: (r) => r.archives,
			kind: "text",
			format: (v) => dash(v),
			color: palette.blue,
		},
		{
			id: "liveSessions",
			label: "直播场次",
			value: (r) => r.liveSessions,
			kind: "text",
			format: (v) => dash(v),
			color: palette.pink,
		},
		{
			id: "liveHours",
			label: "直播时长",
			value: (r) => r.liveHours,
			kind: "text",
			format: (v) => dash(v, (n) => `${fmt.hours(n)}h`),
		},
		{
			id: "dynamics",
			label: "动态",
			value: (r) => r.dynamics,
			kind: "text",
			format: (v) => dash(v),
			color: palette.purple,
		},
		{
			id: "peakViewers",
			label: "峰值观看",
			value: (r) => r.peakViewers,
			kind: "text",
			format: (v) => fmt.num(v),
		},
	];
}
