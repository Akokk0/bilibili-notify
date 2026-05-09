import type { Disposable, Logger, ServiceContext } from "@bilibili-notify/internal";
import { type Logger as PinoLogger, pino } from "pino";
import type { LogEntry, LogLevel } from "../ws/types.js";

export interface NodeServiceContextOptions {
	/** Component name; surfaces as `name` in pino output. */
	name: string;
	/** pino level. Defaults to `info`. */
	level?: string;
	/** Pretty-print to stdout in dev. Defaults to true when stdout is a TTY. */
	pretty?: boolean;
	/**
	 * Optional log forwarder. Every `logger.<level>(msg, ...args)` call invokes
	 * this AFTER the underlying pino logger. The WS `log` channel installs one
	 * post-construction via `setLogHook` (chicken-and-egg: we need a serviceCtx
	 * to build the WS server, but the WS server provides the hook).
	 */
	onLog?: (entry: LogEntry) => void;
}

/**
 * Standalone-end ServiceContext. Mirrors the koishi-runtime adapter shape:
 *  - logger: pino (real production logger, not console)
 *  - setInterval / setTimeout: returns Disposable that clears the underlying timer
 *  - onDispose: queues a teardown hook; flushed by `dispose()` (and the bootstrap loop on SIGINT)
 *
 * The `dispose()` method on the returned object is the standalone-side equivalent of
 * koishi's "the plugin scope was torn down" — it clears every still-pending timer and
 * runs every queued onDispose hook in LIFO order.
 *
 * The `setLogHook(fn)` method swaps in a log forwarder after construction. Used by the
 * WS layer to feed `logger.<level>(...)` calls onto the `log` channel without the
 * core `Logger` interface having to know anything about WebSockets.
 */
export interface NodeServiceContext extends ServiceContext {
	/** Tear down all pending timers + onDispose hooks (LIFO). Idempotent. */
	dispose(): Promise<void>;
	/**
	 * Install (or clear) the log forwarder. Pass `undefined` to detach.
	 * Returns the previous hook so callers can restore it on dispose.
	 */
	setLogHook(fn: ((entry: LogEntry) => void) | undefined): ((entry: LogEntry) => void) | undefined;
	/**
	 * Spawn a child ServiceContext for a named subsystem (engine module). The
	 * child shares timers / onDispose / WS log hook with the parent but its
	 * `logger` writes through a fresh pino instance with `name=parent:sub` and
	 * an independent `level`. Used by engines.ts to give each business engine
	 * (dynamic / live / image / ai) its own log pipeline so operators can crank
	 * one to debug without flooding the others. Pino level is set at construct
	 * time, so changing logLevels at runtime requires a server restart.
	 */
	forSubsystem(name: string, level: string | undefined): ServiceContext;
}

export function createNodeServiceContext(opts: NodeServiceContextOptions): NodeServiceContext {
	const pretty = opts.pretty ?? Boolean(process.stdout.isTTY);
	const transportOpt = pretty
		? {
				transport: {
					target: "pino-pretty" as const,
					options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" },
				},
			}
		: {};
	const baseLogger = pino({
		name: opts.name,
		level: opts.level ?? "info",
		...transportOpt,
	});

	let logHook: ((entry: LogEntry) => void) | undefined = opts.onLog;

	// pino's per-method overloads collide with our `(msg: string, ...args: unknown[])`
	// shape because pino expects either `(msg, ...string[])` or `(obj, msg?, ...args)`.
	// We funnel through a tiny adapter that forwards verbatim, then fans out to the hook.
	const callPino = (fn: (...a: unknown[]) => void, msg: string, args: readonly unknown[]): void => {
		fn(msg, ...args);
	};
	const fanOut = (level: LogLevel, msg: string, args: readonly unknown[]): void => {
		const hook = logHook;
		if (!hook) return;
		try {
			hook({ level, msg, args: [...args], ts: new Date().toISOString() });
		} catch {
			// Never let a misbehaving hook break the logger path. We can't log the failure
			// without recursing through ourselves, so swallow.
		}
	};
	const wrapLogger = (target: PinoLogger): Logger => ({
		info: (msg, ...args) => {
			callPino(target.info.bind(target) as never, msg, args);
			fanOut("info", msg, args);
		},
		warn: (msg, ...args) => {
			callPino(target.warn.bind(target) as never, msg, args);
			fanOut("warn", msg, args);
		},
		error: (msg, ...args) => {
			callPino(target.error.bind(target) as never, msg, args);
			fanOut("error", msg, args);
		},
		debug: (msg, ...args) => {
			callPino(target.debug.bind(target) as never, msg, args);
			fanOut("debug", msg, args);
		},
	});
	const logger = wrapLogger(baseLogger);

	const intervals = new Set<NodeJS.Timeout>();
	const timeouts = new Set<NodeJS.Timeout>();
	const disposeHooks: Array<() => void | Promise<void>> = [];
	let disposed = false;

	const wrapInterval = (handle: NodeJS.Timeout): Disposable => ({
		dispose() {
			if (intervals.delete(handle)) clearInterval(handle);
		},
	});

	const wrapTimeout = (handle: NodeJS.Timeout): Disposable => ({
		dispose() {
			if (timeouts.delete(handle)) clearTimeout(handle);
		},
	});

	const setIntervalImpl: ServiceContext["setInterval"] = (fn, ms) => {
		const handle = setInterval(fn, ms);
		intervals.add(handle);
		return wrapInterval(handle);
	};
	const setTimeoutImpl: ServiceContext["setTimeout"] = (fn, ms) => {
		const handle: NodeJS.Timeout = setTimeout(() => {
			timeouts.delete(handle);
			fn();
		}, ms);
		timeouts.add(handle);
		return wrapTimeout(handle);
	};
	const onDisposeImpl: ServiceContext["onDispose"] = (fn) => {
		if (disposed) {
			// Mirror "scope already torn down" semantics: schedule asap so callers don't leak.
			queueMicrotask(() => {
				Promise.resolve(fn()).catch((err: unknown) =>
					logger.error("onDispose hook (post-dispose) threw", err),
				);
			});
			return;
		}
		disposeHooks.push(fn);
	};

	return {
		logger,
		setInterval: setIntervalImpl,
		setTimeout: setTimeoutImpl,
		onDispose: onDisposeImpl,
		setLogHook(fn) {
			const prev = logHook;
			logHook = fn;
			return prev;
		},
		forSubsystem(name: string, level: string | undefined): ServiceContext {
			const subPino = pino({
				name: `${opts.name}:${name}`,
				level: level ?? opts.level ?? "info",
				...transportOpt,
			});
			return {
				logger: wrapLogger(subPino),
				setInterval: setIntervalImpl,
				setTimeout: setTimeoutImpl,
				onDispose: onDisposeImpl,
			};
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			for (const h of intervals) clearInterval(h);
			intervals.clear();
			for (const h of timeouts) clearTimeout(h);
			timeouts.clear();
			while (disposeHooks.length > 0) {
				const fn = disposeHooks.pop();
				if (!fn) continue;
				try {
					await fn();
				} catch (err) {
					logger.error("onDispose hook threw", err);
				}
			}
		},
	};
}
