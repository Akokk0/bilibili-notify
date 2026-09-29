/**
 * 「发出去不管的写」有没有登记进 `ctx.track()` 的测试替身。
 *
 * 只断言 `track` 被调过不算数 —— 关停等的是**那笔写落定**,交进来的 promise 要是在写之前就
 * resolve,登记了也等于没登。骨架:
 *
 * ```ts
 * const ctx = makeTrackingContext();
 * // ……把写停在半路(deferred / storage-write-gate),触发被测的那条路
 * expect(ctx.tracked).toHaveLength(1);
 * expect(await stillPending(ctx.settled())).toBe(true); // 写还没落,登记的这件事也不许落
 * release();
 * await ctx.settled();
 * // ……断言写已经落定
 * ```
 *
 * `track` 没接线时 `tracked` 是空数组,`settled()` 立刻落定,第二句必红。
 */

import type { ServiceContext } from "@bilibili-notify/internal";

export interface TrackingContext extends Pick<ServiceContext, "track" | "signal"> {
	/** 交进 `track` 的每一件后台活,按交进来的次序。 */
	readonly tracked: Promise<unknown>[];
	/** 等到目前为止登记的全部落定(登记的 promise 本身不会拒)。 */
	settled(): Promise<unknown>;
	/** 模拟关停开始:中止 `signal`。 */
	abort(): void;
}

export function makeTrackingContext(): TrackingContext {
	const tracked: Promise<unknown>[] = [];
	const shutdown = new AbortController();
	return {
		tracked,
		signal: shutdown.signal,
		track: (task) => {
			tracked.push(task);
		},
		settled: () => Promise.allSettled(tracked),
		abort: () => shutdown.abort(),
	};
}

/** `waitMs` 之内 `task` 还没落定 → true。用来断言「写没落之前,登记的这件事也不许落」。 */
export async function stillPending(task: Promise<unknown>, waitMs = 30): Promise<boolean> {
	const timedOut = Symbol("timed out");
	const winner = await Promise.race([
		task.then(
			() => "settled",
			() => "settled",
		),
		new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), waitMs)),
	]);
	return winner === timedOut;
}

export interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T | PromiseLike<T>): void;
	reject(reason?: unknown): void;
}

/** 手控的 promise:让一笔「写」停在半路,放行的时刻由测试说了算。 */
export function deferred<T = void>(): Deferred<T> {
	let resolve!: Deferred<T>["resolve"];
	let reject!: Deferred<T>["reject"];
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}
