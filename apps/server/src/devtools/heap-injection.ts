import type { MemoryUsageSample } from "../runtime/resource-monitor.js";

/**
 * 堆读数注入 —— devtools 的「堆逼近上限」。
 *
 * 真把堆吃到 92% 才看得到环转橙那一档,而那要么等几个小时的泄漏、要么写个撑爆内存的脚本。
 *
 * 注入的是**读数**而不是显示值:占比由采样器照常算、warn 由它照常判、sparkline 照常
 * 攒 —— 三件事一起发生正是要验的东西。换成「直接把 92% 塞给面板」就只验了一个染色。
 */
export interface HeapInjector {
	/** 注入一个 0..1 的堆占比;之后读数按「占比 × 堆上限」报。 */
	inject(ratio: number): void;
	clear(): void;
}

export interface HeapInjectorHandle extends HeapInjector {
	/** 当前注入着的占比,没有就 null。 */
	injected(): number | null;
}

export function heapInjector(): HeapInjectorHandle {
	let fake: number | null = null;
	return {
		inject(ratio) {
			fake = ratio;
		},
		clear() {
			fake = null;
		},
		injected: () => fake,
	};
}

/**
 * 把真读数口包一层。没注入时**原样交出去**,一个字节都不改。
 */
export function injectedMemoryUsage(
	real: () => MemoryUsageSample,
	injector: HeapInjectorHandle,
	heapLimit: () => number,
): () => MemoryUsageSample {
	return () => {
		const usage = real();
		const ratio = injector.injected();
		if (ratio === null) return usage;
		const heapUsed = ratio * heapLimit();
		return {
			...usage,
			heapUsed,
			// used 比 committed 还大是不可能的状态,面板上「已提交」会看着很怪。
			heapTotal: Math.max(usage.heapTotal, heapUsed),
		};
	};
}
