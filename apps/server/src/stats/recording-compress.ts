import { compressionCutoffMs } from "../followers/cutoff.js";
import type { RecordingEntry } from "./store.js";

/**
 * 「在记」账的区间合并(ADR-0027 决策 13、15)。纯函数,不读时钟、不碰盘。
 *
 * - 切线(`now` 往前 8×24 小时、取整到 UTC 整点,与粉丝样本同一条)及之后**结束**的行原样保留。
 *   跨线的行(开始在线前、结束在线上或线后)因此原样留着,不拆、不与别的行合并;
 *   只合「整段都在切线之前」的行。
 * - 切线之前的:同一 `kind`、首尾相接或重叠(`a.endedAt >= b.startedAt`)的接成一段,结束取较晚的;
 *   重复行因为重叠而并掉;不同 `kind` 互不影响。
 * - 输出顺序:按 `startedAt`,再按 `kind`(字典序),再按 `endedAt`;合出来的与原样留下的混排在一起。
 * - 幂等;`now` 往后挪时,先前合好的不被拆散。
 */
/**
 * 账里行的规范次序:按 `startedAt`,再按 `kind`(字典序),再按 `endedAt`。压缩的输出照它排,迁移写账也照它排
 * (同一个比较函数,迁移的产出就是规范形态)。
 */
export function compareRecordingEntries(a: RecordingEntry, b: RecordingEntry): number {
	return (
		Date.parse(a.startedAt) - Date.parse(b.startedAt) ||
		(a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) ||
		Date.parse(a.endedAt) - Date.parse(b.endedAt)
	);
}

export function compressRecordingEntries(
	entries: readonly RecordingEntry[],
	now: Date,
): RecordingEntry[] {
	const cutoffMs = compressionCutoffMs(now);

	const kept: RecordingEntry[] = [];
	const byKind = new Map<RecordingEntry["kind"], RecordingEntry[]>();
	for (const entry of entries) {
		if (Date.parse(entry.endedAt) >= cutoffMs) {
			kept.push(entry);
			continue;
		}
		const list = byKind.get(entry.kind);
		if (list === undefined) byKind.set(entry.kind, [entry]);
		else list.push(entry);
	}

	const merged: RecordingEntry[] = [];
	for (const [kind, list] of byKind) {
		const sorted = list
			.map((entry) => ({
				entry,
				start: Date.parse(entry.startedAt),
				end: Date.parse(entry.endedAt),
			}))
			.sort((a, b) => a.start - b.start || a.end - b.end);
		let cur: { startedAt: string; endedAt: string; end: number } | undefined;
		for (const item of sorted) {
			if (cur !== undefined && cur.end >= item.start) {
				if (item.end > cur.end) {
					cur.endedAt = item.entry.endedAt;
					cur.end = item.end;
				}
				continue;
			}
			if (cur !== undefined) merged.push({ kind, startedAt: cur.startedAt, endedAt: cur.endedAt });
			cur = { startedAt: item.entry.startedAt, endedAt: item.entry.endedAt, end: item.end };
		}
		if (cur !== undefined) merged.push({ kind, startedAt: cur.startedAt, endedAt: cur.endedAt });
	}

	return [...merged, ...kept].sort(compareRecordingEntries);
}
