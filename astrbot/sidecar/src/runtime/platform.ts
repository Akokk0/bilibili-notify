import { EventEmitter } from "node:events";
import type {
	BiliEvents,
	Disposable,
	Logger,
	MessageBus,
	ServiceContext,
} from "@bilibili-notify/internal";

export type SidecarLogLevel = "debug" | "info" | "warn" | "error";

export interface SidecarLogEntry {
	readonly level: SidecarLogLevel;
	readonly name: string;
	readonly msg: string;
	readonly args: readonly unknown[];
	readonly ts: string;
}

export interface SidecarServiceContext extends ServiceContext {
	dispose(): Promise<void>;
	setLevel(level: SidecarLogLevel): void;
	setLogHook(fn: ((entry: SidecarLogEntry) => void) | undefined): void;
}

export interface SidecarServiceContextOptions {
	readonly name: string;
	readonly level?: SidecarLogLevel;
	readonly onLog?: (entry: SidecarLogEntry) => void;
}

const LOG_LEVEL_RANK: Record<SidecarLogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

export function createSidecarMessageBus(): MessageBus {
	const emitter = new EventEmitter();
	emitter.setMaxListeners(0);

	return {
		emit<E extends keyof BiliEvents>(event: E, ...args: Parameters<BiliEvents[E]>): void {
			emitter.emit(event as string, ...(args as unknown[]));
		},
		on<E extends keyof BiliEvents>(event: E, handler: BiliEvents[E]): Disposable {
			const wrapped = (...args: unknown[]) => {
				const result = (handler as (...innerArgs: unknown[]) => unknown)(...args);
				if (result && typeof (result as { then?: unknown }).then === "function") {
					(result as Promise<unknown>).catch((error) => {
						console.error(`[astrbot] async bus handler for ${String(event)} failed:`, error);
					});
				}
			};
			emitter.on(event as string, wrapped);
			return {
				dispose(): void {
					emitter.off(event as string, wrapped);
				},
			};
		},
	};
}

export function createSidecarServiceContext(
	options: SidecarServiceContextOptions,
): SidecarServiceContext {
	let level = options.level ?? "info";
	let logHook = options.onLog;
	let disposed = false;
	const intervals = new Set<NodeJS.Timeout>();
	const timeouts = new Set<NodeJS.Timeout>();
	const disposeHooks: Array<() => void | Promise<void>> = [];

	const isEnabled = (entryLevel: SidecarLogLevel): boolean =>
		LOG_LEVEL_RANK[entryLevel] >= LOG_LEVEL_RANK[level];

	const log = (entryLevel: SidecarLogLevel, msg: string, args: readonly unknown[]): void => {
		if (!isEnabled(entryLevel)) return;
		const entry: SidecarLogEntry = {
			level: entryLevel,
			name: options.name,
			msg,
			args: [...args],
			ts: new Date().toISOString(),
		};
		writeConsole(entry);
		try {
			logHook?.(entry);
		} catch {
			// 日志旁路绝不能影响业务路径。
		}
	};

	const logger: Logger = {
		debug: (msg, ...args) => log("debug", msg, args),
		info: (msg, ...args) => log("info", msg, args),
		warn: (msg, ...args) => log("warn", msg, args),
		error: (msg, ...args) => log("error", msg, args),
	};

	return {
		logger,
		setInterval(fn, ms) {
			const handle = setInterval(fn, ms);
			intervals.add(handle);
			return {
				dispose(): void {
					if (intervals.delete(handle)) clearInterval(handle);
				},
			};
		},
		setTimeout(fn, ms) {
			const handle = setTimeout(() => {
				timeouts.delete(handle);
				fn();
			}, ms);
			timeouts.add(handle);
			return {
				dispose(): void {
					if (timeouts.delete(handle)) clearTimeout(handle);
				},
			};
		},
		onDispose(fn) {
			if (disposed) {
				queueMicrotask(() => {
					Promise.resolve(fn()).catch((error: unknown) =>
						logger.error("post-dispose hook failed", error),
					);
				});
				return;
			}
			disposeHooks.push(fn);
		},
		setLevel(nextLevel) {
			level = nextLevel;
		},
		setLogHook(fn) {
			logHook = fn;
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			for (const handle of intervals) clearInterval(handle);
			intervals.clear();
			for (const handle of timeouts) clearTimeout(handle);
			timeouts.clear();
			while (disposeHooks.length > 0) {
				const hook = disposeHooks.pop();
				if (!hook) continue;
				try {
					await hook();
				} catch (error) {
					logger.error("dispose hook failed", error);
				}
			}
		},
	};
}

function writeConsole(entry: SidecarLogEntry): void {
	const prefix = `[${entry.ts}] [${entry.name}] [${entry.level}]`;
	const args = entry.args.length ? entry.args : [];
	if (entry.level === "error") {
		console.error(prefix, entry.msg, ...args);
		return;
	}
	if (entry.level === "warn") {
		console.warn(prefix, entry.msg, ...args);
		return;
	}
	console.log(prefix, entry.msg, ...args);
}
