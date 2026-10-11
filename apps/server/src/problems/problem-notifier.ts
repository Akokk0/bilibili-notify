import {
	type DeliveryResult,
	type Disposable,
	FAILURE_CODES,
	fail,
	type Logger,
	type ServiceContext,
} from "@bilibili-notify/internal";
import { errorMessageOf } from "../util/error-message.js";
import { type ProblemChange, type ProblemTable, problemKeyOf } from "./problem-table.js";

/**
 * 问题通知器:听问题表的变化,把报的人要求私聊的问题说给主人听,清掉时对说过的补一句「已恢复」。
 *
 * - **节流**:键是 报的人 + code(不含对象),窗口 {@link NOTIFY_WINDOW_MS};十个房间同一秒停监只说一条。
 *   同键有一条正在发时也算在窗口里。问题私聊与「已恢复」各一张表,窗口各算各的 —— 共用的话,
 *   一分钟内修好的事就不会被告知。
 * - **「真私聊过」** = `notify` 回了 ok。节流时间戳只在送到那一刻才记:没送到就记的话,下面的再送会被自己的节流吞掉。
 * - **再送**:没送到、且失败码是标准码表里「稍后可重试」的那几种,问题还开着就按 {@link RETRY_DELAYS_MS} 再试,
 *   用完记一行 warn 不再试;其余失败(没配主人、目标不是私聊、结果不明)再试也没用,不再送。
 *   再送发的是那一刻的 message。
 * - **已恢复**:只对真私聊过的补;报的人宿主在清的(来源停下、订阅删了)与明说不补的,表里的变更都带着
 *   `notify: false`,这里一律不补。发的是这条问题自带的 `recoveryMessage`(**当初真私聊出去那一刻**存下的,
 *   不是后来换过的);没带的用通用说法 {@link GENERIC_RECOVERY_PREFIX} 接当初真发出去的那句原文。
 *   「已恢复」没送到只记一行 warn,不再送。
 */

/** 报的人没给「恢复时怎么说」时的通用说法:后面接当初真发出去的那句原文。 */
export const GENERIC_RECOVERY_PREFIX = "主人，好消息，之前说的这件事已经恢复啦：";

/** 节流窗口:同一 报的人 + code,上次私聊之后这么久之内的后续私聊吞掉。 */
export const NOTIFY_WINDOW_MS = 60_000;

/** 再送的间隔(从上一次没送到算起),五次。 */
export const RETRY_DELAYS_MS = [10_000, 30_000, 60_000, 300_000, 900_000] as const;

export interface CreateProblemNotifierOptions {
	table: Pick<ProblemTable, "subscribe">;
	/** 私聊主人:`PushRouter.notifyMaster`。 */
	notify: (text: string) => Promise<DeliveryResult>;
	/** 私聊是发出去不等的后台活,登记进 `track`,关停等它发完;再送的计时器经 `setTimeout`,停下时作废。 */
	serviceCtx: Pick<ServiceContext, "setTimeout" | "track">;
	logger: Logger;
	now?: () => number;
}

/** 一条开着的问题在通知器这边的记账。 */
interface Slot {
	reporter: string;
	code: string;
	/** 最新的文案;再送发的是它。 */
	message: string;
	/** 报的人此刻要不要私聊。 */
	wantsNotify: boolean;
	/** 最新的「恢复时怎么说」(报的人给的;没给就没有)。 */
	recoveryMessage?: string;
	/** 当初真发出去(回了 ok)的那句,通用的「已恢复」引它;没有 = 没真私聊过。 */
	sentText?: string;
	/** 发出那一刻存下的「恢复时怎么说」:清掉时发它,不是后来换过的。 */
	sentRecovery?: string;
	/** 有一条正在发。 */
	sending: boolean;
	/** 已经用掉的再送次数。 */
	retriesUsed: number;
	retryTimer?: Disposable;
	/** 发送还在路上时问题就被清了:送到之后照样算真私聊过,要不要补「已恢复」看这一格。 */
	closedWhileSending?: { announceRecovery: boolean };
}

function throttleKey(slot: Pick<Slot, "reporter" | "code">): string {
	return JSON.stringify([slot.reporter, slot.code]);
}

/** 一张节流表:最近一次送到的时刻 + 正在发的键。 */
function createThrottle(now: () => number) {
	const lastSentAt = new Map<string, number>();
	const inFlight = new Set<string>();
	return {
		/** 窗口里(含正在发)? */
		blocked(key: string): boolean {
			if (inFlight.has(key)) return true;
			const last = lastSentAt.get(key);
			return last !== undefined && now() - last < NOTIFY_WINDOW_MS;
		},
		begin(key: string): void {
			inFlight.add(key);
		},
		/** 发完了;送到了才记时刻。 */
		end(key: string, delivered: boolean): void {
			inFlight.delete(key);
			if (delivered) lastSentAt.set(key, now());
		},
	};
}

