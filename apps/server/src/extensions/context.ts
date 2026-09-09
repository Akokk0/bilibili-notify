import {
	type Disposable,
	EXTENSION_API_VERSION,
	type Logger,
	type ServiceContext,
} from "@bilibili-notify/internal";
import { type ExtensionFetchHandler, type ExtensionMounts, extensionMountPrefix } from "./mount.js";

/**
 * 交给拓展的那面 —— **第一版刻意很窄**(ADR-0012 决策 13)。
 *
 * 窄面加宽容易,反过来不行;而我们手上只有一个真实用例(桥接),凭空设计「宿主应该提供
 * 什么」就是在猜。⛔ **`bus` 永远不在这里** —— `MessageBus` 是全仓唯一事件通道,给出去
 * 就等于允许写第二条通道之间的转发器(CLAUDE.md 那条硬约束:会自喂死循环爆栈)。
 *
 * 🔴 拓展的**一切副作用都得从这里过**:裸 `setInterval`、裸挂端点都是禁止的。这是
 * 「卸载得干净」的唯一承重条件 —— 留一条旁路,卸载就不干净,而不干净的卸载比要求重启
 * 更难 debug(面板写着「已停用」,定时器还在跑)。
 */
export interface ExtensionContext {
	/** 它自己的 id —— 同时是挂载点、装载目录与记账键那一段。 */
	readonly id: string;
	/** 宿主契约的主版本。拓展自己也可能要按它分叉。 */
	readonly hostApiVersion: number;
	/** 每一行都自动带上 `[ext:<id>]` —— 日志里认得出是谁写的。 */
	readonly logger: Logger;
	/** 可回收定时器。卸载时宿主统一清,拓展自己漏了也不会留下幽灵。 */
	setTimeout(fn: () => void, ms: number): Disposable;
	setInterval(fn: () => void, ms: number): Disposable;
	/**
	 * 申请一条 HTTP 总入口,回宿主分配的前缀(如 `/ext/bridge`)。
	 *
	 * **拓展不该知道自己挂在哪**(决策 12):handler 收到的路径已经剥掉前缀,要拼绝对
	 * 地址时才用这个返回值。一个拓展只有一条总入口,再申请一次会抛。
	 */
	mount(handler: ExtensionFetchHandler): string;
	/** 卸载时要跑的收摊钩子。后注册的先跑。 */
	onDispose(fn: () => void | Promise<void>): void;
}

/** 宿主这边握着的把手 —— 拓展拿不到它,所以拓展没法把自己从卸载里摘出去。 */
export interface ExtensionRuntime {
	readonly ctx: ExtensionContext;
	/** 收回这个拓展注册过的一切。幂等。 */
	dispose(): Promise<void>;
}

export interface CreateExtensionContextOptions {
	id: string;
	/** 宿主的 ServiceContext —— 定时器与日志的真身。 */
	host: ServiceContext;
	mounts: ExtensionMounts;
	hostApiVersion?: number;
}

function prefixed(logger: Logger, id: string): Logger {
	const tag = `[ext:${id}]`;
	return {
		info: (msg, ...args) => logger.info(`${tag} ${msg}`, ...args),
		warn: (msg, ...args) => logger.warn(`${tag} ${msg}`, ...args),
		error: (msg, ...args) => logger.error(`${tag} ${msg}`, ...args),
		debug: (msg, ...args) => logger.debug(`${tag} ${msg}`, ...args),
	};
}

/** 已经卸载了还来注册的东西,给它一个什么都不做的把手。 */
const NOOP_DISPOSABLE: Disposable = { dispose() {} };

/**
 * 给一个拓展开一面 ctx,外加宿主收回它的那个把手。
 *
 * 注册进来的每一样都记在这一份名册上,`dispose()` 一次清空 —— 这就是「启用 / 停用热」
 * 做得到的原因(决策 10:热的是**副作用**,不是代码;代码换不掉,那要重启)。
 */
export function createExtensionContext(opts: CreateExtensionContextOptions): ExtensionRuntime {
	const { id, host, mounts } = opts;
	const logger = prefixed(host.logger, id);
	const registered = new Set<Disposable>();
	const hooks: Array<() => void | Promise<void>> = [];
	let disposed = false;

	/** 卸载之后还来注册 —— 不生效,但要留一行:那是拓展没收干净自己的异步尾巴。 */
	function refuse(what: string): Disposable {
		logger.warn(`已经卸载了,${what} 不再受理`);
		return NOOP_DISPOSABLE;
	}

	function track(inner: Disposable): Disposable {
		registered.add(inner);
		return {
			dispose() {
				registered.delete(inner);
				inner.dispose();
			},
		};
	}

	const ctx: ExtensionContext = {
		id,
		hostApiVersion: opts.hostApiVersion ?? EXTENSION_API_VERSION,
		logger,
		setTimeout: (fn, ms) => (disposed ? refuse("setTimeout") : track(host.setTimeout(fn, ms))),
		setInterval: (fn, ms) => (disposed ? refuse("setInterval") : track(host.setInterval(fn, ms))),
		mount(handler) {
			// 卸载之后还来挂:不进表(那才是幽灵端点),但前缀照答 —— 拓展要的只是一段字符串。
			if (disposed) {
				refuse("mount");
				return extensionMountPrefix(id);
			}
			const handle = mounts.mount(id, handler);
			registered.add(handle);
			return handle.prefix;
		},
		onDispose(fn) {
			if (disposed) {
				refuse("onDispose");
				return;
			}
			hooks.push(fn);
		},
	};

	return {
		ctx,
		async dispose() {
			if (disposed) return;
			disposed = true;
			// 先跑拓展自己的收摊钩子(它可能要用还活着的定时器 / 端点收尾),再拆机件。
			// 后注册的先跑 —— 后建起来的东西通常依赖先建起来的。
			for (const fn of [...hooks].reverse()) {
				try {
					await fn();
				} catch (err) {
					// 一个钩子抛了不许打断其余的回收:收一半的拓展是最难查的那种。
					logger.error(`收摊钩子抛了:${(err as Error).message}`);
				}
			}
			hooks.length = 0;
			for (const entry of registered) {
				try {
					entry.dispose();
				} catch (err) {
					logger.error(`回收注册项时抛了:${(err as Error).message}`);
				}
			}
			registered.clear();
		},
	};
}
