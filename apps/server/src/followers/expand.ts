import { HOUR_MS, hourIndexOf } from "./cutoff.js";
import type { FollowersSample } from "./sample.js";

/**
 * 一个小时「中间点」的时刻:那个整点小时的最后一毫秒(`hh:59:59.999`)。
 * 落在这个小时之内、晚于该小时里任何更早的真实采样,所以按时刻排序后段内顺序正确;
 * 同时「每个小时末的值」这句话在时刻上读起来就是字面意思。展开与「某时刻之前最近一条」共用。
 */
export function hourEndMs(hourIndex: number): number {
	return (hourIndex + 1) * HOUR_MS - 1;
}

/**
 * 把段展开成每个小时一个点,点原样通过。输入按 `sampledAt` 升序,输出也是升序。
 * 段的第一个点用 `sampledAt` 原值、最后一个点用 `lastSampledAt` 原值,中间每个小时一个点
 * (时刻见 {@link hourEndMs})。
 *
 * 窗口 `{ sinceIso }`:只回时刻 ≥ `sinceIso` 的点。一段跨过窗口起点时,窗口之前的点被裁掉
 * (段起点不会漏进窗口),窗口内的小时点一个不少。`sinceIso` 解析不了按没给窗口处理。
 */
export function expandFollowersSamples(
	samples: readonly FollowersSample[],
	window?: { sinceIso: string },
): FollowersSample[] {
	const sinceParsed = window === undefined ? Number.NaN : Date.parse(window.sinceIso);
	const sinceMs = Number.isNaN(sinceParsed) ? Number.NEGATIVE_INFINITY : sinceParsed;
	const out: FollowersSample[] = [];
	const push = (sampledAt: string, ms: number, followers: number) => {
		if (ms >= sinceMs) out.push({ sampledAt, followers });
	};
	for (const row of samples) {
		const startMs = Date.parse(row.sampledAt);
		if (row.lastSampledAt === undefined) {
			if (startMs >= sinceMs) out.push(row);
			continue;
		}
		const endMs = Date.parse(row.lastSampledAt);
		push(row.sampledAt, startMs, row.followers);
		for (let h = hourIndexOf(startMs) + 1; h < hourIndexOf(endMs); h++) {
			const ms = hourEndMs(h);
			push(new Date(ms).toISOString(), ms, row.followers);
		}
		if (endMs > startMs) push(row.lastSampledAt, endMs, row.followers);
	}
	return out;
}
