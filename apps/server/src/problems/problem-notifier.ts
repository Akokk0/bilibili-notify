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
 * - **欠着的** = 开着、要私聊、没说过、没有被盖住、也没有被记成「不再说」的问题。同键欠着好几条只说最早开的那一条。
 * - **被盖住** = 这条被窗口吞掉,而吞掉它的那一句所属的问题**还开着、且那一句真送到了**(十个房间同时停监
 *   只说一条)。盖它的那条被清掉、挡住它的其实是一条已清的旧事留下的窗口、盖它的那一句最终没送到:
 *   都不算盖住,它是欠着的,窗口一过补说一次;说出去之后同键其余欠着的改由它盖住。
 *   窗口之外新开的不看这些,当场说(撞上下面的沉淀期除外)。
 * - **沉淀**:这把键上每清掉一条,此后 {@link CLOSE_SETTLE_MS} 之内不发问题私聊(与窗口尾、再送时刻取最晚的,
 *   共用那一个计时器),到点再对账,那时还欠着的才说。问题表的清是一条一条来的(来源停下、掉登录、被风控、
 *   整批重建),逐个取消会话时中间还可能隔着 await:不等这一批落完,就会抢着对马上被清掉的那一条补说一句,
 *   而那种清是静默的,之后没有任何一句把它收回。沉淀期里同键**新开**的也一样等到沉淀期过 ——
 *   「清一批」与「重建后又开一批」可能交错,分不出哪条是这一批的。「已恢复」不受沉淀影响,当场发。
 * - **「真私聊过」** = `notify` 回了 ok。
 * - **再送**:没送到、且失败码是标准码表里「稍后可重试」的那几种,按 {@link RETRY_DELAYS_MS} 再试。档位记在
 *   这把键上:到点时原来那条已经清了,就轮到同键欠着的下一条,档位接着数。五档用完、或失败不可重试(没配主人、
 *   目标不是私聊、结果不明),这把键**停下** —— 同键此刻欠着的其余几条不拿去各试一遍。再送发的是那一刻的 message。
 * - **停下之后怎么重新起头**:同键有新的一条要说(新开,或由「不要私聊」换成「要私聊」),当场再试;同键说过的
 *   一条被清掉、或一句「已恢复」送到了(通道是通的),停下放开、再送的账归零,欠着的照沉淀的规矩补说。
 * - **不再说**:一句以**结果不明**的失败落定(标准码表里「绝不重发」的那一种:可能已经送到了),**那一条**记成
 *   「不再说」—— 不是「说过」:不补「已恢复」、不盖别的,只是之后对账跳过它。于是同键新开一条时试的是最早的、
 *   还没被放弃的那条(一个一个开的时候就是新开的那条自己),不会把可能已经送到的同一句再发一遍。它重新算数只有
 *   两种:自己被清掉又重开(那是新的一条),或报的人换了一句话再报、且仍要私聊。
 *   别的失败都确知没送到,**不**记:不可重试的那几种(没配主人、目标不是私聊……)与五档用完只让键停下,重新
 *   起头时试的仍是最早欠着的那条 —— 没配主人时一个一个开,每次本地试一遍同一句(不出网、不会重复送到);
 *   配上之后新开一条,说的是欠得最久的那条,其余由它盖住。
 * - **已恢复**:只对真私聊过的补;报的人宿主在清的(来源停下、订阅删了)与明说不补的,表里的变更都带着
 *   `notify: false`,这里一律不补。发的是这条问题自带的 `recoveryMessage`(**当初真私聊出去那一刻**存下的,
 *   不是后来换过的);没带的用通用说法 {@link GENERIC_RECOVERY_PREFIX} 接当初真发出去的那句原文。
 *   「已恢复」没送到只记一行 warn,不再送。
 * - **在途时清了又开**:发送途中这条问题被清、又被同一个键以「要私聊」重新开起来,新开的认领这次发送 ——
 *   等于没清过(送达后算它说过了,不补「已恢复」;没送到就照它走再送)。以「不要私聊」重开的不认领:
 *   那句话说的是已经清掉的那一条,送达后照旧对它补「已恢复」。
 *
 * 已知的缺口(定了不修):
 * - 同键好几条一个一个修好:第一句「已恢复」之后轮到下一条被说出去,它随后也修好了,而它的「已恢复」落在
 *   「已恢复」那张节流表的窗口里被吞 —— 主人听到的最后一句是「停了」,其实都好了。
 * - 键停下之后只有旧的欠着、再没有新的一条,也没有说过的被清掉、没有恢复句送到:那几条一直没人说。
 * - 结果不明而被记成「不再说」的那一条,就算其实没送到、通道后来也好了,也不会补(宁可少说一句,不重复说)。
 */

