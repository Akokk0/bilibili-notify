/**
 * 压缩的切线(ADR-0027 决策 15):现在往前 8×24 小时,向下取整到 UTC 整点。
 * 粉丝样本与「在记」账的压缩共用同一条线;按时刻切、不按哪个时区的日子切。
 */

export const HOUR_MS = 3_600_000;

/** 保留原样的时长:8 天。 */
export const KEEP_RAW_MS = 8 * 24 * HOUR_MS;

/** UTC 小时序号(自纪元起第几个整点小时)。 */
export function hourIndexOf(ms: number): number {
	return Math.floor(ms / HOUR_MS);
}

/** `now` 往前 8 天、向下取整到 UTC 整点的毫秒数。切线及之后的行原样保留。 */
export function compressionCutoffMs(now: Date): number {
	return hourIndexOf(now.getTime() - KEEP_RAW_MS) * HOUR_MS;
}
