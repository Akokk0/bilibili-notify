export interface ParentProcessWatchdogOptions {
	readonly intervalMs?: number;
	readonly closeTimeoutMs?: number;
	readonly isParentAlive?: (parentPid: number) => boolean;
	readonly getCurrentParentPid?: () => number | undefined;
	readonly exit?: (code: number) => void;
}

export interface ParentProcessWatchdogHandle {
	stop(): void;
}

export function installParentProcessWatchdog(
	sidecar: { close(reason?: string): Promise<boolean | undefined> },
	parentPid: number | undefined,
	options: ParentProcessWatchdogOptions = {},
): ParentProcessWatchdogHandle {
	const watchedParentPid = parentPid;
	if (
		typeof watchedParentPid !== "number" ||
		!Number.isInteger(watchedParentPid) ||
		watchedParentPid < 1
	) {
		return { stop() {} };
	}

	const intervalMs = options.intervalMs ?? 2_000;
	const closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
	const isParentProcessAlive = options.isParentAlive ?? isProcessAlive;
	const getCurrentParentPid = options.getCurrentParentPid ?? (() => process.ppid);
	const exit = options.exit ?? ((code: number) => process.exit(code));
	let stopped = false;
	let closing = false;
	const timer = setInterval(() => {
		if (stopped || closing) {
			return;
		}
		if (isWatchedParentAlive(watchedParentPid, isParentProcessAlive, getCurrentParentPid)) {
			return;
		}
		closing = true;
		void (async () => {
			try {
				const closed = await withTimeout(sidecar.close("parent-exited"), closeTimeoutMs);
				if (closed === false) {
					closing = false;
					return;
				}
				stop();
				exit(0);
			} catch (error) {
				console.error("[astrbot] parent watchdog failed to close sidecar:", error);
				stop();
				exit(1);
			}
		})();
	}, intervalMs);
	if (typeof timer.unref === "function") {
		timer.unref();
	}

	function stop(): void {
		if (stopped) {
			return;
		}
		stopped = true;
		clearInterval(timer);
	}

	return { stop };
}

function isWatchedParentAlive(
	parentPid: number,
	isParentAlive: (parentPid: number) => boolean,
	getCurrentParentPid: () => number | undefined,
): boolean {
	const currentParentPid = getCurrentParentPid();
	if (
		typeof currentParentPid === "number" &&
		Number.isInteger(currentParentPid) &&
		currentParentPid >= 1 &&
		currentParentPid !== parentPid
	) {
		return false;
	}
	return isParentAlive(parentPid);
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (isProcessLookupError(error)) {
			return false;
		}
		return true;
	}
}

function isProcessLookupError(error: unknown): boolean {
	return Boolean(
		error &&
			typeof error === "object" &&
			"code" in error &&
			(error.code === "ESRCH" || error.code === "EINVAL"),
	);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		return promise;
	}
	let timeout: ReturnType<typeof setTimeout> | undefined;
	return new Promise<T>((resolve, reject) => {
		timeout = setTimeout(() => {
			reject(new Error(`Timed out closing sidecar after ${timeoutMs}ms`));
		}, timeoutMs);
		if (typeof timeout.unref === "function") {
			timeout.unref();
		}
		promise.then(resolve, reject).finally(() => {
			if (timeout) {
				clearTimeout(timeout);
			}
		});
	});
}
