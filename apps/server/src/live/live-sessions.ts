import type {
	Disposable,
	ExtensionLiveSessionEndReason,
	LiveDetails,
	LiveSignal,
	Logger,
	MessageBus,
	ServiceContext,
	Subscription,
} from "@bilibili-notify/internal";
import { subscriptionIdentityOf } from "@bilibili-notify/internal";
import type { SourceStatusReader } from "../subscriptions/source-status.js";
import type { LiveWorkSettings } from "./live-settings.js";
import { liveEndGraceMinutes } from "./live-settings.js";
import type { LiveTable } from "./live-table.js";

/**
 * **订阅的直播场次**(ADR-0020 决策 6;ADR-0019 决策 53 / 57 / 58 / 61):每条订阅此刻是哪一场、这一场
 * 从哪开始、到哪结束(含断流等待)。直播推送(`live-push.ts`)吃这一份 —— 场次只算一遍,
 * 推送与别的消费方看到的是同一场。
 *
 * 输入是中立的 {@link LiveSignal}(每条订阅一份),经 {@link LiveSessionEngine.apply} 直调进来;引擎**先写在播表、
 * 再改场次**,所以场次读到的「最新那一份」就是这一份信号刚写进去的。
 *
 * - **开播**:开播信号开一场(开播时刻取信号的);正处在断流等待里 → 取消等待,**同一场接着播**,开播时刻
 *   与粉丝基线沿用第一次的(决策 58)。上一场没报下播就又开播了 → 上一场在这儿收掉。
 * - **直播状态**:在播、手里又没有这一场 → 认出一场(BN 起来之前、或来源停着的时候就开播了;开播时刻取状态
 *   带的,没带就空着,之后的状态带了再补上)。有这一场 → 把在播表里最新那一份记到这一场上。不在播 → 这一场
 *   不动:BN 不拿状态的翻转猜下播(决策 53)。
 * - **下播**只由信号触发(决策 53)。断流接续开着(按 UP 折好的 `liveEndGrace` / `liveEndGraceMinutes`)就先
 *   压着,等满了这一场才结束,结束时刻是**信号带的下播时刻**(等的那几分钟不算);没开立刻结束。
 * - **作废**(决策 61):来源停了、订阅停用 / 删了、关机 → 这一场当场结束,等着的下播不再等。
 *
 * 一场的开始与结束发上总线(`extension-live-session`,ADR-0020 决策 6),统计据此记场次 —— 结束帧带着原因与
 * 本场报过的最大累计观看(决策 7,见 {@link LiveSession.peakTotalViewers}),来源停了 / 关机时补的那一帧
 * 也在里面;断流接续里的那一下不是边界,不发。推送要的比边界多(断流等待开始了、
 * 又来一份状态、手里没有这一场的下播……),经 {@link LiveSessionEngine.onChange} 直接听,不走总线。
 *
 * 只记「订阅在、启用着、来源在跑」的(与推送同一个判据,{@link liveSubscriptionPushable}),**与推送开关无关**
 * (ADR-0020 决策 4):统计记的是「UP 做了什么」,推送关着这一场照样开、照样结束 —— 推送关掉只是不推。
 *
 * 只在内存:BN 重启之后靠来源开机第一轮报的直播状态接上(决策 57 / 8)。
 */

type StartSignal = Extract<LiveSignal, { kind: "start" }>;
type StatusSignal = Extract<LiveSignal, { kind: "status" }>;
type EndSignal = Extract<LiveSignal, { kind: "end" }>;

const MINUTE = 60_000;

/**
 * 这条订阅现在还该推吗:订阅还在、启用着、它的来源还在跑。场次与推送共用,**不认来源是哪一种**
 * (拓展、B 站,都只看读口怎么说)。
 *
 * 信号分发那一刻 ctx 已经按开关筛过(决策 62),推送这头是出卡、点评几个 await 之后发送之前的**再核一次**
 * —— 期间主人可能停用了这条订阅、停用了来源(决策 61:来源停了,等着的推送不补)、或者删了它。
 */
export function liveSubscriptionPushable(
	sub: Subscription | undefined,
	sources: Pick<SourceStatusReader, "running">,
): sub is Subscription {
	return sub?.enabled === true && sources.running(subscriptionIdentityOf(sub).sourceKey);
}

