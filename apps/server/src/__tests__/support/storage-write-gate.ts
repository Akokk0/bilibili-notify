/**
 * 存储层写函数前的一道闸,测「关停等在途的写落盘」用。
 *
 * 不垫延迟的话,`close()` 调到时那笔写早就落了 —— 把实现里等在途的那一句删掉,测试照样绿。
 * 所以让写停在闸门口:发一笔写 → 等它走到闸 → 调 `close()` → 断言它**还没**落定 → 放闸 → 断言写落了盘。
 *
 * 用法(`vi.mock` 的工厂会被提到 import 之上,所以模块得在工厂里动态取):
 *
 * ```ts
 * vi.mock("@bilibili-notify/storage", async (importOriginal) => {
 *   const { gateStorageWrites } = await import("../../__tests__/support/storage-write-gate.js");
 *   return gateStorageWrites(await importOriginal<typeof import("@bilibili-notify/storage")>());
 * });
 * ```
 *
 * 闸默认敞开(直通),只有 {@link storageWriteGate.hold} 之后才拦;每条用例结束记得 `release()`。
 */

import type * as Storage from "@bilibili-notify/storage";

let holding: Promise<void> | undefined;
let open: (() => void) | undefined;
let reach: (() => void) | undefined;
let reached: Promise<void> = Promise.resolve();
let writes = 0;

export const storageWriteGate = {
	/** 从现在起,再来的写都停在闸门口。 */
	hold(): void {
		holding = new Promise<void>((resolve) => {
			open = resolve;
		});
		reached = new Promise<void>((resolve) => {
			reach = resolve;
		});
	},
	/** 至少有一笔写走到了闸门口时落定。 */
	arrived(): Promise<void> {
		return reached;
	},
	/** 放闸:停着的写继续,之后的写直通。 */
	release(): void {
		open?.();
		holding = undefined;
		open = undefined;
	},
	/** 一共有多少笔写走到过存储层(不管拦没拦)。用来断言「关门之后没有碰盘」。 */
	get writes(): number {
		return writes;
	},
	reset(): void {
		this.release();
		writes = 0;
	},
};

/** 把 `@bilibili-notify/storage` 的落盘函数包上这道闸,其余原样。 */
export function gateStorageWrites(storage: typeof Storage): typeof Storage {
	const gated =
		<A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
		async (...args: A): Promise<R> => {
			writes++;
			if (holding) {
				reach?.();
				await holding;
			}
			return fn(...args);
		};
	return {
		...storage,
		atomicWriteFile: gated(storage.atomicWriteFile),
		atomicWriteJson: gated(storage.atomicWriteJson),
		appendLines: gated(storage.appendLines),
		appendJsonl: gated(storage.appendJsonl),
	};
}
