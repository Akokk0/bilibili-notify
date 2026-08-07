/**
 * 统计范围的三档预设。
 *
 * 页头的范围切换与定时周报的「统计范围」共用同一份 —— 页面上看的是「近 30 日」、
 * 周报里配的也该是同一把尺子,两处各写各的迟早会分叉(一边加了近 180 日、另一边
 * 没加,主人对着两个不一样的下拉框猜哪个才算数)。
 *
 * 放在这里而不是 Stats.tsx 里:RoastScheduleBox 是被 Stats.tsx import 的,反过来
 * 从页面里取常量会绕成循环依赖。
 */
export const STATS_RANGES = [
	{ days: 7, label: "近7日" },
	{ days: 30, label: "近30日" },
	{ days: 90, label: "近90日" },
] as const;
