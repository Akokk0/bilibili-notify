import type {
	Disposable,
	ExtensionSubscription,
	Logger,
	MessageBus,
	ServiceContext,
	Subscription,
	SubscriptionReportValue,
} from "@bilibili-notify/internal";
import { liveEndGraceMinutes } from "@bilibili-notify/live";
import type { LiveWorkSettings } from "./engines.js";
import type { ExtensionLiveRow, ExtensionLiveTable } from "./extension-live.js";
import { extensionSubscriptionPushable } from "./extension-push-common.js";

/**
 * **拓展订阅的直播场次**(ADR-0020 决策 6;ADR-0019 决策 53 / 57 / 58 / 61):每条订阅此刻是哪一场、这一场
 * 从哪开始、到哪结束(含断流等待)。拓展直播的推送(`extension-live-push.ts`)吃这一份 —— 场次只算一遍,
 * 推送与别的消费方看到的是同一场。
 *
 * - **开播**:开播事件开一场(开播时刻取事件的);正处在断流等待里 → 取消等待,**同一场接着播**,开播时刻
 *   与粉丝基线沿用第一次的(决策 58)。上一场没报下播就又开播了 → 上一场在这儿收掉。
 * - **直播状态**:在播、手里又没有这一场 → 认出一场(BN 起来之前、或拓展停着的时候就开播了;开播时刻取状态
 *   带的,没带就空着,之后的状态带了再补上)。有这一场 → 把在播表里最新那一份记到这一场上。不在播 → 这一场
 *   不动:BN 不拿状态的翻转猜下播(决策 53)。
 * - **下播**只由事件触发(决策 53)。断流接续开着(按 UP 折好的 `liveEndGrace` / `liveEndGraceMinutes`)就先
 *   压着,等满了这一场才结束,结束时刻是**下播事件到达那一刻**(等的那几分钟不算);没开立刻结束。
 * - **作废**(决策 61):拓展停了、订阅停用 / 删了、关机 → 这一场当场结束,等着的下播不再等。
 *
 * 只记「订阅在、启用着、拓展在跑」的(与推送同一个判据,`extensionSubscriptionPushable`)。开播与下播推送
 * 都关着的不记 —— 与原来长在推送计时器里时一样。
 *
 * 只在内存:BN 重启之后靠拓展开机第一轮报的直播状态接上(决策 57 / 8)。
 */

type LiveStart = SubscriptionReportValue<"liveStart">;
type LiveEnd = SubscriptionReportValue<"liveEnd">;
type LiveStatus = SubscriptionReportValue<"liveStatus">;

const MINUTE = 60_000;

/** 一条订阅正在播的这一场。只读:场次只由这里改。 */
export interface ExtensionLiveSession {
	readonly subscriptionId: string;
	readonly extensionId: string;
	/**
	 * 开播时刻(毫秒)。开播事件必带;只见过直播状态时拓展报了才有 —— 之后的状态带了再补上。断流接续时
	 * 沿用第一次的。
	 */
	readonly startedAt?: number;
	/** BN 认出这一场的那一刻:开播事件、或认出它的那份在播状态到达时。 */
	readonly detectedAt: number;
	/** 开播时(或 BN 认出这一场时)资料里的粉丝数 —— 下播算粉丝数变化的基线(决策 56)。 */
	readonly fansAtStart?: number;
	/**
	 * 在播表里这一场最后一份。下播事件一到那一行就出表了,下播卡没带的格(标题、累计观看……)从这里补;
	 * 只是拿着那一行,不是另存的一份状态。
	 */
	readonly lastRow?: ExtensionLiveRow;
	/** 断流接续正在等的那次下播:下播事件到达的时刻与它带的格。 */
	readonly pendingEnd?: { readonly endedAt: number; readonly value: LiveEnd };
}

