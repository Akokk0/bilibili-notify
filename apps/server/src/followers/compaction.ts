import type { Disposable, Logger, ServiceContext } from "@bilibili-notify/internal";
import type { FollowersStore } from "./store.js";

/**
 * 粉丝样本的定时压缩(ADR-0027 决策 8、15):**开机一次、之后每 6 小时一次**,对盘上每份粉丝文件调
 * {@link FollowersStore.compact}。压缩幂等,没有新的可压内容时只读一遍就结束;统计总开关关着照跑(只缩不增)。
 *
 * 各是各的活,不塞进历史保留(`history/retention.ts`)那一趟:那边按推送历史的天数清,这边按粉丝样本的 8 天线压。
 * 一个文件出错只记 warn、不挡后面的;整轮登记进 `track`,关停等它收完再让各写道关门。
 */
export interface FollowersCompactionOptions {
	serviceCtx: Pick<ServiceContext, "setInterval" | "track">;
	store: FollowersStore;
	logger: Logger;
	/** 间隔(毫秒),缺省 6 小时。 */
	intervalMs?: number;
	/** 此刻,缺省读系统时钟;注入口只留给测试。 */
	now?: () => Date;
}

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function startFollowersCompaction(opts: FollowersCompactionOptions): Disposable {
	const now = opts.now ?? (() => new Date());
	const pass = (): void => {
		// 压缩会整份重写粉丝文件:登记进 track,关停等它写完再让仓关门(关门之后不许再动数据目录)。
		opts.serviceCtx.track(runOnce(opts, now()));
	};
	const handle = opts.serviceCtx.setInterval(pass, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
	pass();
	return handle;
}

/** 一轮。自己接住所有失败,登记进 `track` 的那件事从不拒。 */
async function runOnce(opts: FollowersCompactionOptions, at: Date): Promise<void> {
	let keys: string[];
	try {
		keys = await opts.store.keys();
	} catch (err) {
		opts.logger.warn(`[followers] compaction could not list the sample files: ${String(err)}`);
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
			opts.logger.warn(`[followers] compaction of ${key} failed: ${String(err)}`);
		}
	}
	if (files > 0) {
		opts.logger.info(
			`[followers] compacted ${files} file(s): squeezed ${squeezed} row(s)${badLines > 0 ? `, dropped ${badLines} bad line(s)` : ""}`,
		);
	}
}
