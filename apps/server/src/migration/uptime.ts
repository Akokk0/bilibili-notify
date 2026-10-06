/**
 * 运行记录的回填:从 0.x 的粉丝样本**推出**老日子里 BN 每个 UTC 小时跑了多少分钟,写进新代的
 * `uptime/hours.jsonl`(ADR-0033 决策 3;㉗b)。0.x 没有记运行时长,粉丝轮询的心跳是唯一留下来的痕迹。
 *
 * 规则(主人定):
 *
 * - 输入是新代里搬过来的全部粉丝样本(B 站订阅与拓展订阅的都算)的时刻,合在一起排序去重。
 * - 相邻两个样本的间隔 ≤ max(该间隔**起点**所在那个 UTC 天的间隔中位数 × 2.5, 25 分钟) 就算连着;当天不足两个间隔
 *   可算,中位数取不到,只用 25 分钟的下限。自适应是因为采样间隔不统一(2 分钟 / 10 分钟 / 每小时一次,拓展的更稀):
 *   固定 30 分钟的阈值会把每小时采一次的人整个判成「没在跑」。
 * - 一串连着的样本是一段「在跑」:第一个时刻到最后一个时刻;孤零零一个样本的段长度是 0,不计。
 * - 每段按 UTC 整点小时切开,按毫秒累加到各小时,最后每小时四舍五入成整分钟、封顶 60,0 不写。
 *
 * ⚠️ 这是**往少了估**:登录掉了、风控退避、没有启用的 B 站订阅时没有样本,那段时间 BN 其实在跑却没有心跳,
 * 回填不会算进去。往少了估是有意的 —— 年度总结里「陪了你多久」宁可少说,不凭空多说。
 *
 * 顺序:排在「统计」「统计的在记」之后(读的是新代里改名并档之后的粉丝文件),在 ㉘ 压缩之前(压缩之后心跳就没了)。
 * 读样本只取时刻、不整行解析(满量约 231 万行),与「在记」共用 `follower-times.ts`。
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FOLLOWERS_DIR } from "../fans/store.js";
import { HOUR_MS } from "../followers/cutoff.js";
import { dataPath } from "../runtime/roots.js";
import { UPTIME_FILE, type UptimeEntry } from "../uptime/store.js";
import { listFiles, rewriteTextFile } from "./files.js";
import { readFollowerSampleTimes } from "./follower-times.js";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * HOUR_MS;
/** 连着的下限:再密的采样也容忍这么大的空档(一次轮询失败、一次重启)。 */
const MIN_CONNECTED_MS = 25 * MINUTE_MS;
/** 连着的倍数:当天间隔中位数的几倍以内算连着。 */
const MEDIAN_FACTOR = 2.5;
const MAX_MINUTES = 60;

/** 几份样本时刻合在一起:升序、去重。 */
export function mergeSampleTimes(lists: readonly (readonly number[])[]): number[] {
	const all: number[] = [];
	for (const list of lists) for (const ms of list) all.push(ms);
	all.sort((a, b) => a - b);
	const out: number[] = [];
	for (const ms of all) if (out[out.length - 1] !== ms) out.push(ms);
	return out;
}

function medianOf(values: number[]): number {
	values.sort((a, b) => a - b);
	const mid = values.length >> 1;
	return values.length % 2 === 1
		? (values[mid] as number)
		: ((values[mid - 1] as number) + (values[mid] as number)) / 2;
}

/**
 * 升序的样本时刻(毫秒)→ 每个 UTC 小时里跑了多少分钟,按小时升序。相邻的重复时刻先去掉(重复会拉低中位数)。
 * 规则见文件头。
 */
export function uptimeHoursFromSamples(times: readonly number[]): UptimeEntry[] {
	const sorted: number[] = [];
	for (const ms of times) if (sorted[sorted.length - 1] !== ms) sorted.push(ms);
	if (sorted.length < 2) return [];

	// 每天的间隔(按间隔起点所在的 UTC 天归组)与它的中位数。
	const gapsByDay = new Map<number, number[]>();
	for (let i = 1; i < sorted.length; i += 1) {
		const from = sorted[i - 1] as number;
		const day = Math.floor(from / DAY_MS);
		const gaps = gapsByDay.get(day);
		if (gaps) gaps.push((sorted[i] as number) - from);
		else gapsByDay.set(day, [(sorted[i] as number) - from]);
	}
	const limitByDay = new Map<number, number>();
	for (const [day, gaps] of gapsByDay) {
		limitByDay.set(
			day,
			gaps.length >= 2
				? Math.max(medianOf(gaps) * MEDIAN_FACTOR, MIN_CONNECTED_MS)
				: MIN_CONNECTED_MS,
		);
	}

	const msByHour = new Map<number, number>();
	const addSegment = (from: number, to: number) => {
		if (to <= from) return;
		for (let hour = Math.floor(from / HOUR_MS); hour <= Math.floor(to / HOUR_MS); hour += 1) {
			const overlap = Math.min(to, (hour + 1) * HOUR_MS) - Math.max(from, hour * HOUR_MS);
			if (overlap > 0) msByHour.set(hour, (msByHour.get(hour) ?? 0) + overlap);
		}
	};
	let segmentStart = sorted[0] as number;
	for (let i = 1; i < sorted.length; i += 1) {
		const prev = sorted[i - 1] as number;
		const gap = (sorted[i] as number) - prev;
		if (gap > (limitByDay.get(Math.floor(prev / DAY_MS)) as number)) {
			addSegment(segmentStart, prev);
			segmentStart = sorted[i] as number;
		}
	}
	addSegment(segmentStart, sorted[sorted.length - 1] as number);

	const out: UptimeEntry[] = [];
	for (const hour of [...msByHour.keys()].sort((a, b) => a - b)) {
		const minutes = Math.min(MAX_MINUTES, Math.round((msByHour.get(hour) as number) / MINUTE_MS));
		if (minutes > 0) out.push({ hourStartedAt: new Date(hour * HOUR_MS).toISOString(), minutes });
	}
	return out;
}

/**
 * 迁移一步:读新代的 `stats/followers/*.jsonl`,回填 `uptime/hours.jsonl`。回写过的文件(绝对路径);
 * 没有任何粉丝样本(或算下来一个小时都没有)就不建文件。
 */
export async function migrateUptime(dataRoot: string): Promise<string[]> {
	const dir = dataPath(dataRoot, ...FOLLOWERS_DIR);
	const lists: number[][] = [];
	for (const name of await listFiles(dir, ".jsonl")) {
		lists.push(await readFollowerSampleTimes(join(dir, name)));
	}
	const entries = uptimeHoursFromSamples(mergeSampleTimes(lists));
	if (entries.length === 0) return [];
	const target = dataPath(dataRoot, ...UPTIME_FILE);
	await mkdir(dirname(target), { recursive: true });
	await rewriteTextFile(target, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return [target];
}