/** 毫秒 → 总线上的 ISO。 */
const iso = (ms: number): string => new Date(ms).toISOString();

/** 信号里的 ISO 时刻 → 毫秒;缺了、或不是有效时刻就是 `undefined`。 */
function millisOf(time: string | undefined): number | undefined {
	if (time === undefined) return undefined;
	const ms = Date.parse(time);
	return Number.isNaN(ms) ? undefined : ms;
}

/** 一条订阅正在播的这一场。只读:场次只由这里改。 */
export interface LiveSession {
	readonly subscriptionId: string;
	readonly sourceKey: string;
	/**
	 * 开播时刻(毫秒)。开播信号带了才有;只见过直播状态时来源报了才有 —— 之后的状态带了再补上。断流接续时
	 * 沿用第一次的。
	 */
	readonly startedAt?: number;
	/** BN 认出这一场的那一刻:开播信号、或认出它的那份在播状态到达时。 */
	readonly detectedAt: number;
	/** 开播时(或 BN 认出这一场时)资料里的粉丝数 —— 下播算粉丝数变化的基线(决策 56)。 */
	readonly followersAtStart?: number;
	/**
	 * 这一场里(开播、直播状态、下播)报过的**最大累计观看**(ADR-0020 决策 7)。累计只增不减,最大的就是本场
	 * 最后那个累计数;断流接续是同一场,接着取;新的一场从头取。只认 `totalViewers`,此刻在线不算。一次都没报过
	 * 就没有。结束帧带着它给统计当这一场的峰值。
	 */
	readonly peakTotalViewers?: number;
	/**
	 * 在播表里这一场最后一份。下播信号一到那一行就出表了,下播卡没带的格(标题、累计观看……)从这里补;
	 * 只是拿着那一行的内容,不是另存的一份状态。
	 */
	readonly lastDetails?: LiveDetails;
	/** 断流接续正在等的那次下播:信号带的下播时刻(毫秒)与它带的格。 */
	readonly pendingEnd?: {
		readonly endedAt: number;
		readonly startedAt?: number;
		readonly details?: LiveDetails;
	};
}

/**
 * 场次的每一次变化,按发生的顺序、同步地交给 {@link LiveSessionEngine.onChange} 的监听者。
 *
 * 除了一场的开始与结束,还有推送那头要的几样:断流等待里又开播了、又来一份直播状态、下播进了断流等待、
 * 下播信号来了手里却没有这一场。带着信号的详情,开播 / 下播卡要拿它出卡。
 */
export type LiveSessionChange =
	| {
			kind: "start";
			subscriptionId: string;
			session: LiveSession;
			/** 认出这一场的是哪种信号:开播信号,或 BN 开始看之后见到的在播状态。 */
			trigger: "start-signal" | "status-signal";
			details: LiveDetails;
	  }
	/** 断流等待里又开播了:同一场接着播(决策 58)。 */
	| { kind: "resume"; subscriptionId: string; session: LiveSession; details: LiveDetails }
	/**
	 * 又一份直播状态(认出一场的那一份记作 `start`,不在这里)。在播的已经记到这一场上;不在播的不动这一场
	 * (`session` 是此刻那一场,可能没有)。
	 */
	| {
			kind: "status";
			subscriptionId: string;
			live: boolean;
			session: LiveSession | undefined;
	  }
	/** 下播信号到了,断流接续开着:进等待,这一场还没结束。 */
	| { kind: "ending"; subscriptionId: string; session: LiveSession }
	/**
	 * 这一场结束了。`at`:下播是信号带的下播时刻,其余是结束的那一刻;`details` / `reportedStartedAt`:下播信号
	 * 带的格与开播时刻(毫秒)。
	 */
	| {
			kind: "end";
			subscriptionId: string;
			session: LiveSession;
			reason: ExtensionLiveSessionEndReason;
			at: number;
			details?: LiveDetails;
			reportedStartedAt?: number;
	  }
	/** 下播信号到了,手里却没有这一场(BN 中途重启过、来源没报过状态)。 */
	| {
			kind: "unmatched-end";
			subscriptionId: string;
			at: number;
			details?: LiveDetails;
			reportedStartedAt?: number;
	  };

