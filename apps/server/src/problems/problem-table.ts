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
 *   ({@link ProblemTable.clearReporter}、{@link ProblemTable.clearSubscription}、
 *   {@link ProblemTable.clearConnection})一律不补 —— 不是修好了,
 *   只是这件事不再适用。
 * - **换语言**:建表时给了 {@link CreateProblemTableOptions.texts} 的话,语言或口吻一变就把各条交来的
 *   取字函数重跑一遍:字变了只换文案并带 `reworded`,`notify` 与 `since` 不动;字没变不发;函数抛了留旧字、
 *   记一行 warn。交字符串的条目不经函数,按「当前语言与这条上次出字时的语言不同」认作换说法(给集成自己
 *   重报用)。同键再报(包括什么都没变的那次)也把这一格更新成当前语言。
 *   已知的缺口:语言换过之后,同一条的第一次再报一律算「换说法」—— 集成即使没重报,之后真换一句别的话
 *   也会被当成只换了说法。
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
	/**
	 * 这句话是哪个集成写的(给人看的名字);没有这一格就是宿主自己写的整句。它不在 {@link Problem} 上:
	 * 那是对外的形状,`GET /api/problems` 的回包不带它;只给问题通知器在私聊时加引子用。
	 */
	writtenBy?: string;
	/** 只有 `updated` 会带:这次只是换了说法(换语言或口吻),不是换了一件别的事。 */
	reworded?: true;
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
	 * `message` / `recoveryMessage` 交字符串就照用;交函数就由表存下,当场跑一次得出今天的字,之后
	 * 语言或口吻变了再重跑(见文件头「换语言」)。
	 * `recoveryMessage`:清掉且当初真私聊过时核心发的那一句;不给就用核心的通用说法。
	 * `writtenBy`:这句话是哪个集成写的(给人看的名字);不给就是宿主自己写的整句。
	 */
	report(
		input: ProblemKey & {
			message: string | (() => string);
			notify?: boolean;
			recoveryMessage?: string | (() => string);
			writtenBy?: string;
		},
	): void;
	/** 报的人自己清。`notify: false` = 这次清掉不补「已恢复」。表里没有这一条就什么都不做。 */
	resolve(key: ProblemKey, options?: { notify?: boolean }): void;
	/** 报的人停下:它报的全清,不补「已恢复」。 */
	clearReporter(reporter: string): void;
	/** 订阅删了:关于它的全清(不看报的人),不补「已恢复」。 */
	clearSubscription(subscriptionId: string): void;
	/** 连接删了:关于它的全清(不看报的人),不补「已恢复」。 */
	clearConnection(connectionId: string): void;
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
	/**
	 * 当前语言与口吻的读口。给了就跟着换语言:语言**或**口吻一变,把存着取字函数的条目重跑一遍
	 * (见文件头「换语言」)。与 `LocaleReader` 不同 —— 那个只在语言真的变了时叫。
	 */
	texts?: { locale(): string; onChange(fn: () => void): Disposable };
}

interface Entry {
	problem: Problem;
	notify: boolean;
	recoveryMessage?: string;
	/** 恢复句的取字函数(交的是函数时才有)。 */
	recoveryText?: () => string;
	/** 问题句的取字函数(交的是函数时才有)。 */
	messageText?: () => string;
	writtenBy?: string;
	/** 这条最近一次出字(或重跑取字函数)时的语言;`texts` 没给时没有这一格。 */
	locale?: string;
}

/** 交字符串就照用,交函数就当场跑一次。 */
function textOf(value: string | (() => string)): string {
	return typeof value === "function" ? value() : value;
}

/** 变更里带不带 `recoveryMessage`:没有就不出现这一格。 */
function recoveryOf(entry: Entry): { recoveryMessage?: string } {
	return entry.recoveryMessage === undefined ? {} : { recoveryMessage: entry.recoveryMessage };
}

/** 变更里带不带 `writtenBy`:没有就不出现这一格。 */
function writtenByOf(entry: Entry): { writtenBy?: string } {
	return entry.writtenBy === undefined ? {} : { writtenBy: entry.writtenBy };
}

/** 一条问题在表里的键;问题通知器按同一个键记账。 */
export function problemKeyOf(key: ProblemKey): string {
	// 订阅 id 与连接 id 是两个命名空间:键里带上是哪一支,撞了同一串也是两条。
	const about = !key.about
		? null
		: "subscriptionId" in key.about
			? ["subscription", key.about.subscriptionId]
			: ["connection", key.about.connectionId];
	return JSON.stringify([key.reporter, about, key.code]);
}

