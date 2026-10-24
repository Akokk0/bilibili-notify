import type {
	Connection,
	Disposable,
	InboundHandlers,
	InboundMeta,
	IntegrationContext,
	PlatformAdapterContext,
} from "@bilibili-notify/internal";
import type { ZodType } from "zod";
import { problemRejectionReason, problemReportIssue } from "../problems/problem-report.js";
import type { ProblemTable } from "../problems/problem-table.js";
import { resolveSettings, settingsIssueMessage } from "./connection-settings.js";

export interface CreatePlatformAdapterContextOptions {
	/** 这个适配器所属集成的上下文(内置的由装配处现建,拓展的用拓展自己那份)。 */
	integration: IntegrationContext;
	adapterKey: string;
	/** 这个适配器给人看的名字,报问题那一刻现取(拓展名随当前语言变)。 */
	label: () => string;
	/** 这个适配器的 settings 规则 —— `connections()` 递出去之前先按它解一遍。 */
	settingsSchema: ZodType;
	/** 全部连接,现读。 */
	connections: () => readonly Connection[];
	/**
	 * 按 id 取一条连接(原始的,不筛不解)。给了就走它:入站是每条消息一趟的热路径,全表那口每问一次
	 * 就深拷整张连接表,而校验归属只要那一条。不给就退回从全表里找。
	 */
	connection?: (connectionId: string) => Connection | undefined;
	/**
	 * 入站的下一层(指令分发、链接解析):适配器经 `ctx.inbound` 交来的消息,宿主核过归属、补上平台后
	 * 交给它。没接的那一路静默丢。
	 */
	inbound: InboundHandlers;
	/** 连接配置变了的订阅;交回的把手由调用方负责在集成停下时撤掉。 */
	onConnectionsChanged: (fn: () => void) => Disposable;
	/**
	 * 问题表的写口:关于连接的上报记在报的人(适配器键)名下、`about` 是那条连接。不带 `connectionId` 的上报
	 * 走集成层(`integration`),报的人是同一个键。
	 */
	problems: Pick<ProblemTable, "report" | "resolve">;
	/** 被拒的上报(连接不归我、形状不对、已停下)记成什么等级:内置 `error`,拓展 `warn`;同集成层那一格。 */
	rejectedProblemLevel: "warn" | "error";
	/** 问题上报被拒时,除了照 `rejectedProblemLevel` 记日志,再把给人看的原因交给它。 */
	onRejectedProblem?: (rejection: { externalId?: string; reason: string }) => void;
}

/**
 * 给一个适配器造它 `start` 时拿的上下文:集成上下文原样,加「归我的连接」(现读)与「变了叫我」。
 *
 * 「哪些连接归谁管」全仓只有 `adapterKey` 一个算法;内置与拓展两边共用这一个函数,免得写两遍。
 *
 * `connections()` 递出去的每一条,`settings` 都是按适配器的规则解过的输出;过不了规则的连接被隔离 ——
 * 不递给适配器,原因记一行 `warn`(同一条连接同一条原因只记一次;原因变了、或好了之后再坏,再记)。
 */
