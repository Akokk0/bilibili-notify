/**
 * 全局时区的规矩(ADR-0021 决策 43):收哪些写法、某一刻的偏移怎么算。
 *
 * 🔴 **零 import**:设置 schema、服务端切天与以后的出卡器都从根出口取这三样,
 * 读盘那一刻就可能用到,不把任何值拽进来。
 */

/** 全局时区的出厂值(ADR-0021 决策 43)。 */
export const DEFAULT_TIMEZONE = "Asia/Shanghai";

/**
 * 是不是收得下的时区名:`Intl` 认得,且首字是字母(那是 IANA 名的形状)。
 *
 * 只收 IANA 名,不收 `+08:00` / `UTC+8` 这类偏移写法:两边的认法不一致,存进来卡上会印不出来。
 * 也不比规范名 —— `Asia/Calcutta` 这类别名哪天被 ICU 改写,盘上存着的值不该突然变成坏格。
 */
export function isTimezone(name: string): boolean {
	if (!/^\p{L}/u.test(name)) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: name });
		return true;
	} catch {
		return false;
	}
}

/**
 * 这个时区在某一刻的偏移,`Date.prototype.getTimezoneOffset()` 的口径
 * (UTC+8 → -480)。把那一刻在时区里的墙上时间当成 UTC 读回来,差值就是偏移。
 */
export function timezoneOffsetMinutes(timezone: string, at: Date): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(at);
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		Number(parts.find((candidate) => candidate.type === type)?.value);
	const wallClockAsUtc = Date.UTC(
		part("year"),
		part("month") - 1,
		part("day"),
		part("hour"),
		part("minute"),
		part("second"),
	);
	// 丢掉毫秒再比,免得偏移算出小数分钟。
	const atSeconds = Math.floor(at.getTime() / 1000) * 1000;
	return Math.round((atSeconds - wallClockAsUtc) / 60_000);
}
