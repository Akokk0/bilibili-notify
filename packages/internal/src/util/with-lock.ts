/**
 * Run an async fn with a single-slot lock: while a previous call is still
 * running, subsequent invocations are dropped (not queued). Useful for cron
 * tasks where a slow tick should not pile up overlapping runs.
 */
export function withLock(fn: () => Promise<void>, onError?: (err: unknown) => void): () => void {
	let locked = false;
	return () => {
		if (locked) return;
		locked = true;
		fn()
			.catch((err) => {
				onError?.(err);
			})
			.finally(() => {
				locked = false;
			});
	};
}
