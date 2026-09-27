/**
 * 写道:按键串行的任务队列。同一个键上的任务严格按交进来的顺序一个接一个跑,前一个失败
 * 不挡后一个;不同键之间互不等待。要全局串行就只用一个键。
 *
 * 关停时先 flush 再关门:关门之后交进来的一律拒绝、任务一次都不跑,关停返回以后不会再有写入落盘。
 */

/** 关门之后还往里交任务。 */
export class SerialQueueClosedError extends Error {
	readonly code = "queue_closed";
	constructor() {
		super("写道已关门,不再接受新任务");
		this.name = "SerialQueueClosedError";
	}
}

export interface SerialQueue {
	/** 排在这个键已有任务之后执行;返回任务自己的结果或错误。 */
	run<T>(key: string, task: () => T | Promise<T>): Promise<T>;
	/** 等到交进来的任务全部落定(成功或失败都算),等待期间新交进来的也等。从不 reject。 */
	flush(): Promise<void>;
	/** 关门:此后的 run 直接以 {@link SerialQueueClosedError} 拒绝;等进行中与已排队的做完才返回。 */
	close(): Promise<void>;
	readonly closed: boolean;
}

export function createSerialQueue(): SerialQueue {
	const tails = new Map<string, Promise<unknown>>();
	let closed = false;

	const queue: SerialQueue = {
		get closed() {
			return closed;
		},

		run(key, task) {
			if (closed) return Promise.reject(new SerialQueueClosedError());
			const prev = tails.get(key) ?? Promise.resolve();
			const result = prev.then(() => task());
			const tail = result.then(
				() => undefined,
				() => undefined,
			);
			tails.set(key, tail);
			void tail.then(() => {
				if (tails.get(key) === tail) tails.delete(key);
			});
			return result;
		},

		async flush() {
			while (tails.size > 0) await Promise.all(tails.values());
		},

		async close() {
			closed = true;
			await queue.flush();
		},
	};
	return queue;
}
