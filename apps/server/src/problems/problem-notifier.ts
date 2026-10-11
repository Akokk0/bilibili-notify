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
 * 「该不该说、什么时候说」只有一处:{@link createProblemNotifier} 里的 `reconcile`,**按节流键(报的人 + code,
 * 不含对象)对账**。每个会改变局面的事件 —— 问题开 / 换文案 / 清、一次发送落定、计时器到点 —— 之后都走它,
 * 由它重新算这把键此刻欠不欠主人一句话、什么时候说。它不记「上次为什么没说」,每次都从现状算。
 *
 * - **窗口**:同一把键,上一句**送到**之后 {@link NOTIFY_WINDOW_MS} 之内不再发问题私聊;有一条在途时也不发
 *   (落定后再对账)。窗口只在送到那一刻才记:没送到就记的话,下面的再送会被自己的窗口吞掉。
 *   「已恢复」另用一张表,窗口各算各的 —— 共用的话,一分钟内修好的事就不会被告知。
 * - **欠着的** = 开着、要私聊、没说过、也没有被盖住的问题。同键欠着好几条只说最早开的那一条。
 * - **被盖住** = 这条被窗口吞掉,而吞掉它的那一句所属的问题**还开着、且那一句真送到了**(十个房间同时停监
 *   只说一条)。盖它的那条被清掉、挡住它的其实是一条已清的旧事留下的窗口、盖它的那一句最终没送到:
 *   都不算盖住,它是欠着的,窗口一过补说一次;说出去之后同键其余欠着的改由它盖住。
 *   窗口之外新开的不看这些,当场说。
 * - **「真私聊过」** = `notify` 回了 ok。
 * - **再送**:没送到、且失败码是标准码表里「稍后可重试」的那几种,按 {@link RETRY_DELAYS_MS} 再试。档位记在
 *   这把键上:到点时原来那条已经清了,就轮到同键欠着的下一条,档位接着数。五档用完、或失败不可重试(没配主人、
 *   目标不是私聊、结果不明),这把键停下 —— 同键此刻欠着的其余几条不拿去各试一遍;之后同键有新的一条要说
 *   (新开,或由「不要私聊」换成「要私聊」)才重新起头、当场再试。再送发的是那一刻的 message。
 * - **已恢复**:只对真私聊过的补;报的人宿主在清的(来源停下、订阅删了)与明说不补的,表里的变更都带着
 *   `notify: false`,这里一律不补。发的是这条问题自带的 `recoveryMessage`(**当初真私聊出去那一刻**存下的,
 *   不是后来换过的);没带的用通用说法 {@link GENERIC_RECOVERY_PREFIX} 接当初真发出去的那句原文。
 *   「已恢复」没送到只记一行 warn,不再送。
 * - **在途时清了又开**:发送途中这条问题被清、又被同一个键以「要私聊」重新开起来,新开的认领这次发送 ——
 *   等于没清过(送达后算它说过了,不补「已恢复」;没送到就照它走再送)。以「不要私聊」重开的不认领:
 *   那句话说的是已经清掉的那一条,送达后照旧对它补「已恢复」。
 */

/** 报的人没给「恢复时怎么说」时的通用说法:后面接当初真发出去的那句原文。 */
export const GENERIC_RECOVERY_PREFIX = "主人，好消息，之前说的这件事已经恢复啦：";

/** 节流窗口:同一 报的人 + code,上次私聊送到之后这么久之内不再发问题私聊。 */
export const NOTIFY_WINDOW_MS = 60_000;

/** 再送的间隔(从上一次没送到算起),五次。 */
export const RETRY_DELAYS_MS = [10_000, 30_000, 60_000, 300_000, 900_000] as const;

export interface CreateProblemNotifierOptions {
	table: Pick<ProblemTable, "subscribe">;
	/** 私聊主人:`PushRouter.notifyMaster`。 */
	notify: (text: string) => Promise<DeliveryResult>;
	/** 私聊是发出去不等的后台活,登记进 `track`,关停等它发完;计时器经 `setTimeout`,停下时作废。 */
	serviceCtx: Pick<ServiceContext, "setTimeout" | "track">;
	logger: Logger;
	now?: () => number;
}

/** 一条开着的问题在通知器这边的记账。 */
interface ProblemEntry {
	/** 问题在表里的键({@link problemKeyOf})。 */
	id: string;
	reporter: string;
	code: string;
	/** 最新的文案;发的是它。 */
	message: string;
	/** 报的人此刻要不要私聊。 */
	wantsNotify: boolean;
	/** 最新的「恢复时怎么说」(报的人给的;没给就没有)。 */
	recoveryMessage?: string;
	/** 当初真发出去(回了 ok)的那句,通用的「已恢复」引它;没有 = 没真私聊过。 */
	sentText?: string;
	/** 发出那一刻存下的「恢复时怎么说」:清掉时发它,不是后来换过的。 */
	sentRecovery?: string;
	/** 吞掉这一条的那一句所属的问题。它还开着且说过,这一条才算被盖住。 */
	coveredBy?: ProblemEntry;
}