/** 一场为什么结束。 */
export type ExtensionLiveSessionEndReason =
	/** 拓展报了下播(断流接续开着的,等满了)。 */
	| "ended"
	/** 没报下播就又开播了,上一场在新的一场开播时收掉。 */
	| "superseded"
	/** 拓展停了(停用、卸载、换代码、崩了、关机时它先收摊)。 */
	| "extension-stopped"
	/** 订阅停用了。 */
	| "disabled"
	/** 订阅删了。 */
	| "removed"
	/** 开播与下播推送都关了。 */
	| "push-off"
	/** BN 关机。 */
	| "shutdown";

/**
 * 场次的每一次变化,按发生的顺序、同步地交给 {@link ExtensionLiveSessions.onChange} 的监听者。
 *
 * 除了一场的开始与结束,还有推送那头要的几样:断流等待里又开播了、又来一份直播状态、下播进了断流等待、
 * 下播事件来了手里却没有这一场。带着上报的原值,开播 / 下播卡要拿它出卡。
 */
export type ExtensionLiveSessionChange =
	| {
			type: "start";
			subscriptionId: string;
			session: ExtensionLiveSession;
			/** 认出这一场的是哪种上报:开播事件,或 BN 开始看之后见到的在播状态。 */
			trigger: "liveStart";
			value: LiveStart;
	  }
	| {
			type: "start";
			subscriptionId: string;
			session: ExtensionLiveSession;
			trigger: "liveStatus";
			value: LiveStatus;
	  }
	/** 断流等待里又开播了:同一场接着播(决策 58)。 */
	| { type: "resume"; subscriptionId: string; session: ExtensionLiveSession; value: LiveStart }
	/**
	 * 又一份直播状态(认出一场的那一份记作 `start`,不在这里)。在播的已经记到这一场上;不在播的不动这一场
	 * (`session` 是此刻那一场,可能没有)。
	 */
	| {
			type: "status";
			subscriptionId: string;
			live: boolean;
			session: ExtensionLiveSession | undefined;
	  }
	/** 下播事件到了,断流接续开着:进等待,这一场还没结束。 */
	| { type: "ending"; subscriptionId: string; session: ExtensionLiveSession }
	/** 这一场结束了。`at`:下播是下播事件到达的时刻,其余是结束的那一刻;`value`:下播事件带的格。 */
	| {
			type: "end";
			subscriptionId: string;
			session: ExtensionLiveSession;
			reason: ExtensionLiveSessionEndReason;
			at: number;
			value?: LiveEnd;
	  }
	/** 下播事件到了,手里却没有这一场(BN 中途重启过、拓展没报过状态)。 */
	| { type: "unmatched-end"; subscriptionId: string; at: number; value: LiveEnd };

export interface ExtensionLiveSessions extends Disposable {
	/** 这条订阅此刻那一场;没在播(或 BN 手里没有)就是 `undefined`。 */
	get(subscriptionId: string): ExtensionLiveSession | undefined;
	/** 听场次的变化。场次先改好,再按顺序同步通知。 */
	onChange(listener: (change: ExtensionLiveSessionChange) => void): Disposable;
}

export interface CreateExtensionLiveSessionsOptions {
	bus: MessageBus;
	logger: Logger;
	/** 在播表 —— 这一场最后一份状态从这里取(它先于这里听到同一份上报)。 */
	table: Pick<ExtensionLiveTable, "get">;
	/** 此刻的这条订阅(现取)。 */
	subscription(id: string): Subscription | undefined;
	/** 拓展此刻在不在跑(现取)。 */
	running(extensionId: string): boolean;
	/** 订阅资料里的粉丝数(资料缓存,现取)。 */
	fans(id: string): number | undefined;
	/** 这条订阅折好的直播设置(现折,见 `liveWorkSettings`):断流接续那两格,与两个直播推送开关。 */
	settings(
		sub: ExtensionSubscription,
	): Pick<LiveWorkSettings, "live" | "liveEnd" | "liveEndGrace" | "liveEndGraceMinutes">;
	/** 断流等待的定时器 —— 宿主的 ServiceContext(关机时一起清)。 */
	timers: Pick<ServiceContext, "setTimeout">;
	/** 只有测试会换。 */
	now?: () => number;
}

