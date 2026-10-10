import type {
	Disposable,
	IntegrationContext,
	KeyValueStore,
	Logger,
} from "@bilibili-notify/internal";

/**
 * 收摊钩子(`ctx.onDispose`)一共最多等多久。收摊排在装载器那条队里:一个钩子挂住,之后的开关、
 * 装包、只重载全卡在它后面,关机也关不下去(ADR-0019 决策 45)。
 */
export const DISPOSE_TIMEOUT_MS = 30_000;

/** 宿主握着的那一面,集成拿不到。 */
export interface IntegrationContextHandle {
	readonly ctx: IntegrationContext;
	/** 已经开始收尾了(`dispose()` 一进门就是 true)。 */
	readonly disposed: boolean;
	/**
	 * 把一样注册项记进名册;交回的把手撤掉它并从名册里摘除。
	 * 已经收尾了还来登记的:当场撤掉它、记一行 warn,交回一个什么都不做的把手 —— 名册早清空了,
	 * 收尾不会再跑,记进去的话这一项永远撤不掉。
	 */
	track(inner: Disposable): Disposable;
	/** 停下之后还来注册:记一行 warn,交回一个什么都不做的把手。 */
	refuse(what: string): Disposable;
	/** 收尾,幂等。 */
	dispose(): Promise<void>;
}

export interface CreateIntegrationContextOptions {
	/** 已经带好前缀的那个 logger(拓展传 `prefixed(host.logger, id)`)。 */
	logger: Logger;
	/** `signal` 中止时带的原因(`DOMException(这句话, "AbortError")`)。 */
	stopReason: string;
	/**
	 * 这个集成的两份小存储,原样放进 `ctx`。`integrations/` 自己不碰盘、不认识宿主:谁开的存储谁传进来、
	 * 谁负责在上下文收摊之后关把手。
	 */
	state: KeyValueStore;
	secrets: KeyValueStore;
	/** 收尾钩子一共最多等多久;不给就是 `DISPOSE_TIMEOUT_MS`。 */
	disposeTimeoutMs?: number;
	/** 开始收尾的那一刻、`signal` 中止之前叫一次;抛了记一行 error,不打断收尾。 */
	onStopping?: () => void;
}

/** 已经卸载了还来注册的东西,给它一个什么都不做的把手。 */
const NOOP_DISPOSABLE: Disposable = { dispose() {} };

/**
 * 给一个集成开一面上下文,外加宿主收回它的那个把手。
 *
 * 注册进来的每一样都记在这一份名册上,`dispose()` 一次清空 —— 这就是「启用 / 停用热」
 * 做得到的原因(决策 10:热的是**副作用**,不是代码;代码换不掉,那要重启)。
 */
export function createIntegrationContext(
	opts: CreateIntegrationContextOptions,
): IntegrationContextHandle {
	const { logger } = opts;
	const registered = new Set<Disposable>();
	const hooks: Array<() => void | Promise<void>> = [];
	const controller = new AbortController();
	let disposed = false;

	/** 卸载之后还来注册 —— 不生效,但要留一行:那是调用方没收干净自己的异步尾巴。 */
	function refuse(what: string): Disposable {
		logger.warn(`已经卸载了,${what} 不再受理`);
		return NOOP_DISPOSABLE;
	}

	function track(inner: Disposable): Disposable {
		if (disposed) {
			// 名册早清空了、`dispose()` 幂等不会再跑:记进去就永远撤不掉,所以当场撤。
			logger.warn("已经卸载了,又来登记的一项当场撤掉");
			try {
				inner.dispose();
			} catch (err) {
				logger.error(`回收注册项时抛了:${(err as Error).message}`);
			}
			return NOOP_DISPOSABLE;
		}
		registered.add(inner);
		return {
			dispose() {
				registered.delete(inner);
				inner.dispose();
			},
		};
	}

	const ctx: IntegrationContext = {
		logger,
		signal: controller.signal,
		onDispose(fn) {
			if (disposed) {
				refuse("onDispose");
				return;
			}
			hooks.push(fn);
		},
		state: opts.state,
		secrets: opts.secrets,
	};

	return {
		ctx,
		get disposed() {
			return disposed;
		},
		track,
		refuse,
		async dispose() {
			if (disposed) return;
			disposed = true;
			// 宿主那头抛了不许打断收摊。
			try {
				opts.onStopping?.();
			} catch (err) {
				logger.error(`收摊开始的通知抛了:${(err as Error).message}`);
			}
			// 🔴 在跑的东西先叫停,再跑收摊钩子 —— 钩子里能等它们收尾;不叫停的话,集成都停了,
			// 它的 handler 还在背后接着轮询平台。
			controller.abort(new DOMException(opts.stopReason, "AbortError"));
			// 先跑自己的收摊钩子(它可能要用还活着的定时器 / 端点收尾),再拆机件。
			// 后注册的先跑 —— 后建起来的东西通常依赖先建起来的。
			const pending = [...hooks].reverse();
			hooks.length = 0;
			let overdue = false;
			const hooksDone = (async () => {
				for (const fn of pending) {
					// 过了时限就不再往下跑:机件已经拆了,后面的钩子多半要用的正是它们。
					if (overdue) return;
					try {
						await fn();
					} catch (err) {
						// 一个钩子抛了不许打断其余的回收:收一半的集成是最难查的那种。
						logger.error(`收摊钩子抛了:${(err as Error).message}`);
					}
				}
			})();
			// 🔴 钩子挂住不许把收摊一起挂住:收摊排在装载器那条队里,等它就是整条队陪着等。
			// 过了时限按已收摊处理 —— 下面拆机件那一段照走,半个集成不留。
			const limit = opts.disposeTimeoutMs ?? DISPOSE_TIMEOUT_MS;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const deadline = new Promise<"overdue">((resolve) => {
				timer = setTimeout(() => resolve("overdue"), limit);
			});
			try {
				if ((await Promise.race([hooksDone, deadline])) === "overdue") {
					overdue = true;
					logger.warn(`收摊钩子 ${limit / 1000} 秒没跑完 —— 按已收摊处理,排在它后面的钩子不再跑`);
				}
			} finally {
				clearTimeout(timer);
			}
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
