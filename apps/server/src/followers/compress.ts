import { compressionCutoffMs, hourIndexOf } from "./cutoff.js";
import { expandFollowersSamples } from "./expand.js";
import type { FollowersSample } from "./sample.js";

/**
 * 粉丝样本压缩(ADR-0027 决策 8、15)。纯函数:输入数组、输出新数组,不读时钟、不碰盘。
 *
 * - 先按 `sampledAt` 稳定排序;时刻相同的多条取后出现的。
 * - 切线(`now` 往前 8×24 小时、取整到 UTC 整点)及之后的行原样保留。结束时刻(段取
 *   `lastSampledAt`)在切线或之后的行都算「之后」:跨线的段不拆也不合,原样留着。
 * - 切线之前的行先展开成每小时一个点(段也展开,所以上次的压缩产物照样参与),按 UTC 整点小时
 *   分桶、每桶只留时刻最晚的一条(保留真实时刻、不取整),再把小时序号连续且 `followers` 相同的
 *   合成一段:`sampledAt` 取头一个小时留下那条的时刻,`lastSampledAt` 取最后一个小时的;
 *   只有一个小时的是点。中间缺一小时的不合。
 * - 幂等:对输出再压一次(同一个 `now`)逐项相同;`now` 往后挪时,压好的段不被拆散、只会接上新的。
 * - 输出按 `sampledAt` 升序。
 */
export function compressFollowersSamples(
	samples: readonly FollowersSample[],
	now: Date,
): FollowersSample[] {
	const cutoffMs = compressionCutoffMs(now);

	// 稳定排序后,同时刻的取后出现的:相邻同时刻只留最后一条。
	const sorted = samples
		.map((row, order) => ({ row, ms: Date.parse(row.sampledAt), order }))
		.sort((a, b) => a.ms - b.ms || a.order - b.order);
	const unique = sorted.filter((x, i) => sorted[i + 1]?.ms !== x.ms);

	const kept: FollowersSample[] = [];
	const before: FollowersSample[] = [];
	for (const { row } of unique) {
		const endMs = Date.parse(row.lastSampledAt ?? row.sampledAt);
		(endMs >= cutoffMs ? kept : before).push(row);
	}

	// 每个小时桶只留时刻最晚的点(同时刻后到的覆盖先到的)。
	const byHour = new Map<number, { sampledAt: string; ms: number; followers: number }>();
	for (const point of expandFollowersSamples(before)) {
		const ms = Date.parse(point.sampledAt);
		const hour = hourIndexOf(ms);
		const held = byHour.get(hour);
		if (held === undefined || ms >= held.ms) {
			byHour.set(hour, { sampledAt: point.sampledAt, ms, followers: point.followers });
		}
	}

	const merged: FollowersSample[] = [];
	let run:
		| { first: string; last: string; followers: number; lastHour: number; count: number }
		| undefined;
	const flush = () => {
		if (run === undefined) return;
		merged.push(
			run.count === 1
				? { sampledAt: run.first, followers: run.followers }
				: { sampledAt: run.first, followers: run.followers, lastSampledAt: run.last },
		);
	};
	for (const hour of [...byHour.keys()].sort((a, b) => a - b)) {
		const held = byHour.get(hour);
		if (held === undefined) continue;
		if (run !== undefined && run.lastHour + 1 === hour && run.followers === held.followers) {
			run.last = held.sampledAt;
			run.lastHour = hour;
			run.count++;
		} else {
			flush();
			run = {
				first: held.sampledAt,
				last: held.sampledAt,
				followers: held.followers,
				lastHour: hour,
				count: 1,
			};
		}
	}
	flush();

	// 跨线的段起点可能早于某些压好的行:整体再按 sampledAt 稳定排一次。
	return [...merged, ...kept]
		.map((row, order) => ({ row, ms: Date.parse(row.sampledAt), order }))
		.sort((a, b) => a.ms - b.ms || a.order - b.order)
		.map((x) => x.row);
}
