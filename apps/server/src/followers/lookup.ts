import { hourIndexOf } from "./cutoff.js";
import { hourEndMs } from "./expand.js";
import type { FollowersSample } from "./sample.js";

/** 一次查找回的东西:某个时刻与那一刻的粉丝数(不带 `lastSampledAt`)。 */
export interface FollowersAt {
	sampledAt: string;
	followers: number;
}

/** 最早一条:取 `sampledAt` 与值。输入按 `sampledAt` 升序;空回 `undefined`。 */
export function findEarliestFollowers(
	samples: readonly FollowersSample[],
): FollowersAt | undefined {
	const first = samples[0];
	return first === undefined
		? undefined
		: { sampledAt: first.sampledAt, followers: first.followers };
}

/** 最新一条:段取 `lastSampledAt` 与值。输入按 `sampledAt` 升序;空回 `undefined`。 */
export function findLatestFollowers(samples: readonly FollowersSample[]): FollowersAt | undefined {
	const last = samples[samples.length - 1];
	return last === undefined
		? undefined
		: { sampledAt: last.lastSampledAt ?? last.sampledAt, followers: last.followers };
}

/**
 * `targetIso` 之前(含)最近的一个点。输入按 `sampledAt` 升序;没有这样的点回 `undefined`。
 * 目标落在一段中间时回这段的值,时刻取展开({@link expandFollowersSamples})那些点里不晚于目标的
 * 最后一个:段起点、各小时的最后一毫秒、或 `lastSampledAt`。
 */
export function findFollowersAtOrBefore(
	samples: readonly FollowersSample[],
	targetIso: string,
): FollowersAt | undefined {
	const target = Date.parse(targetIso);
	// 最后一个 sampledAt ≤ target 的行。
	let lo = 0;
	let hi = samples.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (Date.parse((samples[mid] as FollowersSample).sampledAt) <= target) lo = mid + 1;
		else hi = mid;
	}
	const row = samples[lo - 1];
	if (row === undefined) return undefined;
	if (row.lastSampledAt === undefined)
		return { sampledAt: row.sampledAt, followers: row.followers };

	const endMs = Date.parse(row.lastSampledAt);
	if (target >= endMs) return { sampledAt: row.lastSampledAt, followers: row.followers };

	const firstHour = hourIndexOf(Date.parse(row.sampledAt));
	const lastHour = hourIndexOf(endMs);
	const targetHour = hourIndexOf(target);
	// 目标所在小时的末尾点还没到(只有正好踩在最后一毫秒才算到了),就退到上一个小时点。
	let hour = target >= hourEndMs(targetHour) ? targetHour : targetHour - 1;
	hour = Math.min(hour, lastHour - 1);
	if (hour <= firstHour) return { sampledAt: row.sampledAt, followers: row.followers };
	return { sampledAt: new Date(hourEndMs(hour)).toISOString(), followers: row.followers };
}
