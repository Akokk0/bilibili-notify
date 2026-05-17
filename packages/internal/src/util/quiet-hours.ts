import type { TimeRange } from "../schema/common";

/**
 * 判断给定时间是否落在「免打扰」时段内。粒度按「小时」,匹配 `TimeRangeSchema`
 * 的 `start` ∈ 0..23 / `end` ∈ 0..24 整数 hour 字段。
 *
 * 区间语义:`[start, end)`,**包含 start、不包含 end**。
 * - 同日区间:`{start:9, end:18}` 命中 9..17 点(含 9、不含 18)
 * - 跨午夜:`{start:23, end:7}` 命中 23 点 + 0..6 点(含 23、不含 7)
 * - 全天:`{start:0, end:24}` —— start<end 走同日分支 `h>=0 && h<24`,恒命中
 * - schema refine 已禁止 `start === end`,不会落到「全天匹配」的歧义分支
 *
 * 多条范围用 OR 合并(任一命中即视为静默时段)。
 */
export function inQuietHours(ranges: readonly TimeRange[], at: Date): boolean {
	if (ranges.length === 0) return false;
	const h = at.getHours();
	for (const r of ranges) {
		if (r.start < r.end) {
			if (h >= r.start && h < r.end) return true;
		} else {
			// 跨午夜:[start, 24) ∪ [0, end)
			if (h >= r.start || h < r.end) return true;
		}
	}
	return false;
}