export function createProblemNotifier(options: CreateProblemNotifierOptions): Disposable {
	const { logger, serviceCtx } = options;
	const now = options.now ?? Date.now;
	const slots = new Map<string, Slot>();
	const problemThrottle = createThrottle(now);
	const recoveryThrottle = createThrottle(now);
	let disposed = false;

	async function deliver(text: string): Promise<DeliveryResult> {
		try {
			return await options.notify(text);
		} catch (err) {
			return fail("unknown", errorMessageOf(err));
		}
	}

	function sendProblem(slot: Slot): void {
		const key = throttleKey(slot);
		if (problemThrottle.blocked(key)) {
			logger.debug(`[problems] 私聊被节流吞掉 reporter=${slot.reporter} code=${slot.code}`);
			return;
		}
		const text = slot.message;
		const recovery = slot.recoveryMessage;
		problemThrottle.begin(key);
		slot.sending = true;
		serviceCtx.track(
			deliver(text).then((result) => {
				problemThrottle.end(key, result.ok);
				slot.sending = false;
				if (disposed) return;
				if (result.ok) {
					slot.sentText = text;
					slot.sentRecovery = recovery;
					if (slot.closedWhileSending?.announceRecovery) sendRecovery(slot, text, recovery);
					return;
				}
				if (slot.closedWhileSending) return;
				logger.warn(
					`[problems] 私聊没送到 reporter=${slot.reporter} code=${slot.code}: ${result.message}`,
				);
				if (FAILURE_CODES[result.code].retry === "later" && slot.wantsNotify) scheduleRetry(slot);
			}),
		);
	}

	function scheduleRetry(slot: Slot): void {
		const delay = RETRY_DELAYS_MS[slot.retriesUsed];
		if (delay === undefined) {
			logger.warn(
				`[problems] 私聊再送 ${RETRY_DELAYS_MS.length} 次都没送到,放弃 reporter=${slot.reporter} code=${slot.code}`,
			);
			return;
		}
		slot.retriesUsed += 1;
		slot.retryTimer = serviceCtx.setTimeout(() => {
			slot.retryTimer = undefined;
			if (!slot.wantsNotify) return;
			sendProblem(slot);
		}, delay);
	}

	function sendRecovery(slot: Slot, sentText: string, sentRecovery: string | undefined): void {
		const key = throttleKey(slot);
		if (recoveryThrottle.blocked(key)) {
			logger.debug(`[problems] 「已恢复」被节流吞掉 reporter=${slot.reporter} code=${slot.code}`);
			return;
		}
		recoveryThrottle.begin(key);
		serviceCtx.track(
			deliver(sentRecovery ?? `${GENERIC_RECOVERY_PREFIX}${sentText}`).then((result) => {
				recoveryThrottle.end(key, result.ok);
				if (!result.ok && !disposed) {
					logger.warn(
						`[problems] 「已恢复」没送到 reporter=${slot.reporter} code=${slot.code}: ${result.message}`,
					);
				}
			}),
		);
	}

	function slotFor(change: ProblemChange): Slot {
		const key = problemKeyOf(change.problem);
		let slot = slots.get(key);
		if (!slot) {
			slot = {
				reporter: change.problem.reporter,
				code: change.problem.code,
				message: change.problem.message,
				wantsNotify: change.notify,
				sending: false,
				retriesUsed: 0,
			};
			slots.set(key, slot);
		}
		return slot;
	}

	function onChange(change: ProblemChange): void {
		if (change.kind === "closed") {
			const key = problemKeyOf(change.problem);
			const slot = slots.get(key);
			slots.delete(key);
			if (!slot) return;
			slot.retryTimer?.dispose();
			slot.retryTimer = undefined;
			slot.wantsNotify = false;
			if (slot.sending) slot.closedWhileSending = { announceRecovery: change.notify };
			else if (slot.sentText !== undefined && change.notify) {
				sendRecovery(slot, slot.sentText, slot.sentRecovery);
			}
			return;
		}
		const slot = slotFor(change);
		slot.message = change.problem.message;
		slot.recoveryMessage = change.recoveryMessage;
		slot.wantsNotify = change.notify;
		if (!slot.wantsNotify || slot.sentText !== undefined || slot.sending || slot.retryTimer) return;
		sendProblem(slot);
	}

	const subscription = options.table.subscribe(onChange);

	return {
		dispose() {
			disposed = true;
			subscription.dispose();
			for (const slot of slots.values()) slot.retryTimer?.dispose();
			slots.clear();
		},
	};
}
