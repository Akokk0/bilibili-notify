import type {
	Disposable,
	IntegrationContext,
	KeyValueStore,
	Logger,
} from "@bilibili-notify/internal";
import { type ProblemReport, problemReportIssue } from "../problems/problem-report.js";
import type { ProblemTable } from "../problems/problem-table.js";

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
	/** 集成自己的那个 logger:按它的集成键要来的,行的标签与等级都跟这个键(拓展传 `loggerOf(id)` 要来的)。 */
	logger: Logger;
	/** `signal` 中止时带的原因(`DOMException(这句话, "AbortError")`)。 */
	stopReason: string;
	/**
	 * 这个集成的两份小存储,原样放进 `ctx`。`integrations/` 自己不碰盘、不认识宿主:谁开的存储谁传进来、
	 * 谁负责在上下文收摊之后关把手。
	 */
	state: KeyValueStore;
	secrets: KeyValueStore;
	/** 问题表的写口:这个集成报的问题记在 `reporter` 名下,收摊时它名下的全清(不补「已恢复」)。 */
	problems: Pick<ProblemTable, "report" | "resolve" | "clearReporter">;
	/** 报的人:这个集成的键(内置的是集成键,拓展是拓展 id)。 */
	reporter: string;
	/**
	 * 上报被拒(已停下、形状不对)记成什么等级:内置集成被拒就是 BN 的 bug,记 `error`;
	 * 拓展被拒是拓展自己的 bug、BN 改不了,记 `warn`(ADR-0025 决策 10)。
	 */
	rejectedProblemLevel: "warn" | "error";
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

	/**
	 * 问题上报的公共一步:已停下、形状不对的丢弃并按选项记一行;过了关就叫 `apply`。
	 * 校验规矩与来源层共用一份(`problems/problem-report.ts`)。
	 */
	function acceptProblem(what: string, problem: ProblemReport, apply: () => void): void {
		const issue = disposed ? "集成已停下" : problemReportIssue(problem);
		if (issue !== undefined) {
			logger[opts.rejectedProblemLevel](`${what}问题 ${problem.code} 被拒(丢弃):${issue}`);
			return;
		}
		apply();
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
		reportProblem(problem) {
			acceptProblem("报", problem, () =>
				opts.problems.report({
					reporter: opts.reporter,
					code: problem.code,
					message: problem.message,
					...(problem.notify === undefined ? {} : { notify: problem.notify }),
					...(problem.recoveryMessage === undefined
						? {}
						: { recoveryMessage: problem.recoveryMessage }),
				}),
			);
		},
		resolveProblem(problem) {
			acceptProblem("清", problem, () =>
				opts.problems.resolve(
					{ reporter: opts.reporter, code: problem.code },
					problem.notify === undefined ? undefined : { notify: problem.notify },
				),
			);
		},
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
			// 它名下的问题随停下清掉(宿主清,不补「已恢复」)。放在 `disposed = true` 之后紧接着做:
			// 之后的上报一律被拒,清了就是清了 —— 调用方(装载器)要在收摊之后再记这个报的人名下的新问题,
			// 必须排在 `dispose()` 回来之后,否则刚记的会被这一下清走。
			opts.problems.clearReporter(opts.reporter);
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
