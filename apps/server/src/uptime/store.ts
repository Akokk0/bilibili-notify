import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Logger } from "@bilibili-notify/internal";
import { createSerialQueue } from "@bilibili-notify/internal";
import { appendJsonl } from "@bilibili-notify/storage";
import { dataPath } from "../runtime/roots.js";

/**
 * 运行记录(ADR-0033 决策 3):BN 每个 UTC 整点小时里跑了多少分钟,年度总结「陪了你多久」的数据源。
 *
 * 住在数据根的 `uptime/hours.jsonl`,**整个 BN 一份、不分订阅**。它不算数据统计:不在 `stats/` 下、
 * 不受统计总开关管、不进备份。行是中立的 {@link UptimeEntry}。
 *
 * append-only、逐行 JSON、坏行读时跳过、缺文件视为空,与 `stats/store.ts` 同构。**同一个小时可以有好几行**
 * (重启过:关停补一行、再开机又从头记),读的一方用 {@link sumUptimeByHour} 相加。
 *
 * 构造时不碰盘(ADR-0022 决策 2:建运行时那会儿数据那一代还没就位);目录在第一次追加时才建。
 */

/** 一行:`hourStartedAt` 这个整点小时里跑了 `minutes` 分钟。 */
export interface UptimeEntry {
	/** UTC 整点的 ISO 时刻,如 `2026-10-06T08:00:00.000Z`。 */
	hourStartedAt: string;
	/** 那个小时里跑了多少分钟,整数,0–60。 */
	minutes: number;
}

export const UPTIME_FILE = ["uptime", "hours.jsonl"] as const;

const MAX_MINUTES = 60;

export interface UptimeStore {
	/** 追加一行。关门之后以 `SerialQueueClosedError` 拒绝、不碰盘。 */
	append(entry: UptimeEntry): Promise<void>;
	/** 读回 `hourStartedAt >= sinceIso` 的行,按落盘顺序;坏行跳过。缺省读全部。 */
	list(sinceIso?: string): Promise<UptimeEntry[]>;
	/** 关停:等在途与已排队的写落盘,再关门。关停的 `flush` 段调它。 */
	close(): Promise<void>;
}

export interface CreateUptimeStoreOptions {
	dataRoot: string;
	logger: Logger;
}

/** 读一行。返回 `undefined` = 这行不认(缺格、分钟不是 0–60 的整数、时刻不是时刻),跳过。 */
function readRow(parsed: unknown): UptimeEntry | undefined {
	const row = parsed as { hourStartedAt?: unknown; minutes?: unknown } | null;
	if (typeof row?.hourStartedAt !== "string" || typeof row.minutes !== "number") return undefined;
	if (!Number.isInteger(row.minutes) || row.minutes < 0 || row.minutes > MAX_MINUTES) {
		return undefined;
	}
	if (Number.isNaN(Date.parse(row.hourStartedAt))) return undefined;
	return { hourStartedAt: row.hourStartedAt, minutes: row.minutes };
}

/** 同一个小时的几行相加、封顶 60,按小时升序。 */
export function sumUptimeByHour(entries: readonly UptimeEntry[]): UptimeEntry[] {
	const byHour = new Map<string, number>();
	for (const entry of entries) {
		byHour.set(entry.hourStartedAt, (byHour.get(entry.hourStartedAt) ?? 0) + entry.minutes);
	}
	return [...byHour]
		.map(([hourStartedAt, minutes]) => ({ hourStartedAt, minutes: Math.min(minutes, MAX_MINUTES) }))
		.sort((a, b) => Date.parse(a.hourStartedAt) - Date.parse(b.hourStartedAt));
}

/** 写道的唯一一个键:整个 BN 一份文件,写全局串行。 */
const WRITE_KEY = "uptime";

export function createUptimeStore(opts: CreateUptimeStoreOptions): UptimeStore {
	const file = dataPath(opts.dataRoot, ...UPTIME_FILE);
	const writes = createSerialQueue();

	return {
		append(entry) {
			// 只写这两格:行格式是契约,调用方对象上多带的东西不许漏进盘。
			const row: UptimeEntry = { hourStartedAt: entry.hourStartedAt, minutes: entry.minutes };
			return writes.run(WRITE_KEY, () => appendJsonl(file, [row]));
		},

		async list(sinceIso) {
			const rows: UptimeEntry[] = [];
			try {
				const reader = createInterface({
					input: createReadStream(file, { encoding: "utf-8" }),
				});
				for await (const raw of reader) {
					const line = raw.trim();
					if (!line) continue;
					try {
						const row = readRow(JSON.parse(line));
						if (row && (sinceIso === undefined || row.hourStartedAt >= sinceIso)) rows.push(row);
					} catch {
						/* skip malformed line */
					}
				}
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
					opts.logger.warn(`[uptime-store] read ${file} failed: ${String(err)}`);
				}
			}
			return rows;
		},

		close: () => writes.close(),
	};
}