/** 一次在路上的发送。 */
interface SendState {
	/** 等这次结果的那条问题;发送途中清了又开时换成新开的那条(认领)。 */
	entry: ProblemEntry;
	/** 问题在表里的键(认领按它找)。 */
	problemId: string;
	/** 发出去的那句与发出那一刻的「恢复时怎么说」。 */
	text: string;
	recovery?: string;
	/** 发送途中问题被清了(且还没被认领):送到之后要不要补「已恢复」。 */
	closed?: { announceRecovery: boolean };
}

/** 一把节流键(报的人 + code)的账。 */
interface ThrottleState {
	/** 上一句问题私聊送到的时刻;窗口从它起算。 */
	lastDeliveredAt?: number;
	/** 上一句送到的话所属的问题(送到时它已经清了就没有)。 */
	lastSaid?: ProblemEntry;
	/** 在路上的那一发(每把键同时至多一发)。 */
	sending?: SendState;
	/** 「到点再对账」的计时器(每把键至多一个:窗口到点或再送到点)。 */
	timer?: Disposable;
	/** 已经用掉的再送档数。 */
	retriesUsed: number;
	/** 再送最早什么时候(没在等再送就没有)。 */
	retryAt?: number;
	/** 停下了(失败不可重试,或五档用完):同键有新的一条要说之前不再试。 */
	halted: boolean;
}

function throttleKey(problem: { reporter: string; code: string }): string {
	return JSON.stringify([problem.reporter, problem.code]);
}

