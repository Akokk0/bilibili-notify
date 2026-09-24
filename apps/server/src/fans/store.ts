import { createReadStream } from "node:fs";
import { appendFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Logger } from "@bilibili-notify/internal";

/**
 * 按订阅分文件的 fans 时序持久化。
 *
 * 文件布局:`<dataDir>/fans/<key>.jsonl`,每行 `{ ts: ISO, value: number }`。`<key>` 与统计仓
 * 同一个规矩({@link statsFileKey}):订阅 id(ADR-0020 决策 2 的 🔗 / 16)。老版本的 B 站文件
 * 叫 `<uid>.jsonl`,开机迁移把它们并进订阅 id 那份(`stats/migrate-file-keys.ts`)。
 * append-only — FansPoller 每个 cron tick 拉到一个 UP 的当前 fans 数就在该
 * UP 的 jsonl 末尾追加一行。拓展订阅的样本来自它报的资料(统计的拓展适配经记录器写,
 * 稀释到不密过粉丝轮询,ADR-0020 决策 8)。计算 24h / 7d delta 时通过 `findNearestBefore`
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
	/** Append one sample to the key's jsonl. Creates the directory + file on demand. */
	append(key: string, sample: FansSample): Promise<void>;
	/**
	 * 找出这个键在 ts 时间点之前最接近的一条样本。没有匹配返回 undefined。
	 * 实现:从头往后流式读,遇到第一条 ts > target 就停 —— 靠的是文件里时间只增不减。
	 * 开机迁移把回退期间写的那份接在后面(那段一定更晚),所以并过的文件照样单调;万一那段
	 * 被接了两遍,停下之前扫到的仍是同一个值。
	 */
	findNearestBefore(key: string, targetTsIso: string): Promise<FansSample | undefined>;
	/**
	 * 取 jsonl 最早一行有效样本(早返回,O(首行))。用于启动时 fansBaseline
	 * 自愈:earliest 比持久化的 baseline 更早时以它校准。
	 * 文件不存在 / 全空 / 全乱码 → undefined。
	 */
	findEarliest(key: string): Promise<FansSample | undefined>;
	/**
	 * 读回 ts >= sinceIso 的全部样本(jsonl 单调追加,所以天然时间升序)。
	 * 数据统计页的粉丝曲线 / 每日净增靠它取原始点,再在 aggregate 层按日归并。
	 *
	 * 与 `findNearestBefore` 的「扫到就停」不同,这里必然读完 since 之后的全部
	 * 内容。30 天 × 2min ≈ 2 万行、~1MB 量级,一次请求内可接受;调用方应把
	 * 窗口限制在 UI 真正要展示的天数,不要拿它当全量导出用。
	 */
	listSamplesSince(key: string, sinceIso: string): Promise<FansSample[]>;
	/** 删除这个键的全部历史(订阅被移除时调用,避免遗留垃圾)。 */
	drop(key: string): Promise<void>;
}

/** 粉丝时序住的目录(相对 dataDir)。开机迁移认的也是这一处。 */
export const FANS_DIR = "fans";

export interface CreateFansStoreOptions {
	dataDir: string;
	logger: Logger;
}

export function createFansStore(opts: CreateFansStoreOptions): FansStore {
	const root = join(opts.dataDir, FANS_DIR);
	let ensured = false;

	async function ensureRoot(): Promise<void> {
		if (ensured) return;
		await mkdir(root, { recursive: true });
		ensured = true;
	}

	function fileFor(key: string): string {
		return join(root, `${key}.jsonl`);
	}

	return {
		async append(key, sample) {
			await ensureRoot();
			const line = `${JSON.stringify(sample)}\n`;
			try {
				await appendFile(fileFor(key), line, "utf-8");
			} catch (err) {
				opts.logger.warn(`[fans-store] append ${key} failed: ${String(err)}`);
			}
		},

		async findNearestBefore(key, targetTsIso) {
			await ensureRoot();
			const file = fileFor(key);
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
				// 文件不存在 = 这个键还没有任何样本,正常情况,不打日志。
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
					opts.logger.warn(`[fans-store] read ${key} failed: ${String(err)}`);
				}
			}
			return best;
		},

		async findEarliest(key) {
			await ensureRoot();
			const file = fileFor(key);
			try {
				const stream = createReadStream(file, { encoding: "utf-8" });
				const reader = createInterface({ input: stream });
				for await (const raw of reader) {
					const line = raw.trim();
					if (!line) continue;
					try {
						const parsed = JSON.parse(line) as FansSample;
						if (typeof parsed.ts !== "string" || typeof parsed.value !== "number") continue;
						reader.close();
						stream.destroy();
						return parsed;
					} catch {
						/* skip malformed line, keep scanning */
					}
				}
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
					opts.logger.warn(`[fans-store] read ${key} failed: ${String(err)}`);
				}
			}
			return undefined;
		},

		async listSamplesSince(key, sinceIso) {
			await ensureRoot();
			const file = fileFor(key);
			const out: FansSample[] = [];
			try {
				const stream = createReadStream(file, { encoding: "utf-8" });
				const reader = createInterface({ input: stream });
				for await (const raw of reader) {
					const line = raw.trim();
					if (!line) continue;
					try {
						const parsed = JSON.parse(line) as FansSample;
						if (typeof parsed.ts !== "string" || typeof parsed.value !== "number") continue;
						if (parsed.ts >= sinceIso) out.push({ ts: parsed.ts, value: parsed.value });
					} catch {
						/* skip malformed line */
					}
				}
			} catch (err) {
				// 文件不存在 = 这个键还没有任何样本,正常情况,不打日志。
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
					opts.logger.warn(`[fans-store] read ${key} failed: ${String(err)}`);
				}
			}
			return out;
		},

		async drop(key) {
			try {
				await unlink(fileFor(key));
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
					opts.logger.warn(`[fans-store] drop ${key} failed: ${String(err)}`);
				}
			}
		},
	};
}
