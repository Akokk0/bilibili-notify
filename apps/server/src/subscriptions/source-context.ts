import type {
	Disposable,
	GlobalConfig,
	IntegrationContext,
	Logger,
	MessageBus,
	PostEvent,
	PostReport,
	SourceContext,
	SourceDescriptor,
} from "@bilibili-notify/internal";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import type { ProblemTable } from "../problems/problem-table.js";
import { errorMessageOf } from "../util/error-message.js";
import { sourceSubscriptionViews } from "./source-subscriptions.js";

export interface CreateSourceContextOptions {
	/** 这个来源所属集成的上下文(B 站的由登录那套代码建好,这里原样用,不另开存储)。 */
	integration: IntegrationContext;
	sourceKey: string;
	descriptor: SourceDescriptor;
	subscriptions: Pick<SubscriptionStore, "list" | "listByIdentity">;
	/** 全局默认,现读(折特性开关用)。 */
	defaults: () => GlobalConfig["defaults"];
	bus: Pick<MessageBus, "on">;
	logger: Logger;
	/** 作品入口(`PostQueue.enqueue`)。 */
	enqueue: (event: PostEvent) => void;
	/** 问题表的写口:来源报的问题记在报的人(这个来源的键)名下。 */
	problems: Pick<ProblemTable, "report" | "resolve">;
}

/** 问题的 code:snake 风格,小写字母开头。 */
const PROBLEM_CODE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

export interface SourceContextHandle {
	readonly ctx: SourceContext;
	/** 来源停下之后叫:之后的上报一律丢,名单回调不再叫,总线上的两处监听摘掉。幂等。 */
	dispose(): void;
}

/**
 * 给一个来源造它 `start` 时拿的上下文:集成上下文的公共五格,加名单(现算)、「名单可能变了」的通知、交作品。
 *
 * 名单变动的两路触发(订阅变了、全局设置变了)都只说「可能变了」,宿主不替来源去重 ——
 * 宿主去重要自己维护一份名单的指纹,指纹漏一维就是静默不通知。
 */
export function createSourceContext(opts: CreateSourceContextOptions): SourceContextHandle {
	const { integration, sourceKey, descriptor, logger } = opts;
	const listeners = new Set<() => void>();
	let disposed = false;

	const notify = (): void => {
		for (const fn of [...listeners]) {
			// 总线是普通发射器,一个回调同步抛了会跳过排在后面的监听:每个回调单独接。
			try {
				fn();
			} catch (err) {
				logger.error(`[source] ${sourceKey} 的名单回调抛错(忽略): ${errorMessageOf(err)}`);
			}
		}
	};

	/**
	 * 问题上报的公共一步:已停下、形状不对的丢弃并记 error(内置来源被拒就是 BN 的 bug);
	 * 不带 `externalId` 交一个「来源自己」的对象,带了按身份展开成这个人名下的每一条订阅
	 * (遗留的同身份重复订阅各算一条;一条都没有就什么都不做)。
	 */
	const forEachProblemObject = (
		what: string,
		problem: { externalId?: string; code: string; message?: string; recoveryMessage?: string },
		visit: (about: { subscriptionId: string } | undefined) => void,
	): void => {
		if (disposed) {
			logger.error(
				`[source] ${sourceKey} 已停下还在${what}问题 ${problem.code}(丢弃;内置来源的 bug)`,
			);
			return;
		}
		if (
			!PROBLEM_CODE.test(problem.code) ||
			problem.externalId === "" ||
			(problem.message !== undefined && problem.message.trim() === "") ||
			(problem.recoveryMessage !== undefined && problem.recoveryMessage.trim() === "")
		) {
			logger.error(
				`[source] ${sourceKey} ${what}问题的形状不对(丢弃;内置来源的 bug): ${problem.code}`,
			);
			return;
		}
		if (problem.externalId === undefined) {
			visit(undefined);
			return;
		}
		const subs = opts.subscriptions.listByIdentity({ sourceKey, externalId: problem.externalId });
		if (subs.length === 0) {
			logger.debug(
				`[source] ${sourceKey}:${problem.externalId} 没有订阅,${what}的问题 ${problem.code} 不收`,
			);
			return;
		}
		// 停用着的订阅照记,不在这里筛。
		for (const sub of subs) visit({ subscriptionId: sub.id });
	};

	const watches: Disposable[] = [
		opts.bus.on("subscription-changed", notify),
		opts.bus.on("config-changed", ({ scope }) => {
			if (scope === "globals") notify();
		}),
	];

	// 🔴 逐格列出公共那五个成员,不许展开 `integration`:B 站交进来的对象运行时带着 `http` 与 `cookies`,
	// 类型收窄挡不住展开把它们原样抄进来。
	const ctx: SourceContext = {
		logger,
		signal: integration.signal,
		onDispose: integration.onDispose,
		state: integration.state,
		secrets: integration.secrets,
		subscriptions: () =>
			sourceSubscriptionViews(opts.subscriptions.list(), sourceKey, opts.defaults()),
		onSubscriptionsChanged(fn) {
			if (disposed) return { dispose() {} };
			listeners.add(fn);
			return {
				dispose() {
					listeners.delete(fn);
				},
			};
		},
		reportPost(externalId: string, report: PostReport) {
			if (disposed) {
				logger.error(
					`[source] ${sourceKey} 已停下还在上报作品 ${report.postId}(丢弃;内置来源的 bug)`,
				);
				return;
			}
			const identity = { sourceKey, externalId };
			const subs = opts.subscriptions.listByIdentity(identity);
			if (subs.length === 0) {
				logger.debug(`[source] ${sourceKey}:${externalId} 没有订阅,作品 ${report.postId} 不收`);
				return;
			}
			// 停用的、作品开关关着的不在这里筛:作品入口按订阅现折设置,不该推的由它丢。
			for (const sub of subs) {
				opts.enqueue({
					subscriptionId: sub.id,
					identity,
					postId: report.postId,
					url: report.url,
					post: report.post,
					postNoun: descriptor.postNoun,
				});
			}
		},
		reportProblem(problem) {
			forEachProblemObject("报", problem, (about) =>
				opts.problems.report({
					reporter: sourceKey,
					...(about ? { about } : {}),
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
			forEachProblemObject("清", problem, (about) =>
				opts.problems.resolve(
					{ reporter: sourceKey, ...(about ? { about } : {}), code: problem.code },
					problem.notify === undefined ? undefined : { notify: problem.notify },
				),
			);
		},
	};

	return {
		ctx,
		dispose() {
			if (disposed) return;
			disposed = true;
			listeners.clear();
			for (const watch of watches) watch.dispose();
		},
	};
}
