import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createSerialQueue, type Logger } from "@bilibili-notify/internal";
import { appendJsonl, atomicWriteFile, isLeftoverName } from "@bilibili-notify/storage";
import { dataPath } from "../runtime/roots.js";
import { compressFollowersSamples } from "./compress.js";
import { expandFollowersSamples } from "./expand.js";
import { type FollowersAt, findEarliestFollowers, findFollowersAtOrBefore } from "./lookup.js";
import { type FollowersSample, parseStoredFollowersSample } from "./sample.js";

/**
 * 按订阅分文件的粉丝样本持久化(ADR-0027 决策 8、15)。
 *
 * 文件布局:`<dataDir>/stats/followers/<key>.jsonl`,每行一条 {@link FollowersSample}:点
 * `{ sampledAt, followers }`,或压缩出来的段 `{ sampledAt, followers, lastSampledAt }`。`<key>` 与统计仓同一个规矩
 * ({@link statsFileKey}):订阅 id。老版本的 B 站文件叫 `<uid>.jsonl`,迁移器把它们并进订阅 id 那份
 * (`migration/stats.ts`)。**仓只认新形状**:0.x 的 `{ ts, value }` 只有迁移认,这里读到当坏行跳过。
 *
 * 平时 append-only —— 粉丝轮询每个 cron tick 拉到一个 UP 的当前粉丝数就在该 UP 的 jsonl 末尾追加一行。
 * 拓展订阅的样本来自它报的资料(统计的拓展适配经记录器写,稀释到不密过粉丝轮询,ADR-0020 决策 8)。
 * 定时的压缩({@link FollowersStore.compact},`compaction.ts` 每 6 小时一趟)才会整份重写。
 *
 * **写盘按订阅(键)排队**:追加、压缩、删除走同一条队,压缩读整份、写回的这段时间里追加的样本排在后面,
 * 不会被压缩的换名盖掉。关停时 {@link FollowersStore.close} 等队走空再关门,登记在 flush 段。
 *
 * **读口回给调用方的永远是点**(`{ sampledAt, followers }`),段在读的这一层展开回每小时一个点并裁到窗口,
 * 调用方不需要知道段的存在。
 */
export interface FollowersStore {
	/** 追加一个点到这个键的 jsonl。按需建目录与文件。 */
	append(key: string, sample: FollowersAt): Promise<void>;
	/**
	 * 找出这个键在 `targetIso` 之前(含)最近的一个点。没有匹配返回 undefined。
	 * 实现:从头往后流式读,遇到第一行 `sampledAt` 晚于目标就停 —— 靠的是文件里行按时刻只增不减。
	 * 开机迁移把回退期间写的那份接在后面(那段一定更晚),所以并过的文件照样单调。
	 * 目标落在一段中间时回这段的值(见 {@link findFollowersAtOrBefore})。
	 */
	findNearestBefore(key: string, targetIso: string): Promise<FollowersAt | undefined>;
	/**
	 * 取 jsonl 最早一行有效样本(早返回,O(首行))。用于启动时 fansBaseline 自愈:earliest 比持久化的
	 * baseline 更早时以它校准。文件不存在 / 全空 / 全乱码 → undefined。
	 */
	findEarliest(key: string): Promise<FollowersAt | undefined>;
	/**
	 * 读回 `sampledAt >= sinceIso` 的全部点(升序)。段展开成每小时一个点并裁掉窗口之前的。
	 * 数据统计页的粉丝曲线 / 每日净增靠它取原始点,再在 aggregate 层按日归并。必然读完整份文件,
	 * 调用方应把窗口限制在 UI 真正要展示的天数,不要拿它当全量导出用。
	 */
	listSamplesSince(key: string, sinceIso: string): Promise<FollowersAt[]>;
	/** 删除这个键的全部历史(订阅被移除时调用,避免遗留垃圾)。 */
	drop(key: string): Promise<void>;
	/** 盘上有粉丝样本文件的键(订阅 id)。目录还没建回空。 */
	keys(): Promise<string[]>;
	/**
	 * 整类清空(㉙d,「存储占用」):对盘上每个键各排一次 {@link drop}(同一条按键的写队,排在这个键在飞的追加 /
	 * 压缩之后,不会被它们重新写出来)。没有文件也成功。只认调用时盘上列得出的键;调用方要先让别处的在飞写入落地
	 * (统计记录器的 `clear` 就是先等它们)。
	 */
	clear(): Promise<void>;
	/**
	 * 压缩这个键的样本:在这个键的队里读整份文件 → 逐行解析(坏行丢掉并计数)→ {@link compressFollowersSamples}
	 * → 与原来逐行相同就什么都不写,不同就原子换名写回。`now` 决定切线(现在往前 8 天,取整到 UTC 整点)。
	 * 文件不在回全 0。读不动文件就抛(调用方一个文件一个文件地接)。
	 */
	compact(key: string, now: Date): Promise<FollowersCompactReport>;
	/** 关停:等在途与已排队的写落盘,再关门;此后的写、压缩、删除一律以 `SerialQueueClosedError` 拒绝、不碰盘。 */
	close(): Promise<void>;
}

/** 一次压缩的结果。 */
export interface FollowersCompactReport {
	/** 压缩前认得的行数(坏行与空行不算)。 */
	rowsBefore: number;
	/** 压缩后的行数。 */
	rowsAfter: number;
	/** 丢掉的坏行数(不是 JSON、不是新形状、缺格或时刻解析不了);空行不算。 */
	badLines: number;
	/** 有没有写盘。 */
	rewritten: boolean;
}

/** 粉丝时序住的目录(数据根下的一级项)。开机迁移认的也是这一处。 */
export const FOLLOWERS_DIR = ["stats", "followers"] as const;