/** 场次在这里的样子:比对外多一个断流等待的定时器。 */
interface SessionState {
	subscriptionId: string;
	extensionId: string;
	startedAt?: number;
	detectedAt: number;
	fansAtStart?: number;
	lastRow?: ExtensionLiveRow;
	pendingEnd?: { endedAt: number; value: LiveEnd; handle: Disposable };
}

const REASON_TEXT: Record<ExtensionLiveSessionEndReason, string> = {
	ended: "下播",
	superseded: "没报下播就又开播了",
	"extension-stopped": "拓展停了",
	disabled: "订阅停用了",
	removed: "订阅删了",
	"push-off": "开播与下播推送都关了",
	shutdown: "关机",
};

export function createExtensionLiveSessions(
	opts: CreateExtensionLiveSessionsOptions,
): ExtensionLiveSessions {
	const log = opts.logger;
	const now = opts.now ?? Date.now;
	const sessions = new Map<string, SessionState>();
	const listeners = new Set<(change: ExtensionLiveSessionChange) => void>();
	let disposed = false;

	function announce(change: ExtensionLiveSessionChange): void {
		for (const listener of [...listeners]) listener(change);
	}

	/** 这条订阅现在记不记:还在、启用着、拓展在跑。关机之后一律不记。 */
	function trackable(id: string): ExtensionSubscription | undefined {
		if (disposed) return undefined;
		const sub = opts.subscription(id);
		return extensionSubscriptionPushable(sub, opts.running) ? sub : undefined;
	}

	/** 开播与下播推送都关着。 */
	function pushOff(sub: ExtensionSubscription): boolean {
		const settings = opts.settings(sub);
		return !settings.live && !settings.liveEnd;
	}

	/** 这一场结束。等着的下播不再等。 */
	function end(
		id: string,
		reason: ExtensionLiveSessionEndReason,
		at: number = now(),
		value?: LiveEnd,
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
		announce({ type: "end", subscriptionId: id, session, reason, at, value });
	}

	function begin(
		id: string,
		sub: ExtensionSubscription,
		startedAt: number | undefined,
	): SessionState {
		const session: SessionState = {
			subscriptionId: id,
			extensionId: sub.extensionId,
			startedAt,
			detectedAt: now(),
			fansAtStart: opts.fans(id),
			lastRow: opts.table.get(id),
		};
		sessions.set(id, session);
		return session;
	}

	function onLiveStart(id: string, value: LiveStart): void {
		const sub = trackable(id);
		if (!sub) {
			log.debug(`[ext-live] 订阅 ${id} 已停用 / 已删 / 它的拓展没在跑,这次开播不管`);
			return;
		}
		if (pushOff(sub)) {
			end(id, "push-off");
			return;
		}
		const current = sessions.get(id);
		if (current?.pendingEnd) {
			// 断流接续(决策 58):同一场。取消等待,开播时刻与粉丝基线沿用第一次的。
			current.pendingEnd.handle.dispose();
			current.pendingEnd = undefined;
			current.lastRow = opts.table.get(id) ?? current.lastRow;
			log.debug(`[ext-live] 订阅 ${id} 断流后重新开播,接续为同一场`);
			announce({ type: "resume", subscriptionId: id, session: current, value });
			return;
		}
		// 新的一场。上一场没报下播的话,在这儿收掉。
		end(id, "superseded");
		const session = begin(id, sub, value.startedAt);
		announce({ type: "start", subscriptionId: id, session, trigger: "liveStart", value });
	}

	function onLiveStatus(id: string, value: LiveStatus): void {
		const sub = trackable(id);
		if (!sub) return;
		if (pushOff(sub)) return;
		const current = sessions.get(id);
		// 报了不在播:BN 不拿它猜下播(决策 53),这一场等下播事件来收。
		if (!value.live) {
			announce({ type: "status", subscriptionId: id, live: false, session: current });
			return;
		}
		if (current) {
			current.lastRow = opts.table.get(id) ?? current.lastRow;
			current.startedAt ??= value.startedAt;
			announce({ type: "status", subscriptionId: id, live: true, session: current });
			return;
		}
		// 没见过这一场的开播事件:BN 起来之前就开播了,或者拓展停过又跑起来了。
		const session = begin(id, sub, value.startedAt);
		log.debug(`[ext-live] 订阅 ${id} 正在播,认出这一场`);
		announce({ type: "start", subscriptionId: id, session, trigger: "liveStatus", value });
	}

	function onLiveEnd(id: string, value: LiveEnd): void {
		const sub = trackable(id);
		if (!sub) {
			log.debug(`[ext-live] 订阅 ${id} 已停用 / 已删 / 它的拓展没在跑,这次下播不管`);
			return;
		}
		if (pushOff(sub)) {
			end(id, "push-off");
			return;
		}
		const endedAt = now();
		const session = sessions.get(id);
		if (!session) {
			announce({ type: "unmatched-end", subscriptionId: id, at: endedAt, value });
			return;
		}
		if (session.pendingEnd) {
			log.debug(`[ext-live] 订阅 ${id} 已经在断流等待里,这次下播忽略`);
			return;
		}
		session.lastRow = opts.table.get(id) ?? session.lastRow;
		const settings = opts.settings(sub);
		if (!settings.liveEndGrace) {
			end(id, "ended", endedAt, value);
			return;
		}
		// 断流接续(决策 58):先压着,期满这一场才结束;期间再开播就当同一场。
		const minutes = liveEndGraceMinutes(settings.liveEndGraceMinutes);
		session.pendingEnd = {
			endedAt,
			value,
			handle: opts.timers.setTimeout(() => {
				const pending = session.pendingEnd;
				if (sessions.get(id) !== session || !pending) return;
				session.pendingEnd = undefined;
				log.info(`[ext-live] 订阅 ${id} 等了 ${minutes} 分钟没重新开播,这一场结束`);
				end(id, "ended", pending.endedAt, pending.value);
			}, minutes * MINUTE),
		};
		log.info(`[ext-live] 订阅 ${id} 下播,进入 ${minutes} 分钟断流接续等待`);
		announce({ type: "ending", subscriptionId: id, session });
	}

	/** 设置可能变了:开播与下播推送都关了的,这一场不再记。 */
	function reconcile(id: string): void {
		const sub = sessions.has(id) ? trackable(id) : undefined;
		if (sub && pushOff(sub)) end(id, "push-off");
	}

	const watches: Disposable[] = [
		opts.bus.on("subscription-reported", (delivery) => {
			const { report } = delivery;
			for (const id of delivery.subscriptionIds) {
				switch (report.kind) {
					case "liveStart":
						onLiveStart(id, report.value);
						break;
					case "liveStatus":
						onLiveStatus(id, report.value);
						break;
					case "liveEnd":
						onLiveEnd(id, report.value);
						break;
					default:
						// 作品、资料更新与场次无关。
						return;
				}
			}
		}),
		// 拓展停了(决策 61):它名下的全部当场结束,等着的下播不再等。重新跑起来后靠直播状态接上。
		opts.bus.on("extension-stopped", (extensionId) => {
			for (const [id, session] of [...sessions]) {
				if (session.extensionId === extensionId) end(id, "extension-stopped");
			}
		}),
		opts.bus.on("subscription-changed", (ops) => {
			for (const op of ops) {
				if (op.type === "remove") end(op.sub.id, "removed");
				else if (op.type === "update") {
					if (op.sub.enabled) reconcile(op.sub.id);
					else end(op.sub.id, "disabled");
				}
			}
		}),
		opts.bus.on("config-changed", (scope) => {
			if (scope !== "globals") return;
			for (const id of [...sessions.keys()]) reconcile(id);
		}),
	];

	return {
		get: (subscriptionId) => sessions.get(subscriptionId),
		onChange(listener) {
			listeners.add(listener);
			return { dispose: () => listeners.delete(listener) };
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