/** 复制一份 `about`(按联合原样拷,表里的与外面的不共用对象)。 */
function copyAbout(about: NonNullable<Problem["about"]>): NonNullable<Problem["about"]> {
	return "subscriptionId" in about
		? { subscriptionId: about.subscriptionId }
		: { connectionId: about.connectionId };
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
		const about = !problem.about
			? ""
			: "subscriptionId" in problem.about
				? ` subscription=${problem.about.subscriptionId}`
				: ` connection=${problem.about.connectionId}`;
		return `reporter=${problem.reporter}${about} code=${problem.code}`;
	}

	/** 宿主在清:挑出符合的那几条整条删掉,每条一个不补「已恢复」的 closed。 */
	function clearWhere(matches: (problem: Problem) => boolean): void {
		for (const [key, entry] of [...entries]) {
			if (!matches(entry.problem)) continue;
			entries.delete(key);
			logger.info(`[problems] 清掉(宿主) ${describe(entry.problem)}`);
			emit({
				kind: "closed",
				problem: entry.problem,
				notify: false,
				...recoveryOf(entry),
				...writtenByOf(entry),
			});
		}
	}

	/**
	 * 语言或口吻变了:把存着取字函数的条目挨个重跑。字变了只换文案,带 `reworded`;字没变不发;
	 * 函数抛了留旧字、记一行 warn,别的条目照常。每次重跑都把「这条是哪种语言下出的」更新成当前语言。
	 */
	function rerunTexts(): void {
		const texts = options.texts;
		if (texts === undefined) return;
		const locale = texts.locale();
		for (const entry of [...entries.values()]) {
			if (entry.messageText === undefined && entry.recoveryText === undefined) continue;
			let message = entry.problem.message;
			let recoveryMessage = entry.recoveryMessage;
			try {
				if (entry.messageText !== undefined) message = entry.messageText();
				if (entry.recoveryText !== undefined) recoveryMessage = entry.recoveryText();
			} catch (err) {
				logger.warn(
					`[problems] 换语言时重算问题句失败 ${describe(entry.problem)}: ${errorMessageOf(err)}`,
				);
				entry.locale = locale;
				continue;
			}
			entry.locale = locale;
			if (message === entry.problem.message && recoveryMessage === entry.recoveryMessage) continue;
			entry.problem = { ...entry.problem, message };
			if (recoveryMessage === undefined) delete entry.recoveryMessage;
			else entry.recoveryMessage = recoveryMessage;
			logger.debug(`[problems] 换说法 ${describe(entry.problem)}: ${message}`);
			emit({
				kind: "updated",
				problem: entry.problem,
				notify: entry.notify,
				...recoveryOf(entry),
				...writtenByOf(entry),
				reworded: true,
			});
		}
	}

	const textsSubscription = options.texts?.onChange(rerunTexts);

	return {
		report(input) {
			const key = problemKeyOf(input);
			const notify = input.notify ?? false;
			const locale = options.texts?.locale();
			const message = textOf(input.message);
			const recoveryMessage =
				input.recoveryMessage === undefined ? undefined : textOf(input.recoveryMessage);
			const existing = entries.get(key);
			if (existing) {
				const reworded = locale !== undefined && existing.locale !== locale;
				existing.locale = locale;
				existing.messageText = typeof input.message === "function" ? input.message : undefined;
				existing.recoveryText =
					typeof input.recoveryMessage === "function" ? input.recoveryMessage : undefined;
				if (
					existing.problem.message === message &&
					existing.notify === notify &&
					existing.recoveryMessage === recoveryMessage &&
					existing.writtenBy === input.writtenBy
				) {
					return;
				}
				existing.problem = { ...existing.problem, message };
				existing.notify = notify;
				if (recoveryMessage === undefined) delete existing.recoveryMessage;
				else existing.recoveryMessage = recoveryMessage;
				if (input.writtenBy === undefined) delete existing.writtenBy;
				else existing.writtenBy = input.writtenBy;
				logger.debug(`[problems] 换文案 ${describe(existing.problem)}: ${message}`);
				emit({
					kind: "updated",
					problem: existing.problem,
					notify,
					...recoveryOf(existing),
					...writtenByOf(existing),
					...(reworded ? { reworded: true as const } : {}),
				});
				return;
			}
			const problem: Problem = {
				reporter: input.reporter,
				...(input.about ? { about: copyAbout(input.about) } : {}),
				code: input.code,
				message,
				since: now().toISOString(),
			};
			const entry: Entry = {
				problem,
				notify,
				...(recoveryMessage === undefined ? {} : { recoveryMessage }),
				...(typeof input.message === "function" ? { messageText: input.message } : {}),
				...(typeof input.recoveryMessage === "function"
					? { recoveryText: input.recoveryMessage }
					: {}),
				...(input.writtenBy === undefined ? {} : { writtenBy: input.writtenBy }),
				...(locale === undefined ? {} : { locale }),
			};
			entries.set(key, entry);
			logger.warn(`[problems] 开 ${describe(problem)}: ${message}`);
			emit({ kind: "opened", problem, notify, ...recoveryOf(entry), ...writtenByOf(entry) });
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
				...writtenByOf(entry),
			});
		},
		clearReporter(reporter) {
			clearWhere((problem) => problem.reporter === reporter);
		},
		clearSubscription(subscriptionId) {
			clearWhere(
				(problem) =>
					problem.about !== undefined &&
					"subscriptionId" in problem.about &&
					problem.about.subscriptionId === subscriptionId,
			);
		},
		clearConnection(connectionId) {
			clearWhere(
				(problem) =>
					problem.about !== undefined &&
					"connectionId" in problem.about &&
					problem.about.connectionId === connectionId,
			);
		},
		list() {
			return [...entries.values()].map(({ problem }) => ({
				...problem,
				...(problem.about ? { about: copyAbout(problem.about) } : {}),
			}));
		},
		subscribe(fn) {
			listeners.add(fn);
			return { dispose: () => void listeners.delete(fn) };
		},
		dispose() {
			textsSubscription?.dispose();
			changed.dispose();
		},
	};
}
