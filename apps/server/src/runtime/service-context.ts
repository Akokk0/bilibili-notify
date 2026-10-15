import type { Disposable, DisposePhase, Logger, ServiceContext } from "@bilibili-notify/internal";
import { type DestinationStream, type Logger as PinoLogger, pino } from "pino";
import prettyFactory from "pino-pretty";
import { redactLogCall } from "../logs/redact.js";
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

/** 设置里日志等级的那两格:总等级,与按键(核心的格或集成键)单独写的等级。 */
export interface LogLevelTable {
	level: string;
	levels: Readonly<Record<string, string>>;
}

/**
 * ServiceContext:
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
	/**
	 * 开一个子上下文:日志行的标签是 `name`,等级跟等级表里 `levelKey` 那一格(没写跟总等级)。
	 * 同一对 (name, levelKey) 交回同一个;与父上下文共用定时器、收尾钩子与日志旁路。
	 * 交的是键不是等级值:等级表由 `applyLogLevels` 整张推。
	 */
	forSubsystem(name: string, levelKey: string): ServiceContext;
	/** 整张等级表推一次:基础日志器跟 `core` 那一格,每个子上下文跟自己那一格。 */
	applyLogLevels(logging: LogLevelTable): void;
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
	// pino 对字符串 msg 只拿后续参数做 `%s` 插值,没有占位符时整个丢掉 —— 路由里
	// `log.error("… failed", err)` 在 docker logs / 桌面后台输出里就只剩半句。所以有后续参数时
	// 以「第一个参数是对象就并进这一行」的写法把它们作为 `args` 字段带上(字段名与面板日志
	// 条目的 `LogEntry.args` 同名);同时仍把它们当插值参数交给 pino,`%s` 占位照常展开
	// (被吃掉的参数在 `args` 里也还在,宁可重复也不丢)。交进来的永远是打过码的那份,
	// 不让 pino 的 err 序列化器去碰原始 Error。没有后续参数时调用形状与改前一致。
	const callPino = (fn: (...a: unknown[]) => void, msg: string, args: readonly unknown[]): void => {
		if (args.length === 0) {
			fn(msg);
			return;
		}
		fn({ args }, msg, ...args);
	};
	const fanOut = (name: string, level: LogLevel, msg: string, args: readonly unknown[]): void => {
		const hook = logHook;
		if (!hook) return;
		try {
			hook({ level, msg, args: [...args], ts: new Date().toISOString(), name });
		} catch {
			// Never let a misbehaving hook break the logger path. We can't log the failure
			// without recursing through ourselves, so swallow.
		}
	};
	// 打码只在这一个入口做一次:打过码的 { msg, args } 同时交给 pino(stdout / docker logs /
	// 桌面 sidecar 输出)与钩子(环形缓冲 / 归档),三处出口看到的是同一份。
	// 打码函数自己兜住了异常(见 redactLogCall),这里不会因它弄断日志。
	const emit = (
		target: PinoLogger,
		name: string,
		level: LogLevel,
		msg: string,
		args: readonly unknown[],
	): void => {
		// 旁路与 stdout 用同一个 live pino level 守门,面板日志页 / 归档逐模块与控制台一致。
		// `isLevelEnabled` 每次重读实例的 `.level`,config-changed 的 `applyLogLevels()` 热改免重启。
		if (!target.isLevelEnabled(level)) return;
		const safe = redactLogCall(msg, args);
		callPino(target[level].bind(target) as never, safe.msg, safe.args);
		fanOut(name, level, safe.msg, safe.args);
	};
	const wrapLogger = (target: PinoLogger, name: string): Logger => ({
		info: (msg, ...args) => emit(target, name, "info", msg, args),
		warn: (msg, ...args) => emit(target, name, "warn", msg, args),
		error: (msg, ...args) => emit(target, name, "error", msg, args),
		debug: (msg, ...args) => emit(target, name, "debug", msg, args),
	});
	const logger = wrapLogger(baseLogger, opts.name);

	/** 最近一次推进来的等级表;没推过(开机早期)时子上下文跟 `opts.level`。 */
	let table: LogLevelTable | undefined;
	// 只认表自己的键:`toString`、`__proto__` 这类名字读到的是原型上的东西,交给 pino 当等级就抛。
	const levelOf = (key: string): string => {
		if (!table) return opts.level ?? "info";
		return (Object.hasOwn(table.levels, key) ? table.levels[key] : undefined) ?? table.level;
	};
	/** 每个 (标签, 键) 一个 pino 实例:拓展反复装卸也不会越开越多。 */
	const subsystems = new Map<string, { pino: PinoLogger; levelKey: string; ctx: ServiceContext }>();

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
		applyLogLevels(logging) {
			table = logging;
			baseLogger.level = levelOf("core");
			for (const sub of subsystems.values()) sub.pino.level = levelOf(sub.levelKey);
		},
		forSubsystem(name: string, levelKey: string): ServiceContext {
			const cacheKey = JSON.stringify([name, levelKey]);
			const cached = subsystems.get(cacheKey);
			if (cached) return cached.ctx;
			const subPino = pino({ name, level: levelOf(levelKey) }, makeDest());
			const ctx: ServiceContext = {
				logger: wrapLogger(subPino, name),
				signal: shutdown.signal,
				setInterval: setIntervalImpl,
				setTimeout: setTimeoutImpl,
				onDispose: onDisposeImpl,
				track: trackImpl,
			};
			subsystems.set(cacheKey, { pino: subPino, levelKey, ctx });
			return ctx;
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