export function createPlatformAdapterContext(
	opts: CreatePlatformAdapterContextOptions,
): PlatformAdapterContext {
	const { integration, adapterKey, settingsSchema } = opts;
	/** 连接 id → 最近一次记过的隔离原因。 */
	const warned = new Map<string, string>();

	/**
	 * 这条连接是不是这个适配器的 —— 是的话把原始连接交出来。**归属的唯一判法**,关于连接的上报与入站
	 * 共用:按**原始连接表**看 `adapterKey`,设置过不了规则、被隔离不交给适配器的连接仍算自己的。
	 */
	function ownedConnection(connectionId: string): Connection | undefined {
		const hit = opts.connection
			? opts.connection(connectionId)
			: opts.connections().find((c) => c.id === connectionId);
		return hit && hit.adapterKey === adapterKey ? hit : undefined;
	}

	/** 这个适配器停下了没有 —— 关于连接的上报与入站共用这一个判法:停下之后再来的一律丢。 */
	function stopped(): boolean {
		return integration.signal.aborted;
	}

	/**
	 * 关于连接的上报的公共一步:已停下、形状不对、连接不归我的丢弃并按选项记一行,过了关才叫 `apply`。
	 */
	function acceptConnectionProblem(
		what: string,
		problem: { connectionId: string; code: string; message?: string; recoveryMessage?: string },
		apply: () => void,
	): void {
		const issue = stopped()
			? "适配器已停下"
			: (problemReportIssue(problem) ??
				(ownedConnection(problem.connectionId) !== undefined
					? undefined
					: `连接 ${problem.connectionId} 不是适配器 ${adapterKey} 的`));
		if (issue !== undefined) {
			integration.logger[opts.rejectedProblemLevel](
				`${what}问题 ${problem.code} 被拒(丢弃):${issue}`,
			);
			opts.onRejectedProblem?.({
				reason: problemRejectionReason(problem, stopped(), issue),
			});
			return;
		}
		apply();
	}

	/**
	 * 入站的公共一步:适配器已停下的丢掉并记一行(停下之后就该安静,不能再把消息递给指令分发);
	 * 归属不对的(冒充别人的连接、不存在的)同样丢掉并记一行 —— 放过去的话,一个适配器能替
	 * 别人的连接说话,而主人身份比对走的正是 `平台 + 地址 + bot` 三坐标。过了关,**平台取连接上那一格**
	 * (适配器自报的没有任何办法核,所以不收),补成完整的 `InboundMeta` 再交下一层。
	 */
	function feed(
		route: "private" | "group",
		meta: Pick<InboundMeta, "connectionId">,
		deliver: (meta: InboundMeta) => void,
	): void {
		const what = route === "private" ? "私聊" : "群";
		if (stopped()) {
			integration.logger.warn(`丢掉一条${what}消息:适配器 ${adapterKey} 已停下`);
			return;
		}
		const connection = ownedConnection(meta.connectionId);
		if (!connection) {
			integration.logger.warn(
				`丢掉一条${what}消息:连接 ${meta.connectionId} 不是适配器 ${adapterKey} 的`,
			);
			return;
		}
		deliver({ connectionId: connection.id, platform: connection.platform });
	}

	return {
		logger: integration.logger,
		signal: integration.signal,
		onDispose: integration.onDispose,
		state: integration.state,
		secrets: integration.secrets,
		redact: integration.redact,
		// 转发集成上下文那一份,不另造:一个集成只有一份 `settings` 实现(拓展的带对表与「设置读不了」)。
		settings: integration.settings,
		http: integration.http,
		fetchImage: integration.fetchImage,
		storeImage: integration.storeImage,
		reportProblem({ connectionId, ...problem }) {
			if (connectionId === undefined) {
				integration.reportProblem(problem);
				return;
			}
			acceptConnectionProblem("报", { connectionId, ...problem }, () =>
				opts.problems.report({
					reporter: adapterKey,
					writtenBy: opts.label(),
					about: { connectionId },
					code: problem.code,
					message: problem.message,
					...(problem.notify === undefined ? {} : { notify: problem.notify }),
					...(problem.recoveryMessage === undefined
						? {}
						: { recoveryMessage: problem.recoveryMessage }),
				}),
			);
		},
		resolveProblem({ connectionId, ...problem }) {
			if (connectionId === undefined) {
				integration.resolveProblem(problem);
				return;
			}
			acceptConnectionProblem("清", { connectionId, ...problem }, () =>
				opts.problems.resolve(
					{ reporter: adapterKey, about: { connectionId }, code: problem.code },
					problem.notify === undefined ? undefined : { notify: problem.notify },
				),
			);
		},
		connections: () => {
			const mine: Connection[] = [];
			const stillBroken = new Set<string>();
			for (const connection of opts.connections()) {
				if (connection.adapterKey !== adapterKey) continue;
				const resolved = resolveSettings(settingsSchema, connection.settings);
				if (resolved.ok) {
					mine.push({ ...connection, settings: resolved.settings });
					continue;
				}
				stillBroken.add(connection.id);
				const reason = settingsIssueMessage(resolved.issues ?? []);
				if (warned.get(connection.id) !== reason) {
					warned.set(connection.id, reason);
					integration.logger.warn(
						`[connection] 连接「${connection.name}」(${connection.id})${reason},先不交给适配器 ${adapterKey}`,
					);
				}
			}
			// 好了的、没了的:忘掉,下次再坏会再记一次。
			for (const id of [...warned.keys()]) if (!stillBroken.has(id)) warned.delete(id);
			return mine;
		},
		onConnectionsChanged: opts.onConnectionsChanged,
		inbound: {
			private: (msg, meta) =>
				feed("private", meta, (checked) => opts.inbound.private?.(msg, checked)),
			group: (msg, meta) => feed("group", meta, (checked) => opts.inbound.group?.(msg, checked)),
		},
	};
}
