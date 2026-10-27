/**
 * 被拒的上报里的一个值念给人听:不是字符串的只说类型,太长的截一段 —— 直接插第三方交来的值会把
 * 日志弄脏(甚至插进 `[object Object]`)。
 */
export function textPreview(raw: unknown): string {
	if (typeof raw !== "string") return `(${typeof raw})`;
	return raw.length > 64 ? `${raw.slice(0, 64)}…` : raw;
}
