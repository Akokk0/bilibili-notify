import type { Disposable, Logger, Problem } from "@bilibili-notify/internal";
import { errorMessageOf } from "../util/error-message.js";
import { createKeyedCoalescer } from "../util/keyed-coalescer.js";

/**
 * 问题表:各处报上来的「主人该知道的事」,全在内存,重启清空。
 *
 * - 同一个 (报的人, 关于谁, code) 只有一条:再报只换文案(与 `notify`),`since` 不动 —— 它是「第一次出现」。
 * - 每次变化当场叫订阅方(给问题通知器,它要看每一次);「面板该重取了」那一声 {@link CreateProblemTableOptions.onChanged}
 *   按报的人在尾沿合并,自己一个窗口。
 * - 报的人自己清({@link ProblemTable.resolve})可以让核心补一句「已恢复」;宿主在清
 *   ({@link ProblemTable.clearReporter}、{@link ProblemTable.clearSubscription})一律不补 —— 不是修好了,
 *   只是这件事不再适用。
 * - 表不校验形状:校验在各自的入口(来源上下文之类),核心直写的人不经那一层。
 */

/** 一条问题的变化。 */
export interface ProblemChange {
	kind: "opened" | "updated" | "closed";
	problem: Problem;
	/** opened / updated:报的人要不要私聊主人。closed:这次清掉要不要补「已恢复」。 */
	notify: boolean;
	/**
	 * 报的人给的「恢复时怎么说」(没给就没有这一格)。它不在 {@link Problem} 上:那是对外的形状,
	 * `GET /api/problems` 的回包不带它;只给问题通知器用。
	 */
	recoveryMessage?: string;
}

/** 一条问题的身份:同一个报的人、同一个对象、同一个 code。 */
export interface ProblemKey {
	reporter: string;
	about?: Problem["about"];
	code: string;
}

export interface ProblemTable {
	/**
	 * 同键已有就只换 message(与 notify、recoveryMessage),`since` 不动。`notify` 缺省不私聊。
	 * `recoveryMessage`:清掉且当初真私聊过时核心发的那一句;不给就用核心的通用说法。
	 */
	report(input: ProblemKey & { message: string; notify?: boolean; recoveryMessage?: string }): void;
	/** 报的人自己清。`notify: false` = 这次清掉不补「已恢复」。表里没有这一条就什么都不做。 */
	resolve(key: ProblemKey, options?: { notify?: boolean }): void;
	/** 报的人停下:它报的全清,不补「已恢复」。 */
	clearReporter(reporter: string): void;
	/** 订阅删了:关于它的全清(不看报的人),不补「已恢复」。 */
	clearSubscription(subscriptionId: string): void;
	/** 全部,按 `since` 先后。交出去的是拷贝。 */
	list(): readonly Problem[];
	/** 每次变化当场叫(不合并)。订阅方抛错只记一行,不影响表与别的订阅方。 */
	subscribe(fn: (change: ProblemChange) => void): Disposable;
	/** 关机:挂着的那几发「变了」不发了。 */
	dispose(): void;
}

/**
 * 「这个报的人名下的问题变了」按报的人合并的窗口:第一次变起算,窗口里再变的只在尾沿一起发**一次**,
 * 不因为又变了一次而往后推。
 */
export const PROBLEMS_CHANGED_COALESCE_MS = 250;

export interface CreateProblemTableOptions {
	logger: Logger;
	/** 这个报的人名下的问题变了(按报的人合并过,见 {@link PROBLEMS_CHANGED_COALESCE_MS})。 */
	onChanged?: (reporter: string) => void;
	now?: () => Date;
}

interface Entry {
	problem: Problem;
	notify: boolean;
	recoveryMessage?: string;
}

/** 变更里带不带 `recoveryMessage`:没有就不出现这一格。 */
function recoveryOf(entry: Entry): { recoveryMessage?: string } {
	return entry.recoveryMessage === undefined ? {} : { recoveryMessage: entry.recoveryMessage };
}

/** 一条问题在表里的键;问题通知器按同一个键记账。 */
export function problemKeyOf(key: ProblemKey): string {
	return JSON.stringify([key.reporter, key.about?.subscriptionId ?? null, key.code]);
}

