import { DateTime } from "luxon";

/**
 * 免扰时钟 —— 「当作现在是 hh:mm」的单点覆盖。
 *
 * **不是假时钟**:只有推送的免扰判定读它(`PushRouter.quietHoursNow`),延迟 / 超时 /
 * 历史时间戳 / 统计全是真时间。日期沿用今天,只换时分。
 */
export interface DevClock {
	now(): Date;
	pretend(hour: number, minute: number): void;
	clear(): void;
	/** 当前装着的时分,`HH:mm`;没装就 null。 */
	pretended(): string | null;
}

export function createDevClock(timezone: () => string): DevClock {
	let fake: { hour: number; minute: number } | null = null;
	return {
		now() {
			const d = new Date();
			return fake
				? DateTime.fromJSDate(d, { zone: timezone() })
						.set({ hour: fake.hour, minute: fake.minute, second: 0, millisecond: 0 })
						.toJSDate()
				: d;
		},
		pretend(hour, minute) {
			fake = { hour, minute };
		},
		clear() {
			fake = null;
		},
		pretended: () =>
			fake === null
				? null
				: `${String(fake.hour).padStart(2, "0")}:${String(fake.minute).padStart(2, "0")}`,
	};
}
