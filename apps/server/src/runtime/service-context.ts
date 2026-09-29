import type { Disposable, DisposePhase, Logger, ServiceContext } from "@bilibili-notify/internal";
import { type DestinationStream, type Logger as PinoLogger, pino } from "pino";
import prettyFactory from "pino-pretty";
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
	/**
	 * 日志落点,默认 stdout(fd 1)。pretty 模式下作为 pino-pretty 的 destination,
	 * 非 pretty 直接作为 pino 的目标 stream。测试用它捕获输出;生产不传。
	 */
	destination?: DestinationStream;
}

/**
 * Standalone-end ServiceContext:
 *  - logger: pino (real production logger, not console)
 *  - setInterval / setTimeout: returns Disposable that clears the underlying timer
 *  - onDispose: queues a teardown hook into its {@link DisposePhase}; run by `dispose()`
 *  - track: registers a fire-and-forget background task that shutdown waits for
 *  - signal: aborted as soon as shutdown starts
 *
 * The `dispose()` method on the returned object is the shutdown hook, see {@link NodeServiceContext.dispose}.
 *
 * The `setLogHook(fn)` method swaps in a log forwarder after construction. Used by the
 * WS layer to feed `logger.<level>(...)` calls onto the `log` channel without the
 * core `Logger` interface having to know anything about WebSockets.
 */
interface SubsystemContext extends ServiceContext {
	/**
	 * Mutate the subsystem's pino level at runtime. Pino exposes `.level`
	 * as a writeable property; this just forwards. Used by engines.ts when
	 * `config-changed: globals` arrives so log-level changes via the dashboard
	 * take effect without a server restart.
	 */
	setLevel(level: string): void;
}

export interface NodeServiceContext extends ServiceContext {
	/**
	 * 关停:中止 `signal`、清掉挂着的定时器，再按 `stop → drain →(等后台活)→ flush → dispose` 跑钩子，
	 * 同一段里后登记的先跑。再调一次拿到的是同一次关停。
	 *
	 * 预算(`timeoutMs`,不传就一直等):`flush` 之前的等待只等到 `timeoutMs - flushReserveMs` 为止，给写道
	 * 落盘留出余量;到点就不再等，但剩下的钩子照样调用 —— 写道得有机会关门，关停返回以后才不会再有写入
	 * 落进数据目录。关停中开的定时器在收完时清掉，收完以后开的一次也不跑。
	 */
	dispose(options?: { timeoutMs?: number; flushReserveMs?: number }): Promise<void>;
	/**
	 * Install (or clear) the log forwarder. Pass `undefined` to detach.
	 * Returns the previous hook so callers can restore it on dispose.
	 */
	setLogHook(fn: ((entry: LogEntry) => void) | undefined): ((entry: LogEntry) => void) | undefined;
	/** Mutate the base pino logger's level at runtime. */
	setLevel(level: string): void;
	/**
	 * Spawn a child ServiceContext for a named subsystem (engine module). The
	 * child shares timers / onDispose / WS log hook with the parent but its
	 * `logger` writes through a fresh pino instance whose `name` is just the bare
	 * subsystem (e.g. `live`) and an independent `level`. Used by engines.ts to
	 * give each business engine
	 * (dynamic / live / image / ai) its own log pipeline so operators can crank
	 * one to debug without flooding the others.
	 */
	forSubsystem(name: string, level: string | undefined): SubsystemContext;
}

