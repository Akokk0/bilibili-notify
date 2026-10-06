/**
 * 迁移压老粉丝样本(ADR-0027 决策 8、15;㉘c):把新代 `stats/followers/<订阅 id>.jsonl` 里 0.x 的 `{ ts, value }`
 * 行改成新形状 `{ sampledAt, followers }`,同时按「现在」压一遍(最近 8 天原样,更早的每小时留最晚的一条、
 * 连着的同值小时合成段)—— 与平时每 6 小时那趟压缩是同一个纯函数(`followers/compress.ts`)。
 *
 * 排在「统计的在记」与「运行记录」**之后**:那两步读的是旧形状里的 `"ts":"…"`,压缩之后样本就没有逐条的心跳了。
 * B 站订阅与拓展订阅的文件一样处理。新旧两种形状的行都认(仓自己只认新的,旧形状只有这里认)。坏行丢掉、合起来记
 * 一条带个数的没带过来;空行不算。
 *
 * 文件整份读、整份重写(单文件满量约 5 万行):解析逐行 `JSON.parse`、压缩是排序加一遍线性扫,没有按行再扫已处理行的地方。
 * 写回走换名(`rewriteTextFile`):新代里的文件多半是第 0 代的拷贝,绝不原地写。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { compressFollowersSamples } from "../followers/compress.js";
import { type FollowersSample, parseFollowersSample } from "../followers/sample.js";
import { FOLLOWERS_DIR } from "../followers/store.js";
import { dataPath } from "../runtime/roots.js";
import { listFiles, parseJsonLine, rewriteTextFile } from "./files.js";

/**
 * 迁移一步。回写过的文件(绝对路径);坏行的总数经 `skip` 记一条。
 * `now` 是迁移注入的此刻(切线按它算),不读系统时钟。
 */
export async function migrateFollowerCompression(
	dataRoot: string,
	now: Date,
	skip: (reason: string) => void,
): Promise<string[]> {
	const dir = dataPath(dataRoot, ...FOLLOWERS_DIR);
	const written: string[] = [];
	let badLines = 0;
	for (const name of await listFiles(dir, ".jsonl")) {
		const path = join(dir, name);
		const rows: FollowersSample[] = [];
		for (const line of (await readFile(path, "utf8")).split("\n")) {
			if (line.trim() === "") continue;
			const row = parseFollowersSample(parseJsonLine(line));
			if (row) rows.push(row);
			else badLines += 1;
		}
		const lines = compressFollowersSamples(rows, now).map((row) => JSON.stringify(row));
		await rewriteTextFile(path, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
		written.push(path);
	}
	if (badLines > 0) {
		skip(`${badLines} 条粉丝样本读不懂(不是 JSON、缺格或时刻解析不了),没带过来`);
	}
	return written;
}
