/**
 * 卡片上的时刻写法。卡片上的计数(万 / 亿)与时长不在这里:全仓只有一份,
 * 住在 `@bilibili-notify/internal` 的 `format`(`formatCount` / `formatDuration`)。
 */

/**
 * 卡片上的时刻写法(本机时区):`2026年09月24日 12:00:05`。动态卡的发布时间用它 —— B 站的动态与
 * 拓展的作品(ADR-0019 决策 69)排成同一个样子,别处各抄一份的话迟早分道扬镳。收 Unix **秒**。
 */
export function formatCardTime(unixSeconds: number): string {
	const d = new Date(unixSeconds * 1000);
	const pad = (n: number) => `0${n}`.slice(-2);
	return `${d.getFullYear()}年${pad(d.getMonth() + 1)}月${pad(d.getDate())}日 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
