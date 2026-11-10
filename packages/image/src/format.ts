import { packageLocale } from "@bilibili-notify/internal/texts";
/**
 * 卡片上的时刻写法。卡片上的计数(万 / 亿)与时长不在这里:全仓只有一份,
 * 住在 `@bilibili-notify/internal` 的 `format`(`formatCount` / `formatDuration`)。
 */

import { DateTime } from "luxon";

/**
 * 卡片的绝对时刻:按当前语言与给定时区排，精确到秒。作品发布时间与直播开播时刻共用，
 * 来源原始时间不改。收 Unix **秒**。
 */
export function formatCardTime(unixSeconds: number, timezone: string): string {
	const at = DateTime.fromSeconds(unixSeconds, { zone: timezone });
	return at.setLocale(packageLocale()).toLocaleString(DateTime.DATETIME_SHORT_WITH_SECONDS);
}