export interface LiveSessionEngine extends Disposable {
	/** 这条订阅此刻那一场;没在播(或 BN 手里没有)就是 `undefined`。 */
	get(subscriptionId: string): LiveSession | undefined;
	/** 喂一份信号:先写在播表、再改场次、最后按顺序同步通知监听者。 */
	apply(signal: LiveSignal): void;
	/** 听场次的变化。场次先改好,再按顺序同步通知。 */
	onChange(listener: (change: LiveSessionChange) => void): Disposable;
}

export interface CreateLiveSessionEngineOptions {
	bus: MessageBus;
	logger: Logger;
	/** 在播表 —— 引擎是唯一写它的;这一场最后一份状态也从这里取。 */
	table: Pick<LiveTable, "get" | "replace" | "merge" | "remove">;
	/** 此刻的这条订阅(现取)。 */
	subscription(id: string): Subscription | undefined;
	/** 来源此刻在不在跑(现取)。 */
	sourceStatus: Pick<SourceStatusReader, "running">;
	/** 订阅资料里的粉丝数(资料缓存,现取)。 */
	fans(id: string): number | undefined;
	/** 这条订阅折好的直播设置(现折,见 `liveWorkSettings`)—— 只看断流接续那两格。 */
	settings(sub: Subscription): Pick<LiveWorkSettings, "liveEndGrace" | "liveEndGraceMinutes">;
	/** 断流等待的定时器 —— 宿主的 ServiceContext(关机时一起清)。 */
	timers: Pick<ServiceContext, "setTimeout">;
	/** 只有测试会换。 */
	now?: () => number;
}

/** 场次在这里的样子:比对外多一个断流等待的定时器,和总线上这一场的开播时刻。 */
interface SessionState {
	subscriptionId: string;
	sourceKey: string;
	startedAt?: number;
	/** 总线上这一场的开播时刻(身份):开始时定下,结束帧原样带着。 */
	busStartedAt: string;
	detectedAt: number;
	followersAtStart?: number;
	peakTotalViewers?: number;
	lastDetails?: LiveDetails;
	pendingEnd?: { endedAt: number; startedAt?: number; details?: LiveDetails; handle: Disposable };
}

/** 这一份信号带的累计观看记到这一场上:只留最大的。 */
function notePeakTotalViewers(session: SessionState, details: LiveDetails | undefined): void {
	const total = details?.totalViewers;
	if (total === undefined) return;
	if (session.peakTotalViewers === undefined || total > session.peakTotalViewers) {
		session.peakTotalViewers = total;
	}
}

const REASON_TEXT: Record<ExtensionLiveSessionEndReason, string> = {
	ended: "下播",
	superseded: "没报下播就又开播了",
	"extension-stopped": "拓展停了",
	disabled: "订阅停用了",
	removed: "订阅删了",
	shutdown: "关机",
};

