import type { Logger } from "@bilibili-notify/internal";
import type { UptimeStore } from "./store.js";

/**
 * 运行记录的记录器(ADR-0033 决策 3):每个 UTC 整点过去时,把刚过去的那一小时跑了多少分钟记一行;
 * 关停时把当前不满的这一小时补一行。崩溃丢当前这不到一小时,可以接受。
 *
 * 分钟数 = 这一小时内**实际经过的毫秒数**四舍五入。系统休眠或时钟跳变会让定时器隔了好几个整点才响:
 * 这时**只记有把握的** —— 最初那一小时到它的整点为止的部分,之后从醒来的这一刻重新起算,睡着的小时不记。
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export interface UptimeTimers {
	/** 排一次性的定时器;真实现必须 `unref`,不挡进程退出。回调返回的 Promise 只有测试会等。 */
	set(fn: () => Promise<void>, ms: number): unknown;
	clear(handle: unknown): void;
}

const realTimers: UptimeTimers = {
	set(fn, ms) {
		const handle = setTimeout(() => void fn(), ms);
		handle.unref();
		return handle;
	},
	clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface CreateUptimeRecorderOptions {
	store: Pick<UptimeStore, "append">;
	logger: Logger;
	/** 注入时钟(毫秒时间戳),测试用;缺省取系统时间。 */
	now?: () => number;
	/** 注入定时器,测试用。 */
	timers?: UptimeTimers;
}

export interface UptimeRecorder {
	/** 从这一刻算起,排到下一个整点的定时。数据那一代就位之后调;只生效一次。 */
	start(): void;
	/** 关停:补记当前这一小时并停表;此后一律不再写。没 `start` 过、或已经停了,什么都不做。 */
	stop(): Promise<void>;
}

const hourFloor = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS;

export function createUptimeRecorder(opts: CreateUptimeRecorderOptions): UptimeRecorder {
	const now = opts.now ?? (() => Date.now());
	const timers = opts.timers ?? realTimers;
	/** 还没记下来的那一段从哪一刻起;`undefined` = 没在记(没开始,或已经停了)。 */
	let cursor: number | undefined;
	let handle: unknown;
	let stopped = false;

	async function write(from: number, to: number): Promise<void> {
		const minutes = Math.round((to - from) / MINUTE_MS);
		// 0 分钟不值得一行(开机即关、睡醒即停)。
		if (minutes <= 0) return;
		try {
			await opts.store.append({
				hourStartedAt: new Date(hourFloor(from)).toISOString(),
				minutes: Math.min(minutes, 60),
			});
		} catch (err) {
			opts.logger.warn(`[uptime] 记一小时的运行分钟失败:${String(err)}`);
		}
	}

	/**
	 * 把 `cursor` 推进到 `at`:跨过整点就把那一小时记掉。跨了不止一个整点(睡过去了)只记最初那一小时,
	 * 游标直接跳到 `at`。返回时 `cursor` 与 `at` 在同一个小时里(或 `at` 早于游标,时钟回拨,原地不动)。
	 */
	async function settle(at: number): Promise<void> {
		if (cursor === undefined) return;
		const boundary = hourFloor(cursor) + HOUR_MS;
		if (at < boundary) return;
		const from = cursor;
		cursor = at >= boundary + HOUR_MS ? at : boundary;
		await write(from, boundary);
	}

	function arm(): void {
		if (cursor === undefined) return;
		const delay = Math.max(hourFloor(cursor) + HOUR_MS - now(), 0);
		handle = timers.set(tick, delay);
	}

	async function tick(): Promise<void> {
		if (stopped || cursor === undefined) return;
		await settle(now());
		// 定时器提前响(时钟被拨回过):没跨过整点,`settle` 什么都没记,重排即可。
		// 等写盘的时候可能已经 stop 了,那就不再排。
		if (!stopped) arm();
	}

	return {
		start() {
			if (cursor !== undefined || stopped) return;
			cursor = now();
			arm();
		},

		async stop() {
			if (stopped) return;
			stopped = true;
			if (handle !== undefined) timers.clear(handle);
			handle = undefined;
			if (cursor === undefined) return;
			const at = now();
			await settle(at);
			// `settle` 之后游标与 `at` 同属一个小时(时钟回拨则 `at` 在游标之前,`write` 里按 0 分钟丢掉)。
			await write(cursor, at);
			cursor = undefined;
		},
	};
}
