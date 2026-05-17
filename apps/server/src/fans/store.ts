import { createReadStream } from "node:fs";
import { appendFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Logger } from "@bilibili-notify/internal";

/**
 * Per-UID fans 时序持久化。
 *
 * 文件布局:`<dataDir>/fans/<uid>.jsonl`,每行 `{ ts: ISO, value: number }`。
 * append-only — FansPoller 每个 cron tick 拉到一个 UP 的当前 fans 数就在该
 * UP 的 jsonl 末尾追加一行。计算 24h / 7d delta 时通过 `findNearestBefore`
 * 逆向扫读最近 ~8 天分区,在内存里挑离目标时间戳最近的那条样本(误差与
 * dynamicCron 周期同阶,默认 2min;前端 UI 不需要更高精度)。
 *
 * 不在写时做 dedup / hourly bucket。dynamicCron 默认 2min × 7d × N 个 UP 约
 * 35 万行总量,5MB 量级 — 几年内不会成为磁盘问题。后续若发现热点可加
 * `retention` pass 截尾 8d。
 */
export interface FansSample {
	ts: string;
	value: number;
}

export interface FansStore {
	/** Append one sample to the uid's jsonl. Creates the directory + file on demand. */
	append(uid: string, sample: FansSample): Promise<void>;
	/**
	 * 找出该 uid 在 ts 时间点之前最接近的一条样本。没有匹配返回 undefined。
	 * 实现:从文件尾向头流式读,第一条 ts <= target 的样本就是答案。
	 */
	findNearestBefore(uid: string, targetTsIso: string): Promise<FansSample | undefined>;
	/** 删除该 uid 的全部历史(订阅被移除时调用,避免遗留垃圾)。 */
	dropUid(uid: string): Promise<void>;
}

export interface CreateFansStoreOptions {
	dataDir: string;
	logger: Logger;
}

export function createFansStore(opts: CreateFansStoreOptions): FansStore {
	const root = join(opts.dataDir, "fans");
	let ensured = false;

	async function ensureRoot(): Promise<void> {
		if (ensured) return;
		await mkdir(root, { recursive: true });
		ensured = true;
	}

	function fileFor(uid: string): string {
		return join(root, `${uid}.jsonl`);
	}

	return {
		async append(uid, sample) {
			await ensureRoot();
			const line = `${JSON.stringify(sample)}\n`;
			try {
				await appendFile(fileFor(uid), line, "utf-8");
			} catch (err) {
				opts.logger.warn(`[fans-store] append ${uid} failed: ${String(err)}`);
			}
		},

		async findNearestBefore(uid, targetTsIso) {
			await ensureRoot();
			const file = fileFor(uid);
			let best: FansSample | undefined;
			try {
				// streaming forward scan; jsonl 是单调追加的,如果 line.ts <= target
				// 就刷 best;一旦遇到 > target 立即停。最坏情况要扫整个文件,但
				// 7d × 2min ≈ 5k 行,数十 ms 量级,可接受。
				const stream = createReadStream(file, { encoding: "utf-8" });
				const reader = createInterface({ input: stream });
				for await (const raw of reader) {
					const line = raw.trim();
					if (!line) continue;
					try {
						const parsed = JSON.parse(line) as FansSample;
						if (typeof parsed.ts !== "string" || typeof parsed.value !== "number") continue;
						if (parsed.ts > targetTsIso) {
							reader.close();
							stream.destroy();
							break;
						}
						best = parsed;
					} catch {
						/* skip malformed line */
					}
				}
			} catch (err) {
				// 文件不存在 = 该 uid 还没有任何样本,正常情况,不打日志。
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
					opts.logger.warn(`[fans-store] read ${uid} failed: ${String(err)}`);
				}
			}
			return best;
		},

		async dropUid(uid) {
			try {
				await unlink(fileFor(uid));
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
					opts.logger.warn(`[fans-store] drop ${uid} failed: ${String(err)}`);
				}
			}
		},
	};
}