export function createLiveSessionEngine(opts: CreateLiveSessionEngineOptions): LiveSessionEngine {
	const log = opts.logger;
	const now = opts.now ?? Date.now;
	const sessions = new Map<string, SessionState>();
	const listeners = new Set<(change: LiveSessionChange) => void>();
	let disposed = false;

	function announce(change: LiveSessionChange): void {
		for (const listener of [...listeners]) listener(change);
	}

	/** 一场开始了,发上总线 —— 统计只要边界(ADR-0020 决策 6)。总线载荷的字面不动(3b-23 改)。 */
	function publishStart(session: SessionState, trigger: "liveStart" | "liveStatus"): void {
		opts.bus.emit("extension-live-session", {
			phase: "start",
			subscriptionId: session.subscriptionId,
			extensionId: session.sourceKey,
			startedAt: session.busStartedAt,
			at: iso(session.detectedAt),
			trigger,
		});
	}

	/** 一场结束了,发上总线。 */
	function publishEnd(
		session: SessionState,
		reason: ExtensionLiveSessionEndReason,
		at: number,
	): void {
		opts.bus.emit("extension-live-session", {
			phase: "end",
			subscriptionId: session.subscriptionId,
			extensionId: session.sourceKey,
			startedAt: session.busStartedAt,
			at: iso(at),
			reason,
			...(session.peakTotalViewers === undefined ? {} : { totalViewers: session.peakTotalViewers }),
		});
	}

	/** 这条订阅现在记不记:还在、启用着、来源在跑。关机之后一律不记。 */
	function trackable(id: string): Subscription | undefined {
		if (disposed) return undefined;
		const sub = opts.subscription(id);
		return liveSubscriptionPushable(sub, opts.sourceStatus) ? sub : undefined;
	}

	/** 这一场结束。等着的下播不再等。 */
	function end(
		id: string,
		reason: ExtensionLiveSessionEndReason,
		at: number = now(),
		reported?: { startedAt?: number; details?: LiveDetails },
	): void {
		const session = sessions.get(id);
		if (!session) return;
		const waiting = session.pendingEnd;
		waiting?.handle.dispose();
		session.pendingEnd = undefined;
		sessions.delete(id);
		log.debug(
			`[ext-live] 订阅 ${id} 的这一场结束(${REASON_TEXT[reason]})${waiting && reason !== "ended" ? ",等着的下播不再等" : ""}`,
		);
		announce({
			kind: "end",
			subscriptionId: id,
			session,
			reason,
			at,
			details: reported?.details,
			reportedStartedAt: reported?.startedAt,
		});
		publishEnd(session, reason, at);
	}

	function begin(
		signal: StartSignal | StatusSignal,
		sourceKey: string,
		startedAt: number | undefined,
	): SessionState {
		const id = signal.subscriptionId;
		const detectedAt = now();
		const session: SessionState = {
			subscriptionId: id,
			sourceKey,
			startedAt,
			// 状态没带开播时刻:取认出它的那一刻(ADR-0020 决策 6)。
			busStartedAt: iso(startedAt ?? detectedAt),
			detectedAt,
			followersAtStart: opts.fans(id),
			lastDetails: opts.table.get(id)?.details,
		};
		// 新的一场从头取:只算认出它的这一份。
		notePeakTotalViewers(session, signal.details);
		sessions.set(id, session);
		return session;
	}

	function onStart(signal: StartSignal): void {
		const id = signal.subscriptionId;
		const sub = trackable(id);
		if (!sub) {
			log.debug(`[ext-live] 订阅 ${id} 已停用 / 已删 / 它的来源没在跑,这次开播不管`);
			return;
		}
		const sourceKey = signal.identity.sourceKey;
		const startedAt = millisOf(signal.startedAt);
		// 新的一场:整行换新,上一场留下的格一概不带(漏了下播的那场也在这儿收尾)。
		opts.table.replace(id, sourceKey, startedAt, signal.details);
		const current = sessions.get(id);
		if (current?.pendingEnd) {
			// 断流接续(决策 58):同一场。取消等待,开播时刻与粉丝基线沿用第一次的。
			current.pendingEnd.handle.dispose();
			current.pendingEnd = undefined;
			current.lastDetails = opts.table.get(id)?.details ?? current.lastDetails;
			notePeakTotalViewers(current, signal.details);
			log.debug(`[ext-live] 订阅 ${id} 断流后重新开播,接续为同一场`);
			announce({ kind: "resume", subscriptionId: id, session: current, details: signal.details });
			return;
		}
		// 新的一场。上一场没报下播的话,在这儿收掉。
		end(id, "superseded");
		const session = begin(signal, sourceKey, startedAt);
		announce({
			kind: "start",
			subscriptionId: id,
			session,
			trigger: "start-signal",
			details: signal.details,
		});
		publishStart(session, "liveStart");
	}

	function onStatus(signal: StatusSignal): void {
		const id = signal.subscriptionId;
		const sub = trackable(id);
		if (!sub) return;
		const current = sessions.get(id);
		// 手里有这一场,报的人数就是它的(不在播的那份也是 —— 这一场还没等到下播信号)。
		if (current) notePeakTotalViewers(current, signal.details);
		// 报了不在播:出表;BN 不拿它猜下播(决策 53),这一场等下播信号来收。
		if (!signal.isLive) {
			opts.table.remove(id);
			announce({ kind: "status", subscriptionId: id, live: false, session: current });
			return;
		}
		const sourceKey = signal.identity.sourceKey;
		const startedAt = millisOf(signal.startedAt);
		opts.table.merge(id, sourceKey, startedAt, signal.details);
		if (current) {
			current.lastDetails = opts.table.get(id)?.details ?? current.lastDetails;
			current.startedAt ??= startedAt;
			announce({ kind: "status", subscriptionId: id, live: true, session: current });
			return;
		}
		// 没见过这一场的开播信号:BN 起来之前就开播了,或者来源停过又跑起来了。
		const session = begin(signal, sourceKey, startedAt);
		log.debug(`[ext-live] 订阅 ${id} 正在播,认出这一场`);
		announce({
			kind: "start",
			subscriptionId: id,
			session,
			trigger: "status-signal",
			details: signal.details,
		});
		publishStart(session, "liveStatus");
	}

	function onEnd(signal: EndSignal): void {
		const id = signal.subscriptionId;
		const sub = trackable(id);
		if (!sub) {
			log.debug(`[ext-live] 订阅 ${id} 已停用 / 已删 / 它的来源没在跑,这次下播不管`);
			return;
		}
		const endedAt = millisOf(signal.endedAt) ?? now();
		const session = sessions.get(id);
		// 下播:出表。出表之前先把最后那一份拿在手里(下播卡没带的格从这里补)。
		const lastRow = opts.table.get(id);
		opts.table.remove(id);
		const reportedStartedAt = millisOf(signal.startedAt);
		if (!session) {
			announce({
				kind: "unmatched-end",
				subscriptionId: id,
				at: endedAt,
				details: signal.details,
				reportedStartedAt,
			});
			return;
		}
		notePeakTotalViewers(session, signal.details);
		if (session.pendingEnd) {
			log.debug(`[ext-live] 订阅 ${id} 已经在断流等待里,这次下播忽略`);
			return;
		}
		session.lastDetails = lastRow?.details ?? session.lastDetails;
		const settings = opts.settings(sub);
		if (!settings.liveEndGrace) {
			end(id, "ended", endedAt, { startedAt: reportedStartedAt, details: signal.details });
			return;
		}
		// 断流接续(决策 58):先压着,期满这一场才结束;期间再开播就当同一场。
		const minutes = liveEndGraceMinutes(settings.liveEndGraceMinutes);
		session.pendingEnd = {
			endedAt,
			startedAt: reportedStartedAt,
			details: signal.details,
			handle: opts.timers.setTimeout(() => {
				const pending = session.pendingEnd;
				if (sessions.get(id) !== session || !pending) return;
				session.pendingEnd = undefined;
				log.info(`[ext-live] 订阅 ${id} 等了 ${minutes} 分钟没重新开播,这一场结束`);
				end(id, "ended", pending.endedAt, {
					startedAt: pending.startedAt,
					details: pending.details,
				});
			}, minutes * MINUTE),
		};
		log.info(`[ext-live] 订阅 ${id} 下播,进入 ${minutes} 分钟断流接续等待`);
		announce({ kind: "ending", subscriptionId: id, session });
	}

	const watches: Disposable[] = [
		// 来源停了(决策 61):它名下的全部当场结束,等着的下播不再等。重新跑起来后靠直播状态接上。
		opts.bus.on("extension-stopped", ({ extensionId }) => {
			for (const [id, session] of [...sessions]) {
				if (session.sourceKey === extensionId) end(id, "extension-stopped");
			}
		}),
		opts.bus.on("subscription-changed", ({ ops }) => {
			for (const op of ops) {
				if (op.kind === "remove") end(op.sub.id, "removed");
				else if (op.kind === "update" && !op.sub.enabled) end(op.sub.id, "disabled");
			}
		}),
	];

	return {
		get: (subscriptionId) => sessions.get(subscriptionId),
		apply(signal) {
			switch (signal.kind) {
				case "start":
					onStart(signal);
					return;
				case "status":
					onStatus(signal);
					return;
				case "end":
					onEnd(signal);
					return;
			}
		},
		onChange(listener) {
			listeners.add(listener);
			return {
				dispose() {
					listeners.delete(listener);
				},
			};
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const watch of watches) watch.dispose();
			for (const id of [...sessions.keys()]) end(id, "shutdown");
			listeners.clear();
		},
	};
}