/** 报的人没给「恢复时怎么说」时的通用说法:后面接当初真发出去的那句原文。 */
export const GENERIC_RECOVERY_PREFIX = "主人，好消息，之前说的这件事已经恢复啦：";

/** 节流窗口:同一 报的人 + code,上次私聊送到之后这么久之内不再发问题私聊。 */
export const NOTIFY_WINDOW_MS = 60_000;

/**
 * 沉淀时间:一把键上清掉一条之后,这么久之内不发问题私聊。要盖住「一批清」落完的时长(逐个取消会话时中间
 * 隔着的那几个 await),又不能让真该补说的那一句迟得让人察觉。
 */
export const CLOSE_SETTLE_MS = 5_000;

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
	/**
	 * 以结果不明的失败落定的那一句(「不再说」:它可能已经送到了):有它,对账就跳过这一条。报的人换了一句
	 * 别的话再报、且仍要私聊时才去掉。
	 */
	givenUpText?: string;
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
	/** 「到点再对账」的计时器(每把键至多一个:窗口到点、再送到点或沉淀期过)。 */
	timer?: Disposable;
	/** 沉淀期到什么时候(这把键上最近一次清掉一条的时刻 + {@link CLOSE_SETTLE_MS});没清过就没有。 */
	closeSettlesAt?: number;
	/** 已经用掉的再送档数。 */
	retriesUsed: number;
	/** 再送最早什么时候(没在等再送就没有)。 */
	retryAt?: number;
	/** 停下了(失败不可重试,或五档用完):同键有新的一条要说、说过的一条被清掉、或一句「已恢复」送到之前不再试。 */
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

	/** 这把键欠着的:开着、要私聊、没说过、没被盖住、没记成「不再说」,按开的先后。 */
	function owedOf(key: string): ProblemEntry[] {
		const owed: ProblemEntry[] = [];
		for (const entry of entries.values()) {
			if (throttleKey(entry) !== key) continue;
			if (!entry.wantsNotify || entry.sentText !== undefined) continue;
			if (entry.givenUpText !== undefined) continue;
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
	 * 停下的键放开:同键说过的一条被清掉、或一句「已恢复」送到了(通道是通的)。没停下就不动 ——
	 * 正在数档位的再送照旧数它的。
	 */
	function releaseHalt(state: ThrottleState): void {
		if (state.halted) resetRetry(state);
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
		// 窗口尾、再送时刻、沉淀期,取最晚的那个;到点重新对账(那时还欠着的才说)
		const waitMs = Math.max(windowEndsAt, state.retryAt ?? 0, state.closeSettlesAt ?? 0) - now();
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
		const { retry } = FAILURE_CODES[result.code];
		if (retry !== "later") {
			// 结果不明(码表里「绝不重发」):这一句可能已经送到了,那一条不再说。别的不可重试的失败确知没送到,只让键停下。
			// 发送途中清掉、没人认领的那条已经不在账上,不用记。
			if (retry === "never" && !closed) entry.givenUpText = text;
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
				if (disposed) return;
				if (!result.ok) {
					logger.warn(
						`[problems] 「已恢复」没送到 reporter=${problem.reporter} code=${problem.code}: ${result.message}`,
					);
					return;
				}
				// 送到了 = 通道是通的:这把键要是停下了就放开,欠着的重新对账
				const state = throttles.get(key);
				if (!state?.halted) return;
				releaseHalt(state);
				reconcile(key);
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
			// 这把键刚清过东西:沉淀期里不发问题私聊(同一批里的下一条清可能马上就到)
			state.closeSettlesAt = now() + CLOSE_SETTLE_MS;
			const sending = state.sending;
			if (sending && !sending.closed && sending.entry === entry) {
				// 这条的那一发还在路上:送到之后再看要不要补「已恢复」(期间同键再开的可以认领它)
				sending.closed = { announceRecovery: change.notify };
			} else if (entry.sentText !== undefined) {
				// 说过的一条没了:它盖着的那几条重新欠着,键要是停下了就放开
				releaseHalt(state);
				if (change.notify) sendRecovery(entry, entry.sentText, entry.sentRecovery);
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
		// 被记成「不再说」的那一条:报的人换了一句别的话、且仍要私聊,才重新算数
		const revived =
			entry.givenUpText !== undefined && change.notify && entry.message !== entry.givenUpText;
		if (revived) entry.givenUpText = undefined;
		// 同键有新的一条要说(新开、由「不要私聊」换成「要私聊」、或上面那种重新算数):再送的账重新起头,当场试。
		// 仍记着「不再说」的那一条翻回「要私聊」不算。
		const newlyOwed =
			change.notify &&
			entry.sentText === undefined &&
			entry.givenUpText === undefined &&
			(!wanted || revived);
		if (newlyOwed) resetRetry(state);
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
