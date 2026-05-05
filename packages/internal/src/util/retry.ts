export interface RetryOptions {
	/** 最大尝试次数（含首次）。默认 3。 */
	attempts?: number;
	/** 基础延迟（毫秒）。下一次尝试延迟 = baseDelayMs * factor^attempt。 */
	baseDelayMs?: number;
	/** 指数退避因子。默认 2。 */
	factor?: number;
	/** 上限延迟（毫秒）。默认 30000。 */
	maxDelayMs?: number;
	/** 自定义判定：返回 false 表示不该重试，立即抛出。 */
	shouldRetry?: (err: unknown, attempt: number) => boolean;
	/** 重试前回调。 */
	onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
	/** AbortSignal：中途取消，立即停止并抛出 abort 错误。 */
	signal?: AbortSignal;
}

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const t = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(t);
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});

/**
 * 通用重试。失败时按指数退避延迟，达 attempts 后抛出最后一次错误。
 * 替代 packages/api/src/bilibili-api.ts 中手写的 pRetry-like 逻辑（被 plan §七 列入清理项）。
 */
export async function retry<T>(
	fn: (attempt: number) => Promise<T>,
	opts: RetryOptions = {},
): Promise<T> {
	const attempts = opts.attempts ?? 3;
	const baseDelay = opts.baseDelayMs ?? 200;
	const factor = opts.factor ?? 2;
	const maxDelay = opts.maxDelayMs ?? 30_000;

	let lastErr: unknown;
	for (let i = 1; i <= attempts; i++) {
		opts.signal?.throwIfAborted?.();
		try {
			return await fn(i);
		} catch (err) {
			lastErr = err;
			if (i === attempts) break;
			if (opts.shouldRetry && !opts.shouldRetry(err, i)) break;
			const delay = Math.min(baseDelay * factor ** (i - 1), maxDelay);
			opts.onRetry?.(err, i, delay);
			await sleep(delay, opts.signal);
		}
	}
	throw lastErr;
}