export interface CreateFollowersStoreOptions {
	dataRoot: string;
	logger: Logger;
}

/** 只给读口看的点:去掉 `lastSampledAt`。 */
const pointOf = (at: FollowersAt): FollowersAt => ({
	sampledAt: at.sampledAt,
	followers: at.followers,
});

export function createFollowersStore(opts: CreateFollowersStoreOptions): FollowersStore {
	const root = dataPath(opts.dataRoot, ...FOLLOWERS_DIR);
	let ensured = false;
	/** 写道:按键(订阅 id)串行;读口不排队(读的是追加写出来的整行,追加不会让读到半行以外的东西)。 */
	const writes = createSerialQueue();

	async function ensureRoot(): Promise<void> {
		if (ensured) return;
		await mkdir(root, { recursive: true });
		ensured = true;
	}

	function fileFor(key: string): string {
		return join(root, `${key}.jsonl`);
	}

	/**
	 * 流式读一份文件的有效行(新形状),按落盘顺序交给 `visit`;`visit` 回 `true` 就停。
	 * 文件不在 = 这个键还没有任何样本,正常情况,不打日志。
	 */
	async function scan(key: string, visit: (row: FollowersSample) => boolean | undefined) {
		try {
			const stream = createReadStream(fileFor(key), { encoding: "utf-8" });
			const reader = createInterface({ input: stream });
			for await (const raw of reader) {
				const line = raw.trim();
				if (!line) continue;
				let row: FollowersSample | undefined;
				try {
					row = parseStoredFollowersSample(JSON.parse(line));
				} catch {
					continue; // 坏行
				}
				if (row && visit(row)) {
					reader.close();
					stream.destroy();
					break;
				}
			}
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				opts.logger.warn(`[followers-store] read ${key} failed: ${String(err)}`);
			}
		}
	}

	async function keys(): Promise<string[]> {
		let names: string[];
		try {
			names = await readdir(root);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw err;
		}
		return names
			.filter((name) => name.endsWith(".jsonl") && !isLeftoverName(name))
			.map((name) => name.slice(0, -".jsonl".length));
	}

	function drop(key: string): Promise<void> {
		return writes.run(key, async () => {
			try {
				await unlink(fileFor(key));
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
					opts.logger.warn(`[followers-store] drop ${key} failed: ${String(err)}`);
				}
			}
		});
	}

	return {
		append(key, sample) {
			// 只写这两格:行格式是契约,调用方对象上多带的东西不许漏进盘。
			const row: FollowersSample = { sampledAt: sample.sampledAt, followers: sample.followers };
			return writes.run(key, async () => {
				await ensureRoot();
				try {
					await appendJsonl(fileFor(key), [row]);
				} catch (err) {
					opts.logger.warn(`[followers-store] append ${key} failed: ${String(err)}`);
				}
			});
		},

		async findNearestBefore(key, targetIso) {
			await ensureRoot();
			const target = Date.parse(targetIso);
			// 最后一行 `sampledAt` ≤ 目标的;之后的行都更晚,不用读。目标落在段里由 lookup 算。
			let best: FollowersSample | undefined;
			await scan(key, (row) => {
				if (Date.parse(row.sampledAt) > target) return true;
				best = row;
				return false;
			});
			return best === undefined ? undefined : findFollowersAtOrBefore([best], targetIso);
		},

		async findEarliest(key) {
			await ensureRoot();
			let first: FollowersSample | undefined;
			await scan(key, (row) => {
				first = row;
				return true;
			});
			const found = first === undefined ? undefined : findEarliestFollowers([first]);
			return found === undefined ? undefined : pointOf(found);
		},

		async listSamplesSince(key, sinceIso) {
			await ensureRoot();
			const parsed = Date.parse(sinceIso);
			const sinceMs = Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
			const rows: FollowersSample[] = [];
			await scan(key, (row) => {
				// 结束时刻(段取 `lastSampledAt`)不早于窗口起点的行才可能有点落进窗口。
				if (Date.parse(row.lastSampledAt ?? row.sampledAt) >= sinceMs) rows.push(row);
				return false;
			});
			return expandFollowersSamples(rows, { sinceIso });
		},

		drop,

		keys,

		async clear() {
			await Promise.all((await keys()).map(drop));
		},

		compact(key, now) {
			return writes.run(key, async () => {
				let text: string;
				try {
					text = await readFile(fileFor(key), "utf8");
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code === "ENOENT") {
						return { rowsBefore: 0, rowsAfter: 0, badLines: 0, rewritten: false };
					}
					throw err;
				}
				const originalLines = text.split("\n").filter((line) => line.trim() !== "");
				const rows: FollowersSample[] = [];
				let badLines = 0;
				for (const line of originalLines) {
					let row: FollowersSample | undefined;
					try {
						row = parseStoredFollowersSample(JSON.parse(line));
					} catch {
						row = undefined;
					}
					if (row) rows.push(row);
					else badLines += 1;
				}
				const compressed = compressFollowersSamples(rows, now);
				const nextLines = compressed.map((row) => JSON.stringify(row));
				const same =
					badLines === 0 &&
					nextLines.length === originalLines.length &&
					nextLines.every((line, i) => line === originalLines[i]?.trim());
				if (badLines > 0) {
					opts.logger.warn(`[followers-store] compact ${key} dropped ${badLines} bad line(s)`);
				}
				if (!same) {
					await atomicWriteFile(
						fileFor(key),
						nextLines.length === 0 ? "" : `${nextLines.join("\n")}\n`,
					);
				}
				return {
					rowsBefore: rows.length,
					rowsAfter: compressed.length,
					badLines,
					rewritten: !same,
				};
			});
		},

		close: () => writes.close(),
	};
}
