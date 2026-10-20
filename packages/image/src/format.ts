/**
 * 卡片上的时刻写法。卡片上的计数(万 / 亿)与时长不在这里:全仓只有一份,
 * 住在 `@bilibili-notify/internal` 的 `format`(`formatCount` / `formatDuration`)。
 */

import { DateTime } from "luxon";

/**
 * 卡片上的时刻写法(按给的时区,全局时区设置):`2026年09月24日 12:00:05`。动态卡的发布时间用它 ——
 * B 站的动态与拓展的作品(ADR-0019 决策 69)排成同一个样子,别处各抄一份的话迟早分道扬镳。收 Unix **秒**。
 */
export function formatCardTime(unixSeconds: number, timezone: string): string {
	const at = DateTime.fromSeconds(unixSeconds, { zone: timezone });
	const pad = (n: number) => `0${n}`.slice(-2);
	return `${at.year}年${pad(at.month)}月${pad(at.day)}日 ${pad(at.hour)}:${pad(at.minute)}:${pad(at.second)}`;
}