export function createNodeServiceContext(opts: NodeServiceContextOptions): NodeServiceContext {
	const pretty = opts.pretty ?? Boolean(process.stdout.isTTY);
	// pretty 走**进程内**pino-pretty 同步 stream,而非 pino transport:transport 的
	// worker 线程在运行时按模块路径解析 "pino-pretty",单文件 bundle 后该路径不存在,
	// `docker run -t`(TTY→pretty)会直接崩。sync stream 是 pino 官方对 bundler 场景
	// 的推荐形态,顺带免掉 base + 每个 forSubsystem 子系统各一条 worker 线程。
	// 每个 pino 实例配自己的 stream(镜像旧 transport 逐实例语义);未注入 destination
	// 时 pino-pretty 落 fd 1、非 pretty 走 pino 默认 stdout,生产行为不变。
	const makeDest = (): DestinationStream | undefined =>
		pretty
			? prettyFactory({
					colorize: true,
					translateTime: "SYS:HH:MM:ss.l",
					destination: opts.destination ?? 1,
				})
			: opts.destination;
	const baseLogger = pino(
		{
			name: opts.name,
			level: opts.level ?? "info",
		},
		makeDest(),
	);

	let logHook: ((entry: LogEntry) => void) | undefined = opts.onLog;

	// pino's per-method overloads collide with our `(msg: string, ...args: unknown[])`
	// shape because pino expects either `(msg, ...string[])` or `(obj, msg?, ...args)`.
	// We funnel through a tiny adapter that forwards verbatim, then fans out to the hook.
	const callPino = (fn: (...a: unknown[]) => void, msg: string, args: readonly unknown[]): void => {
		fn(msg, ...args);
	};
	const fanOut = (
		target: PinoLogger,
		name: string,
		level: LogLevel,
		msg: string,
		args: readonly unknown[],
	): void => {
		// Gate the side-channel by the SAME live pino level that gates stdout, so
		// the Logs Tab + on-disk archive mirror the console exactly, per module.
		// `isLevelEnabled` re-reads the instance's `.level`, so config-changed
		// `setLevel()` hot-reloads take effect with no restart.
		if (!target.isLevelEnabled(level)) return;
		const hook = logHook;
		if (!hook) return;
		try {
			hook({ level, msg, args: [...args], ts: new Date().toISOString(), name });
		} catch {
			// Never let a misbehaving hook break the logger path. We can't log the failure
			// without recursing through ourselves, so swallow.
		}
	};
	const wrapLogger = (target: PinoLogger, name: string): Logger => ({
		info: (msg, ...args) => {
			callPino(target.info.bind(target) as never, msg, args);
			fanOut(target, name, "info", msg, args);
		},
		warn: (msg, ...args) => {
			callPino(target.warn.bind(target) as never, msg, args);
			fanOut(target, name, "warn", msg, args);
		},
		error: (msg, ...args) => {
			callPino(target.error.bind(target) as never, msg, args);
			fanOut(target, name, "error", msg, args);
		},
		debug: (msg, ...args) => {
			callPino(target.debug.bind(target) as never, msg, args);
			fanOut(target, name, "debug", msg, args);
		},
	});
	const logger = wrapLogger(baseLogger, opts.name);

	const intervals = new Set<NodeJS.Timeout>();
	const timeouts = new Set<NodeJS.Timeout>();
	const hooks: Record<DisposePhase, Array<() => void | Promise<void>>> = {
		stop: [],
		drain: [],
		flush: [],
		dispose: [],
	};
	/** 已经跑完的段:之后再登记进来的钩子当场跑，不然就漏了。 */
	const finishedPhases = new Set<DisposePhase>();
	const tracked = new Set<Promise<void>>();
	const shutdown = new AbortController();
	let disposing: Promise<void> | undefined;
	/** 关停整个收完了:之后开的定时器一次也不跑(在途的活收尾晚了，会想再挂一个上来)。 */
	let disposed = false;

	const clearTimers = (): void => {
		for (const h of intervals) clearInterval(h);
		intervals.clear();
		for (const h of timeouts) clearTimeout(h);
		timeouts.clear();
	};

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
		if (disposed) return NOOP_DISPOSABLE;
		const handle = setInterval(fn, ms);
		intervals.add(handle);
		return wrapInterval(handle);
	};
	const setTimeoutImpl: ServiceContext["setTimeout"] = (fn, ms) => {
		if (disposed) return NOOP_DISPOSABLE;
		const handle: NodeJS.Timeout = setTimeout(() => {
			timeouts.delete(handle);
			fn();
		}, ms);
		timeouts.add(handle);
		return wrapTimeout(handle);
	};

	/** 跑一个钩子:同步抛的、异步拒的都只记一条 error,不往外抛。 */
	const runHook = (fn: () => void | Promise<void>): Promise<void> =>
		Promise.resolve()
			.then(fn)
			.catch((err: unknown) => logger.error("onDispose hook threw", err));

	const onDisposeImpl: ServiceContext["onDispose"] = (fn, phase = "dispose") => {
		if (finishedPhases.has(phase)) {
			void runHook(fn);
			return;
		}
		hooks[phase].push(fn);
	};

	const trackImpl: ServiceContext["track"] = (task) => {
		const settled = task.then(
			() => undefined,
			(err: unknown) => logger.error("后台任务失败(调用方没接住)", err),
		);
		tracked.add(settled);
		void settled.then(() => tracked.delete(settled));
	};

	/** 等 `task` 到 `until` 为止;按时落定回 true。`task` 自己不会拒(上面两处都接住了)。 */
	const settlesBy = async (task: Promise<unknown>, until: number): Promise<boolean> => {
		if (until === Number.POSITIVE_INFINITY) {
			await task;
			return true;
		}
		const left = until - Date.now();
		if (left <= 0) return false;
		// 裸定时器:它不归上面的 timeouts 管,清定时器那一下清不到它。
		let timer: NodeJS.Timeout | undefined;
		const timedOut = new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), left);
			timer.unref?.();
		});
		try {
			return await Promise.race([task.then(() => true as const), timedOut]);
		} finally {
			clearTimeout(timer);
		}
	};

	const runPhase = async (phase: DisposePhase, until: number): Promise<void> => {
		const list = hooks[phase];
		let overBudget = false;
		while (list.length > 0) {
			const fn = list.pop() as () => void | Promise<void>;
			const run = runHook(fn);
			if (overBudget) continue;
			if (!(await settlesBy(run, until))) {
				overBudget = true;
				logger.warn(
					`[dispose] ${phase} 段超出关停预算，不再等;剩下的 ${list.length} 个钩子照样调用`,
				);
			}
		}
		finishedPhases.add(phase);
	};

	const settleTracked = async (until: number): Promise<void> => {
		// 活里还会接着登记新活，所以一轮一轮等到空。
		while (tracked.size > 0) {
			if (!(await settlesBy(Promise.all(tracked), until))) {
				logger.warn(`[dispose] 还有 ${tracked.size} 件后台任务没落定，超出关停预算，不再等`);
				return;
			}
		}
	};

	return {
		logger,
		signal: shutdown.signal,
		setInterval: setIntervalImpl,
		setTimeout: setTimeoutImpl,
		onDispose: onDisposeImpl,
		track: trackImpl,
		setLogHook(fn) {
			const prev = logHook;
			logHook = fn;
			return prev;
		},
		setLevel(level: string): void {
			baseLogger.level = level;
		},
		forSubsystem(name: string, level: string | undefined): SubsystemContext {
			const subPino = pino(
				{
					name,
					level: level ?? opts.level ?? "info",
				},
				makeDest(),
			);
			return {
				logger: wrapLogger(subPino, name),
				signal: shutdown.signal,
				setInterval: setIntervalImpl,
				setTimeout: setTimeoutImpl,
				onDispose: onDisposeImpl,
				track: trackImpl,
				setLevel(next: string): void {
					subPino.level = next;
				},
			};
		},
		dispose(options = {}) {
			disposing ??= (async () => {
				const { timeoutMs = Number.POSITIVE_INFINITY, flushReserveMs = 0 } = options;
				const deadline = Date.now() + timeoutMs;
				const beforeFlush = deadline - flushReserveMs;
				shutdown.abort();
				clearTimers();
				await runPhase("stop", beforeFlush);
				await runPhase("drain", beforeFlush);
				await settleTracked(beforeFlush);
				await runPhase("flush", deadline);
				await runPhase("dispose", deadline);
				disposed = true;
				clearTimers();
			})();
			return disposing;
		},
	};
}

const NOOP_DISPOSABLE: Disposable = { dispose() {} };