export function createProblemTable(options: CreateProblemTableOptions): ProblemTable {
	const { logger } = options;
	const now = options.now ?? (() => new Date());
	/** 键 → 条目,按进表先后(`Map` 的插入序);`since` 也是按这个序单调的。 */
	const entries = new Map<string, Entry>();
	const listeners = new Set<(change: ProblemChange) => void>();
	/** 报的人 → 挂着的那一发「变了」。 */
	const changed = createKeyedCoalescer({
		windowMs: PROBLEMS_CHANGED_COALESCE_MS,
		onFire: (reporter) => options.onChanged?.(reporter),
		onError: (reporter, err) =>
			logger.warn(`[problems] 通知「问题变了」失败 reporter=${reporter}: ${errorMessageOf(err)}`),
	});

	function emit(change: ProblemChange): void {
		if (options.onChanged) changed.touch(change.problem.reporter);
		for (const fn of [...listeners]) {
			try {
				fn(change);
			} catch (err) {
				logger.warn(`[problems] 订阅方抛错,已忽略: ${errorMessageOf(err)}`);
			}
		}
	}

	function describe(problem: Problem): string {
		const about = problem.about ? ` subscription=${problem.about.subscriptionId}` : "";
		return `reporter=${problem.reporter}${about} code=${problem.code}`;
	}

	/** 宿主在清:挑出符合的那几条整条删掉,每条一个不补「已恢复」的 closed。 */
	function clearWhere(matches: (problem: Problem) => boolean): void {
		for (const [key, entry] of [...entries]) {
			if (!matches(entry.problem)) continue;
			entries.delete(key);
			logger.info(`[problems] 清掉(宿主) ${describe(entry.problem)}`);
			emit({ kind: "closed", problem: entry.problem, notify: false, ...recoveryOf(entry) });
		}
	}

	return {
		report(input) {
			const key = problemKeyOf(input);
			const notify = input.notify ?? false;
			const existing = entries.get(key);
			if (existing) {
				if (
					existing.problem.message === input.message &&
					existing.notify === notify &&
					existing.recoveryMessage === input.recoveryMessage
				) {
					return;
				}
				existing.problem = { ...existing.problem, message: input.message };
				existing.notify = notify;
				if (input.recoveryMessage === undefined) delete existing.recoveryMessage;
				else existing.recoveryMessage = input.recoveryMessage;
				logger.debug(`[problems] 换文案 ${describe(existing.problem)}: ${input.message}`);
				emit({ kind: "updated", problem: existing.problem, notify, ...recoveryOf(existing) });
				return;
			}
			const problem: Problem = {
				reporter: input.reporter,
				...(input.about ? { about: { subscriptionId: input.about.subscriptionId } } : {}),
				code: input.code,
				message: input.message,
				since: now().toISOString(),
			};
			const entry: Entry = {
				problem,
				notify,
				...(input.recoveryMessage === undefined ? {} : { recoveryMessage: input.recoveryMessage }),
			};
			entries.set(key, entry);
			logger.warn(`[problems] 开 ${describe(problem)}: ${input.message}`);
			emit({ kind: "opened", problem, notify, ...recoveryOf(entry) });
		},
		resolve(key, resolveOptions) {
			const id = problemKeyOf(key);
			const entry = entries.get(id);
			if (!entry) return;
			entries.delete(id);
			logger.info(`[problems] 清掉 ${describe(entry.problem)}`);
			emit({
				kind: "closed",
				problem: entry.problem,
				notify: resolveOptions?.notify ?? true,
				...recoveryOf(entry),
			});
		},
		clearReporter(reporter) {
			clearWhere((problem) => problem.reporter === reporter);
		},
		clearSubscription(subscriptionId) {
			clearWhere((problem) => problem.about?.subscriptionId === subscriptionId);
		},
		list() {
			return [...entries.values()].map(({ problem }) => ({
				...problem,
				...(problem.about ? { about: { ...problem.about } } : {}),
			}));
		},
		subscribe(fn) {
			listeners.add(fn);
			return { dispose: () => void listeners.delete(fn) };
		},
		dispose() {
			changed.dispose();
		},
	};
}
