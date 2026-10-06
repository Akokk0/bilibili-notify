/**
 * 读一份粉丝样本文件(`stats/followers/<订阅 id>.jsonl`,行是 `{ ts, value }`)里所有样本的时刻。
 *
 * 迁移里有两步要它:「统计的在记」(`recording.ts`,取样本所在的小时)与「运行记录」(`uptime.ts`,取毫秒时刻)。
 * 满量约 231 万行,所以只切出 `ts` 那一段,不整行解析成对象;两步各读一遍,各约一两秒。
 */

import { readFile } from "node:fs/promises";
import { HOUR_MS } from "../followers/cutoff.js";

const NEEDLE = '"ts":"';

/** 整点小时的 `YYYY-MM-DDTHH` → 毫秒。同一小时的行挨在一起,按头记住,省掉几百万次 `Date.parse`。 */
function hourStartReader() {
	const memo = new Map<string, number>();
	return (head: string): number => {
		const known = memo.get(head);
		if (known !== undefined) return known;
		const ms = Date.parse(`${head}:00:00.000Z`);
		memo.set(head, ms);
		return ms;
	};
}

const digits = (text: string): number => (/^\d+$/.test(text) ? Number(text) : Number.NaN);

/** 一行的时刻(毫秒);不是预期的行(没有 `ts`、不是时刻)回 `undefined`。 */
function timeReader() {
	const hourStart = hourStartReader();
	return (line: string): number | undefined => {
		let text: unknown;
		const at = line.indexOf(NEEDLE);
		if (at >= 0) {
			const from = at + NEEDLE.length;
			const to = line.indexOf('"', from);
			if (to < 0) return undefined;
			text = line.slice(from, to);
		} else {
			// 不是预期的写法(键序不同 / 空格):整行解析兜底。
			try {
				text = (JSON.parse(line) as Record<string, unknown> | null)?.ts;
			} catch {
				return undefined;
			}
		}
		if (typeof text !== "string") return undefined;
		// 写出来的都是 `new Date().toISOString()` 的 24 位定宽:小时走缓存、其余按位取;别的写法交给 `Date.parse`。
		if (
			text.length === 24 &&
			text[13] === ":" &&
			text[16] === ":" &&
			text[19] === "." &&
			text[23] === "Z"
		) {
			const minute = digits(text.slice(14, 16));
			const second = digits(text.slice(17, 19));
			const milli = digits(text.slice(20, 23));
			const head = hourStart(text.slice(0, 13));
			if (minute < 60 && second < 60 && milli < 1000 && Number.isFinite(head)) {
				return head + minute * 60_000 + second * 1000 + milli;
			}
		}
		const ms = Date.parse(text);
		return Number.isFinite(ms) ? ms : undefined;
	};
}

/** 这份文件里每一行样本的时刻(毫秒),按落盘顺序;文件不在回空,坏行跳过。 */
export async function readFollowerSampleTimes(path: string): Promise<number[]> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	const read = timeReader();
	const times: number[] = [];
	for (const line of text.split("\n")) {
		if (!line) continue;
		const ms = read(line);
		if (ms !== undefined) times.push(ms);
	}
	return times;
}

/** 样本时刻所在的 UTC 整点小时序号集合。 */
export function hourSetOf(times: readonly number[]): Set<number> {
	const hours = new Set<number>();
	for (const ms of times) hours.add(Math.floor(ms / HOUR_MS));
	return hours;
}
