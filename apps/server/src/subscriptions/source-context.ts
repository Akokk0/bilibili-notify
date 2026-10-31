import type {
	CreatorProfileReport,
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
	Result,
	SourceContext,
	SourceDescriptor,
} from "@bilibili-notify/internal";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import type { AiToolProviderRegistry } from "../ai/tool-provider-registry.js";
import type { LinkResolverRegistry } from "../link-preview/registry.js";
import {
	parseProblemReport,
	parseProblemResolve,
	problemCodePreview,
	problemRejectionReason,
} from "../problems/problem-report.js";
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
	/**
	 * 资料的入口(`createProfileReportHandler(...).report`):`reportProfile` 按身份展开、只取**启用中**的订阅后,
	 * 把订阅 id 列表连同整份上报交到这里一次(不是每条订阅一份 —— 资料缓存的写排成一条队,一批一起过)。
	 * 停用的订阅不收资料,所以交到这里的 id 一定非空、都启用着。
	 */
	profiles: (subscriptionIds: readonly string[], report: CreatorProfileReport) => void;
	/** 问题表的写口:来源报的问题记在报的人(这个来源的键)名下。 */
	problems: Pick<ProblemTable, "report" | "resolve">;
	/** 链接解析器的登记表:来源经 `ctx.registerLinkResolver` 登,键用这个来源的键;停下时随上下文撤掉。 */
	linkResolvers: Pick<LinkResolverRegistry, "register">;
	/** AI 工具提供方的登记表:来源经 `ctx.registerAiToolProvider` 登,键用这个来源的键;停下时随上下文撤掉。 */
	aiToolProviders: Pick<AiToolProviderRegistry, "register">;
	/**
	 * 被拒的问题上报(已停下、形状不对)记成什么等级:内置来源被拒就是 BN 的 bug,记 `error`(缺省);拓展的来源
	 * 被拒是拓展自己的 bug、BN 改不了,记 `warn`。同集成层与推送适配器上下文的那一格。
	 */
	rejectedProblemLevel?: "warn" | "error";
	/** 问题上报被拒时,除了照 `rejectedProblemLevel` 记日志,再带上外部 id 与给人看的原因交给它。 */
	onRejectedProblem?: (rejection: { externalId?: string; reason: string }) => void;
	/**
	 * 报问题时写进问题表的「写者名」,报那一刻现取(随当前语言变)。拓展的来源给它的清单名(与拓展列表同一条回落链);
	 * 不给取描述符的 `label`(B 站的「B 站」)。同集成上下文与推送适配器上下文的同名选项。
	 */
	label?: () => string;
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
	// 被拒的问题上报记成什么等级(内置缺省 error,拓展 warn)。名字叫 `log`:字符串写在日志调用里,不算写死的中文。
	const log = (message: string): void =>
		opts.rejectedProblemLevel === "warn" ? logger.warn(message) : logger.error(message);

	/** 被拒的上报里带的 externalId:只认字符串 —— 第三方交来的可能是别的,原样交给 `onRejectedProblem` 没有意义。 */
	function externalIdOf(report: unknown): { externalId?: string } {
		if (typeof report !== "object" || report === null) return {};
		const value = (report as { externalId?: unknown }).externalId;
		return typeof value === "string" ? { externalId: value } : {};
	}

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
	 * 问题上报的公共一步:已停下、形状不对的丢弃并按 `rejectedProblemLevel` 记日志(内置来源被拒就是 BN 的 bug,
	 * 缺省记 error);
	 * 不带 `externalId` 交一个「来源自己」的对象,带了按身份展开成这个人名下的每一条订阅
	 * (遗留的同身份重复订阅各算一条;一条都没有就什么都不做)。
	 * 上报先经 `problems/problem-report.ts` 解析成干净副本,问题表只写副本里的那几格。
	 */
	const forEachProblemObject = <T extends { externalId?: string; code: string }>(
		what: string,
		report: unknown,
		parse: (raw: unknown) => Result<T>,
		visit: (problem: T, about: { subscriptionId: string } | undefined) => void,
	): void => {
		const code = problemCodePreview(report);
		if (disposed) {
			log(`[source] ${sourceKey} 已停下还在${what}问题 ${code}(丢弃;来源的 bug)`);
			opts.onRejectedProblem?.({
				...externalIdOf(report),
				reason: problemRejectionReason(code, true),
			});
			return;
		}
		const problem = parse(report);
		if (!problem.ok) {
			log(
				`[source] ${sourceKey} ${what}问题的形状不对(丢弃;来源的 bug): ${code}(${problem.message})`,
			);
			opts.onRejectedProblem?.({
				...externalIdOf(report),
				reason: problemRejectionReason(code, false, problem.message),
			});
			return;
		}
		if (problem.externalId === undefined) {
			visit(problem, undefined);
			return;
		}
		const subs = opts.subscriptions.listByIdentity({
			sourceKey,
			externalId: problem.externalId,
		});
		if (subs.length === 0) {
			logger.debug(
				`[source] ${sourceKey}:${problem.externalId} 没有订阅,${what}的问题 ${problem.code} 不收`,
			);
			return;
		}
		// 停用着的订阅照记,不在这里筛。
		for (const sub of subs) visit(problem, { subscriptionId: sub.id });
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
		timezone: () => integration.timezone(),
		onTimezoneChanged(fn) {
			if (disposed) return { dispose() {} };
			const watch = integration.onTimezoneChanged(() => {
				if (!disposed) return fn();
			});
			watches.push(watch);
			return watch;
		},
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
		reportProfile(externalId: string, report: CreatorProfileReport) {
			if (disposed) {
				logger.error(`[source] ${sourceKey} 已停下还在上报资料 ${externalId}(丢弃;内置来源的 bug)`);
				return;
			}
			// 停用的订阅不收资料(契约:停用的不收);重新启用后等下一轮资料刷新或下一次上报补上。
			const ids = opts.subscriptions
				.listByIdentity({ sourceKey, externalId })
				.filter((sub) => sub.enabled)
				.map((sub) => sub.id);
			if (ids.length === 0) {
				logger.debug(`[source] ${sourceKey}:${externalId} 没有启用中的订阅,资料不收`);
				return;
			}
			opts.profiles(ids, report);
		},
		reportProblem(problem) {
			forEachProblemObject("报", problem, parseProblemReport, (report, about) =>
				opts.problems.report({
					reporter: sourceKey,
					writtenBy: opts.label?.() ?? descriptor.label,
					...(about ? { about } : {}),
					code: report.code,
					message: report.message,
					...(report.notify === undefined ? {} : { notify: report.notify }),
					...(report.recoveryMessage === undefined
						? {}
						: { recoveryMessage: report.recoveryMessage }),
				}),
			);
		},
		resolveProblem(problem) {
			forEachProblemObject("清", problem, parseProblemResolve, (report, about) =>
				opts.problems.resolve(
					{ reporter: sourceKey, ...(about ? { about } : {}), code: report.code },
					report.notify === undefined ? undefined : { notify: report.notify },
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
		registerAiToolProvider(provider) {
			if (disposed) {
				logger.error(`[source] ${sourceKey} 已停下还在登记 AI 工具提供方(丢弃;内置来源的 bug)`);
				return { dispose() {} };
			}
			// 键与工具名撞了由登记表抛,原样出去。
			const claim = opts.aiToolProviders.register(sourceKey, provider);
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
