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
 * 替代 apps/server/src/bilibili/api/api.ts 中手写的 pRetry-like 逻辑（被 plan §七 列入清理项）。
 */
export async function retry<T>(
	fn: (attempt: number) => Promise<T>,
	opts: RetryOptions = {},
): Promise<T> {
	// P2:范围归一。此前 attempts<=0 → for 循环一次不跑 → throw lastErr(此时
	// 为 undefined),调用方收到 `throw undefined` 极难定位。其余项防呆同理。
	const attempts = Math.max(1, Math.floor(opts.attempts ?? 3));
	const baseDelay = Math.max(0, opts.baseDelayMs ?? 200);
	const factor = Math.max(1, opts.factor ?? 2);
	const maxDelay = Math.max(0, opts.maxDelayMs ?? 30_000);

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
	// P2:末次尝试失败后,若期间已 abort,应抛 abort 原因而非 fn 错误 ——
	// 调用方据 abort 分辨"被取消"vs"真失败"。此前直接 throw lastErr 丢了语义。
	opts.signal?.throwIfAborted?.();
	throw lastErr;
}
