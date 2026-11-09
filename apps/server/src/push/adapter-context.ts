import type {
	Connection,
	Disposable,
	InboundHandlers,
	InboundMeta,
	IntegrationContext,
	PlatformAdapterContext,
} from "@bilibili-notify/internal";
import type { ZodType } from "zod";
import { logText, t } from "../i18n/index.js";
import {
	parseProblemReport,
	parseProblemResolve,
	problemCodePreview,
	problemRejectionReason,
} from "../problems/problem-report.js";
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

	/** 一条连接对这个适配器的归属:归我(原始连接一并交出来)、已经从原始表里删掉、还在表里但归别人。 */
	type ConnectionOwnership =
		| { kind: "mine"; connection: Connection }
		| { kind: "removed" }
		| { kind: "foreign" };

	/**
	 * 这条连接归不归这个适配器 —— **归属的唯一判法**,关于连接的上报、清与入站共用:按**原始连接表**看
	 * `adapterKey`,设置过不了规则、被隔离不交给适配器的连接仍算自己的。
	 *
	 * 「已经不在表里」与「在表里但归别人」分开交回:上报两种都拒(不能给一条不存在的连接记问题),
	 * 清只拒后者 —— 连接删了的时候宿主已经清过它名下的一切,再清是空操作。
	 */
	function ownershipOf(connectionId: string): ConnectionOwnership {
		const hit = opts.connection
			? opts.connection(connectionId)
			: opts.connections().find((c) => c.id === connectionId);
		if (hit === undefined) return { kind: "removed" };
		return hit.adapterKey === adapterKey ? { kind: "mine", connection: hit } : { kind: "foreign" };
	}

	/** 这个适配器停下了没有 —— 关于连接的上报与入站共用这一个判法:停下之后再来的一律丢。 */
	function stopped(): boolean {
		return integration.signal.aborted;
	}

	/** 形状不对的上报:记一行并按选项把原因交出去;`code` 用安全预览,不直接插第三方交来的值。 */
	function rejectProblem(operation: "report" | "resolve", report: unknown, issue: string): void {
		const code = problemCodePreview(report);
		integration.logger[opts.rejectedProblemLevel](logText("log.integration.problemInvalid"), {
			operation,
			code,
			adapterKey,
			issue,
		});
		opts.onRejectedProblem?.({ reason: problemRejectionReason(code, false, issue) });
	}

	/**
	 * 关于连接的上报 / 清的公共一步:已停下、连接不归我的丢弃并按选项记一行,过了关才叫 `apply`。
	 * 形状已经由解析那一步核过(`problems/problem-report.ts`),这里只管归属与「还活着吗」。
	 *
	 * `allowRemoved` 就是上报与清的唯一差别:清的时候连接已经从原始表里删掉也放行(空操作、幂等);
	 * 上报不给这一格 —— 给一条不存在的连接记问题没有意义,照旧拒。
	 */
	function acceptConnectionProblem(
		operation: "report" | "resolve",
		code: string,
		connectionId: string,
		allowRemoved: boolean,
		apply: () => void,
	): void {
		const ownership = ownershipOf(connectionId);
		const hasStopped = stopped();
		if (
			hasStopped ||
			ownership.kind === "foreign" ||
			(ownership.kind === "removed" && !allowRemoved)
		) {
			integration.logger[opts.rejectedProblemLevel](
				hasStopped
					? logText("log.integration.problemAfterStop")
					: logText("log.adapter.problemNotOwned"),
				{ operation, code, adapterKey, connectionId },
			);
			opts.onRejectedProblem?.({
				reason: hasStopped
					? problemRejectionReason(code, true)
					: problemRejectionReason(
							code,
							false,
							t("problem.report.connectionNotOwned", { connectionId, adapterKey }),
						),
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
		if (stopped()) {
			integration.logger.warn(logText("log.adapter.inboundStopped"), { route, adapterKey });
			return;
		}
		const ownership = ownershipOf(meta.connectionId);
		if (ownership.kind !== "mine") {
			integration.logger.warn(logText("log.adapter.inboundNotOwned"), {
				route,
				adapterKey,
				connectionId: meta.connectionId,
			});
			return;
		}
		deliver({
			connectionId: ownership.connection.id,
			platform: ownership.connection.platform,
		});
	}

	return {
		timezone: () => integration.timezone(),
		onTimezoneChanged: (fn) => integration.onTimezoneChanged(fn),
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
		reportProblem(problem) {
			const parsed = parseProblemReport(problem);
			if (!parsed.ok) {
				rejectProblem("report", problem, parsed.message);
				return;
			}
			if (parsed.connectionId === undefined) {
				integration.reportProblem({
					code: parsed.code,
					message: parsed.message,
					...(parsed.notify === undefined ? {} : { notify: parsed.notify }),
					...(parsed.recoveryMessage === undefined
						? {}
						: { recoveryMessage: parsed.recoveryMessage }),
				});
				return;
			}
			const connectionId = parsed.connectionId;
			acceptConnectionProblem("report", parsed.code, connectionId, false, () =>
				opts.problems.report({
					reporter: adapterKey,
					writtenBy: opts.label(),
					about: { connectionId },
					code: parsed.code,
					message: parsed.message,
					...(parsed.notify === undefined ? {} : { notify: parsed.notify }),
					...(parsed.recoveryMessage === undefined
						? {}
						: { recoveryMessage: parsed.recoveryMessage }),
				}),
			);
		},
		resolveProblem(problem) {
			const parsed = parseProblemResolve(problem);
			if (!parsed.ok) {
				rejectProblem("resolve", problem, parsed.message);
				return;
			}
			if (parsed.connectionId === undefined) {
				integration.resolveProblem({
					code: parsed.code,
					...(parsed.notify === undefined ? {} : { notify: parsed.notify }),
				});
				return;
			}
			const connectionId = parsed.connectionId;
			acceptConnectionProblem("resolve", parsed.code, connectionId, true, () =>
				opts.problems.resolve(
					{ reporter: adapterKey, about: { connectionId }, code: parsed.code },
					parsed.notify === undefined ? undefined : { notify: parsed.notify },
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
					integration.logger.warn(logText("log.adapter.connectionInvalid"), {
						connectionId: connection.id,
						connectionName: connection.name,
						adapterKey,
						reason,
					});
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