/** 「已恢复」的节流表:最近一次送到的时刻 + 正在发的键。 */
function createRecoveryThrottle(now: () => number) {
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
	/** 开着的问题,按开的先后(`Map` 的插入序)。 */
	const entries = new Map<string, ProblemEntry>();
	const throttles = new Map<string, ThrottleState>();
	const recoveryThrottle = createRecoveryThrottle(now);
	let disposed = false;

	async function deliver(text: string): Promise<DeliveryResult> {
		try {
			return await options.notify(text);
		} catch (err) {
			return fail("unknown", errorMessageOf(err));
		}
	}

	function throttleOf(key: string): ThrottleState {
		let state = throttles.get(key);
		if (!state) {
			state = { retriesUsed: 0, halted: false };
			throttles.set(key, state);
		}
		return state;
	}

	/** 这条还开着、且真说过:它那一句盖得住别的。 */
	function covers(entry: ProblemEntry): boolean {
		return entries.get(entry.id) === entry && entry.sentText !== undefined;
	}

	/** 这把键欠着的:开着、要私聊、没说过、没被盖住,按开的先后。 */
	function owedOf(key: string): ProblemEntry[] {
		const owed: ProblemEntry[] = [];
		for (const entry of entries.values()) {
			if (throttleKey(entry) !== key) continue;
			if (!entry.wantsNotify || entry.sentText !== undefined) continue;
			if (entry.coveredBy && covers(entry.coveredBy)) continue;
			owed.push(entry);
		}
		return owed;
	}

	/** 再送的账归零(送到了、没有欠着的了、或同键有新的一条要说)。 */
	function resetRetry(state: ThrottleState): void {
		state.retriesUsed = 0;
		state.retryAt = undefined;
		state.halted = false;
	}

	/**
	 * 在途的那一发所属的问题被清了、又被同一个键以「要私聊」重新开起来:新开的认领这次发送。
	 */
	function claimSending(sending: SendState): void {
		if (!sending.closed) return;
		const reopened = entries.get(sending.problemId);
		if (!reopened?.wantsNotify || reopened.sentText !== undefined) return;
		sending.entry = reopened;
		sending.closed = undefined;
	}

	/**
	 * 对账:这把键此刻欠不欠主人一句话、什么时候说。每个会改变局面的事件之后都调它,幂等。
	 */
	function reconcile(key: string): void {
		if (disposed) return;
		const state = throttleOf(key);
		if (state.sending) {
			// 有一发在路上:落定时再对账。只看它能不能被认领。
			claimSending(state.sending);
			return;
		}
		state.timer?.dispose();
		state.timer = undefined;

		let owed = owedOf(key);
		const windowEndsAt =
			state.lastDeliveredAt === undefined ? 0 : state.lastDeliveredAt + NOTIFY_WINDOW_MS;
		if (now() < windowEndsAt && state.lastSaid && covers(state.lastSaid)) {
			// 窗口里,而开窗的那一句所属的问题还开着:欠着的都由它盖住
			for (const entry of owed) entry.coveredBy = state.lastSaid;
			if (owed.length > 0) {
				logger.debug(`[problems] 私聊被节流吞掉(由已说的那条盖住) key=${key} 共 ${owed.length} 条`);
			}
			owed = [];
		}
		const first = owed[0];
		if (!first) {
			resetRetry(state);
			return;
		}
		if (state.halted) return;
		const waitMs = Math.max(windowEndsAt, state.retryAt ?? 0) - now();
		if (waitMs > 0) {
			state.timer = serviceCtx.setTimeout(() => {
				state.timer = undefined;
				reconcile(key);
			}, waitMs);
			return;
		}
		send(key, state, first);
	}

	function send(key: string, state: ThrottleState, entry: ProblemEntry): void {
		const sending: SendState = {
			entry,
			problemId: entry.id,
			text: entry.message,
			...(entry.recoveryMessage === undefined ? {} : { recovery: entry.recoveryMessage }),
		};
		state.sending = sending;
		serviceCtx.track(
			deliver(sending.text).then((result) => {
				state.sending = undefined;
				if (disposed) return;
				settle(state, sending, result);
				reconcile(key);
			}),
		);
	}

	/** 一次发送落定:记账,不决定下一步(下一步由对账定)。 */
	function settle(state: ThrottleState, sending: SendState, result: DeliveryResult): void {
		const { entry, text, recovery, closed } = sending;
		if (result.ok) {
			state.lastDeliveredAt = now();
			resetRetry(state);
			if (!closed) {
				entry.sentText = text;
				entry.sentRecovery = recovery;
				entry.coveredBy = undefined;
				state.lastSaid = entry;
				return;
			}
			// 发送途中问题清了、没人认领:这一句照样算真私聊过,窗口照记,但没有开着的问题顶着它
			state.lastSaid = undefined;
			if (closed.announceRecovery) sendRecovery(entry, text, recovery);
			return;
		}
		logger.warn(
			`[problems] 私聊没送到 reporter=${entry.reporter} code=${entry.code}: ${result.message}`,
		);
		if (FAILURE_CODES[result.code].retry !== "later") {
			state.halted = true;
			return;
		}
		const delay = RETRY_DELAYS_MS[state.retriesUsed];
		if (delay === undefined) {
			logger.warn(
				`[problems] 私聊再送 ${RETRY_DELAYS_MS.length} 次都没送到,放弃 reporter=${entry.reporter} code=${entry.code}`,
			);
			state.halted = true;
			return;
		}
		state.retriesUsed += 1;
		state.retryAt = now() + delay;
	}

	function sendRecovery(
		problem: Pick<ProblemEntry, "reporter" | "code">,
		sentText: string,
		sentRecovery: string | undefined,
	): void {
		const key = throttleKey(problem);
		if (recoveryThrottle.blocked(key)) {
			logger.debug(
				`[problems] 「已恢复」被节流吞掉 reporter=${problem.reporter} code=${problem.code}`,
			);
			return;
		}
		recoveryThrottle.begin(key);
		serviceCtx.track(
			deliver(sentRecovery ?? `${GENERIC_RECOVERY_PREFIX}${sentText}`).then((result) => {
				recoveryThrottle.end(key, result.ok);
				if (!result.ok && !disposed) {
					logger.warn(
						`[problems] 「已恢复」没送到 reporter=${problem.reporter} code=${problem.code}: ${result.message}`,
					);
				}
			}),
		);
	}

	function onChange(change: ProblemChange): void {
		const id = problemKeyOf(change.problem);
		const key = throttleKey(change.problem);
		const state = throttleOf(key);
		if (change.kind === "closed") {
			const entry = entries.get(id);
			if (!entry) return;
			entries.delete(id);
			const sending = state.sending;
			if (sending && !sending.closed && sending.entry === entry) {
				// 这条的那一发还在路上:送到之后再看要不要补「已恢复」(期间同键再开的可以认领它)
				sending.closed = { announceRecovery: change.notify };
			} else if (entry.sentText !== undefined && change.notify) {
				sendRecovery(entry, entry.sentText, entry.sentRecovery);
			}
			reconcile(key);
			return;
		}
		let entry = entries.get(id);
		if (!entry) {
			entry = {
				id,
				reporter: change.problem.reporter,
				code: change.problem.code,
				message: change.problem.message,
				wantsNotify: false,
			};
			entries.set(id, entry);
		}
		const wanted = entry.wantsNotify;
		entry.message = change.problem.message;
		entry.recoveryMessage = change.recoveryMessage;
		entry.wantsNotify = change.notify;
		// 同键有新的一条要说(新开,或由「不要私聊」换成「要私聊」):再送的账重新起头,当场试
		if (change.notify && !wanted && entry.sentText === undefined) resetRetry(state);
		reconcile(key);
	}

	const subscription = options.table.subscribe(onChange);

	return {
		dispose() {
			disposed = true;
			subscription.dispose();
			for (const state of throttles.values()) state.timer?.dispose();
			throttles.clear();
			entries.clear();
		},
	};
}
