import type {
	Disposable,
	GlobalConfig,
	IntegrationContext,
	LiveInteractionReport,
	LiveSignal,
	LiveSignalReport,
	Logger,
	MessageBus,
	PostEvent,
	PostReport,
	SourceContext,
	SourceDescriptor,
} from "@bilibili-notify/internal";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import type { LinkResolverRegistry } from "../link-preview/registry.js";
import { problemReportIssue } from "../problems/problem-report.js";
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
	/** 直播信号的入口(`LiveSessionEngine.apply`):`reportLive` 按身份展开后,每条订阅一份交到这里。 */
	liveSignals: (signal: LiveSignal) => void;
	/** 直播互动的入口(`LiveInteractions.apply`):`reportLiveInteraction` 按身份展开后,每条订阅一份(订阅 id + 上报)交到这里。 */
	liveInteractions: (subscriptionId: string, report: LiveInteractionReport) => void;
	/** 问题表的写口:来源报的问题记在报的人(这个来源的键)名下。 */
	problems: Pick<ProblemTable, "report" | "resolve">;
	/** 链接解析器的登记表:来源经 `ctx.registerLinkResolver` 登,键用这个来源的键;停下时随上下文撤掉。 */
	linkResolvers: Pick<LinkResolverRegistry, "register">;
}

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
		const issue = problemReportIssue(problem);
		if (issue !== undefined) {
			logger.error(
				`[source] ${sourceKey} ${what}问题的形状不对(丢弃;内置来源的 bug): ${problem.code}(${issue})`,
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

	// 🔴 逐格列出公共那几个成员(不含问题上报,那一对下面按来源的规矩自己造),不许展开 `integration`:B 站交进来的对象运行时带着 `cookies`,
	// 类型收窄挡不住展开把它原样抄进来(罐子的口对来源不开)。
	const ctx: SourceContext = {
		logger,
		signal: integration.signal,
		onDispose: integration.onDispose,
		state: integration.state,
		secrets: integration.secrets,
		redact: integration.redact,
		// 读手本身属于集成上下文(一个集成一份实现);来源这一层只转发,并把来源订阅的 `onChange` 记在自己名下,
		// 来源停下就摘 —— 不指望来源在 `stop()` 里记得收(集成的上下文比来源活得久)。
		settings(schema) {
			const reader = integration.settings(schema);
			return {
				get: () => reader.get(),
				onChange(fn) {
					// 上下文已收掉才来订阅:不订,交一个什么都不做的把手。
					if (disposed) return { dispose() {} };
					const subscription = reader.onChange(fn);
					watches.push(subscription);
					return subscription;
				},
			};
		},
		http: integration.http,
		fetchImage: integration.fetchImage,
		storeImage: integration.storeImage,
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
		reportLive(externalId: string, report: LiveSignalReport) {
			if (disposed) {
				logger.error(
					`[source] ${sourceKey} 已停下还在上报直播 ${report.kind}(丢弃;内置来源的 bug)`,
				);
				return;
			}
			// 形状核:时刻能解析、下播必带 endedAt。内置来源交了坏形状就是 BN 的 bug,丢弃并记 error。
			const unparsable = (value: string | undefined): boolean =>
				value !== undefined && Number.isNaN(Date.parse(value));
			if (unparsable(report.startedAt)) {
				logger.error(
					`[source] ${sourceKey} 上报直播 ${report.kind} 的 startedAt 不是时刻(丢弃;内置来源的 bug): ${report.startedAt}`,
				);
				return;
			}
			if (
				report.kind === "end" &&
				(typeof report.endedAt !== "string" || unparsable(report.endedAt))
			) {
				logger.error(
					`[source] ${sourceKey} 上报直播下播的 endedAt 缺失或不是时刻(丢弃;内置来源的 bug): ${String(report.endedAt)}`,
				);
				return;
			}
			const identity = { sourceKey, externalId };
			const subs = opts.subscriptions.listByIdentity(identity);
			if (subs.length === 0) {
				logger.debug(`[source] ${sourceKey}:${externalId} 没有订阅,直播 ${report.kind} 不收`);
				return;
			}
			// 停用的不在这里筛:场次引擎按订阅现判该不该记。
			for (const sub of subs) {
				opts.liveSignals({ ...report, subscriptionId: sub.id, identity });
			}
		},
		reportLiveInteraction(externalId: string, report: LiveInteractionReport) {
			if (disposed) {
				logger.error(
					`[source] ${sourceKey} 已停下还在上报直播互动 ${report.kind}(丢弃;内置来源的 bug)`,
				);
				return;
			}
			const subs = opts.subscriptions.listByIdentity({ sourceKey, externalId });
			if (subs.length === 0) {
				logger.debug(`[source] ${sourceKey}:${externalId} 没有订阅,直播互动 ${report.kind} 不收`);
				return;
			}
			// 停用的不在这里筛:互动入口按订阅现折设置、现看订阅还该不该推。
			for (const sub of subs) opts.liveInteractions(sub.id, report);
		},
		reportProblem(problem) {
			forEachProblemObject("报", problem, (about) =>
				opts.problems.report({
					reporter: sourceKey,
					writtenBy: descriptor.label,
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
		registerLinkResolver(resolver) {
			if (disposed) {
				logger.error(`[source] ${sourceKey} 已停下还在登记链接解析器(丢弃;内置来源的 bug)`);
				return { dispose() {} };
			}
			// 键被占(含这个来源自己已经登过一个)时由登记表抛,原样出去。
			const claim = opts.linkResolvers.register(sourceKey, resolver);
			// 跟着上下文一起摘:不指望来源在 `stop()` 里记得收。把手自己撤过的再摘是空操作。
			watches.push(claim);
			return claim;
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
