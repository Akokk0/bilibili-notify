import type { Disposable, Logger, ServiceContext } from "@bilibili-notify/internal";
import type { FollowersStore } from "../followers/store.js";
import { logText } from "../i18n/index.js";

/** 一趟账压缩的汇总。 */
export interface RecordingCompactSummary {
	/** 改写了几个文件。 */
	files: number;
	/** 压掉了多少行。 */
	squeezed: number;
	/** 丢了多少条坏行。 */
	badLines: number;
}

/**
 * 统计的定时压缩(ADR-0027 决策 8、13、15):**开机一次、之后每 6 小时一次**。一趟里先对盘上每份粉丝样本文件调
 * {@link FollowersStore.compact}、再压「在记」的账(经记录器,与账的追加排同一条按键的队)。压缩幂等,没有新的可压内容时
 * 只读一遍就结束;统计总开关关着照跑(只缩不增)。
 *
 * 各是各的活,不塞进历史保留(`history/retention.ts`)那一趟:那边按推送历史的天数清,这边按统计的 8 天线压。
 * 一个文件出错只记 warn、不挡后面的;粉丝与账两边互不挡;整轮登记进 `track`,关停等它收完再让各写道关门。
 */
export interface StatsCompactionOptions {
	serviceCtx: Pick<ServiceContext, "setInterval" | "track">;
	/** 粉丝样本仓。 */
	store: FollowersStore;
	/** 记录器:「在记」的账走它按键的队压(与账的追加互斥)。 */
	recorder: { compactRecording(now: Date): Promise<RecordingCompactSummary> };
	logger: Logger;
	/** 间隔(毫秒),缺省 6 小时。 */
	intervalMs?: number;
	/** 此刻,缺省读系统时钟;注入口只留给测试。 */
	now?: () => Date;
}

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function startStatsCompaction(opts: StatsCompactionOptions): Disposable {
	const now = opts.now ?? (() => new Date());
	const pass = (): void => {
		// 压缩会整份重写粉丝文件:登记进 track,关停等它写完再让仓关门(关门之后不许再动数据目录)。
		opts.serviceCtx.track(runOnce(opts, now()));
	};
	const handle = opts.serviceCtx.setInterval(pass, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
	pass();
	return handle;
}

/** 一轮:先压粉丝样本、再压账,两边各自接住失败、互不挡。自己接住所有失败,登记进 `track` 的那件事从不拒。 */
async function runOnce(opts: StatsCompactionOptions, at: Date): Promise<void> {
	await compactFollowers(opts, at);
	await compactRecording(opts, at);
}

async function compactFollowers(opts: StatsCompactionOptions, at: Date): Promise<void> {
	let keys: string[];
	try {
		keys = await opts.store.keys();
	} catch (err) {
		opts.logger.warn(logText("log.samples.listFailed"), { error: err });
		return;
	}
	let files = 0;
	let squeezed = 0;
	let badLines = 0;
	for (const key of keys) {
		try {
			const report = await opts.store.compact(key, at);
			if (report.rewritten) {
				files += 1;
				squeezed += report.rowsBefore - report.rowsAfter;
			}
			badLines += report.badLines;
		} catch (err) {
			opts.logger.warn(logText("log.samples.compactFailed"), { key, error: err });
		}
	}
	if (files > 0) {
		opts.logger.info(logText("log.samples.compacted"), { files, squeezed, badLines });
	}
}

async function compactRecording(opts: StatsCompactionOptions, at: Date): Promise<void> {
	try {
		const { files, squeezed, badLines } = await opts.recorder.compactRecording(at);
		if (files > 0) {
			opts.logger.info(logText("log.stats.compacted"), { files, squeezed, badLines });
		}
	} catch (err) {
		opts.logger.warn(logText("log.stats.compactFailed"), { error: err });
	}
}
