import type { Disposable } from "@bilibili-notify/internal";

/**
 * 按键合并、窗口到了发一次(尾沿)。
 *
 * 某个键第一次被 {@link KeyedCoalescer.touch} 起算一个窗口,窗口里再碰**不往后推**;到点对这个键发一次
 * `onFire`,之后再碰重新起算。不同的键各算各的。
 *
 * - `onFire` 抛错:给了 `onError` 就交给它(别的键与后续不受影响);没给就照旧往外抛 —— 键在调用前已经摘了,
 *   后续照常起算。
 * - `cancel` / `cancelAll` 只作废挂着的,之后再碰照常起算;`dispose` 作废挂着的并拒绝之后的 `touch`(关停用)。
 */
export interface KeyedCoalescer {
	touch(key: string): void;
	/** 这个键挂着的作废。 */
	cancel(key: string): void;
	/** 全部挂着的作废;之后再碰仍然发。 */
	cancelAll(): void;
	/** 全部挂着的作废,之后再碰的也不发。 */
	dispose(): void;
}

export interface CreateKeyedCoalescerOptions {
	/** 窗口长度(毫秒),从第一次碰起算。 */
	windowMs: number;
	onFire: (key: string) => void;
	/** `onFire` 抛了怎么办;不给就让它往外抛。 */
	onError?: (key: string, err: unknown) => void;
	/** 计时器;不给就是全局 `setTimeout`。宿主要求计时器可回收时(`serviceCtx.setTimeout`)传它。 */
	setTimer?: (fn: () => void, ms: number) => Disposable;
}

export function createKeyedCoalescer(opts: CreateKeyedCoalescerOptions): KeyedCoalescer {
	const setTimer =
		opts.setTimer ??
		((fn: () => void, ms: number): Disposable => {
			const timer = setTimeout(fn, ms);
			return { dispose: () => clearTimeout(timer) };
		});
	const pending = new Map<string, Disposable>();
	let disposed = false;

	function cancelAll(): void {
		for (const timer of pending.values()) timer.dispose();
		pending.clear();
	}

	return {
		touch(key) {
			if (disposed || pending.has(key)) return;
			pending.set(
				key,
				setTimer(() => {
					pending.delete(key);
					if (!opts.onError) {
						opts.onFire(key);
						return;
					}
					try {
						opts.onFire(key);
					} catch (err) {
						opts.onError(key, err);
					}
				}, opts.windowMs),
			);
		},
		cancel(key) {
			pending.get(key)?.dispose();
			pending.delete(key);
		},
		cancelAll,
		dispose() {
			disposed = true;
			cancelAll();
		},
	};
}
