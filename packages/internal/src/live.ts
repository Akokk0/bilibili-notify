/**
 * 直播的中立形状(形状全文在 `docs/1.0/data-model.md`「直播」)。
 *
 * 来源把「一场直播发生了什么」报成 {@link LiveSignalReport},核心按身份展开成每条订阅一份
 * {@link LiveSignal}、喂给场次引擎;在播表的行装的就是 {@link LiveDetails}。核心不认识任何平台:
 * 图一律是图库引用({@link PostImage}),来源先存进图库再交。
 */

import type { Identity } from "./constants";
import type {
	MembershipEvent,
	SuperchatEvent,
	ViewerChatEvent,
	ViewerEnterEvent,
} from "./membership";
import type { Creator, PostImage } from "./post";

/** 一场直播的内容。 */
export interface LiveDetails {
	title?: string;
	cover?: PostImage;
	category?: string;
	url?: string;
	/** 此刻在线。 */
	currentViewers?: number;
	/** 本场累计观看。 */
	totalViewers?: number;
	likes?: number;
	description?: string;
	creator?: Creator;
}

/** 来源推送式上报的直播信号:发生了就报,`reportLive(externalId, signal)`。时刻一律是 ISO。 */
export type LiveSignalReport =
	| { kind: "start"; startedAt?: string; details: LiveDetails }
	| { kind: "status"; isLive: boolean; startedAt?: string; details: LiveDetails }
	| { kind: "end"; endedAt: string; startedAt?: string; details?: LiveDetails };

/**
 * 拉取式:核心定时问来源 `fetchLiveStatus` 的结果(ADR-0026 决策 4;ADR-0021 决策 27)。
 *
 * - `live`:此刻在播,带数据(核心记进在播表,周期「正在直播」开着才推卡);
 * - `offline`:此刻没在播,核心当成漏收的下播,走下播同一条路,时长算到「发现已下播的那一刻」;
 * - `ok: false`:这一轮没取到 —— 核心跳过、记日志,**不停止监听、也不替来源报问题**(问题来源自己经
 *   `ctx.reportProblem` 报)。
 */
export type LiveStatusResult =
	| { ok: true; kind: "live"; startedAt?: string; details: LiveDetails }
	| { ok: true; kind: "offline" }
	| { ok: false; code: string; message: string };

/**
 * 一场为什么结束。`poll` 是核心问 `fetchLiveStatus` 发现已经下播(漏收的下播,时长算到发现的那一刻),
 * 其余是来源或宿主报告的实际边界。
 */
export type LiveSessionEndReason =
	| "ended"
	| "superseded"
	| "extension-stopped"
	| "disabled"
	| "removed"
	| "shutdown"
	| "poll";

/** 这一场收到的互动汇总;没有收到的那一种不写。 */
export interface LiveSessionInteractions {
	/** 这一场收到的弹幕条数。 */
	readonly viewerChatCount?: number;
	/** 发过弹幕的人数,按观众 id 去重。 */
	readonly viewerChatSenderCount?: number;
	/** 醒目留言条数。 */
	readonly superchatCount?: number;
	/** 币种 → 这一场的醒目留言总额(金额单位同 `SuperchatEvent.amount`)。 */
	readonly superchatTotals?: Record<string, number>;
	/** 体系 id → 档 key → 新增会员数。 */
	readonly membershipCounts?: Record<string, Record<string, number>>;
}

/**
 * 核心记着的一条订阅正在播的这一场。只读:场次只由场次引擎改;交出引擎时只带纯数据,不带内部计时器。
 */
export interface LiveSession {
	readonly subscriptionId: string;
	readonly sourceKey: string;
	/**
	 * 开播时刻(ISO)。开播信号带了才有;只见过直播状态时来源报了才有 —— 之后的状态带了再补上。断流接续时
	 * 沿用第一次的。
	 */
	readonly startedAt?: string;
	/** BN 认出这一场的那一刻(ISO):开播信号、或认出它的那份在播状态到达时。 */
	readonly detectedAt: string;
	/** 开播时(或 BN 认出这一场时)资料里的粉丝数 —— 下播算粉丝数变化的基线(决策 56)。 */
	readonly followersAtStart?: number;
	/**
	 * 这一场里(开播、直播状态、下播)报过的**最大累计观看**(ADR-0020 决策 7)。累计只增不减,最大的就是本场
	 * 最后那个累计数;断流接续是同一场,接着取;新的一场从头取。只认 `totalViewers`,此刻在线不算。一次都没报过
	 * 就没有。结束帧带着它给统计当这一场的峰值。
	 */
	readonly peakTotalViewers?: number;
	/** 这一场收到的互动汇总;一条互动都没记过就没有。 */
	readonly interactions?: LiveSessionInteractions;
	/**
	 * 在播表里这一场最后一份。下播信号一到那一行就出表了,下播卡没带的格(标题、累计观看……)从这里补;
	 * 只是拿着那一行的内容,不是另存的一份状态。
	 */
	readonly lastDetails?: LiveDetails;
	/** 断流接续正在等的那次下播:信号带的下播时刻(ISO)与它带的格。 */
	readonly pendingEnd?: {
		readonly endedAt: string;
		readonly startedAt?: string;
		readonly details?: LiveDetails;
	};
}

/**
 * 场次的每一次变化,按发生的顺序、同步地交给场次引擎的监听者。
 *
 * 除了一场的开始与结束,还有推送那头要的几样:断流等待里又开播了、又来一份直播状态、下播进了断流等待、
 * 下播信号来了手里却没有这一场。带着信号的详情,开播 / 下播卡要拿它出卡。
 */
export type LiveSessionChange =
	| {
			kind: "start";
			subscriptionId: string;
			session: LiveSession;
			/**
			 * 认出这一场的是什么:开播信号、BN 开始看之后见到的在播状态,或核心问 `fetchLiveStatus`
			 * (重启、来源登记、订阅开始监听时)问到的在播。
			 */
			trigger: "start-signal" | "status-signal" | "poll";
			details: LiveDetails;
	  }
	/** 按这一场自己的时钟问了来源一次,还在播(`fetchLiveStatus`):在播表已换上新的格。 */
	| { kind: "tick"; subscriptionId: string; session: LiveSession }
	/** 断流等待里又开播了:同一场接着播(决策 58)。 */
	| { kind: "resume"; subscriptionId: string; session: LiveSession; details: LiveDetails }
	/**
	 * 又一份直播状态(认出一场的那一份记作 `start`,不在这里)。在播的已经记到这一场上;不在播的不动这一场
	 * (`session` 是此刻那一场,可能没有)。
	 */
	| {
			kind: "status";
			subscriptionId: string;
			isLive: boolean;
			session: LiveSession | undefined;
	  }
	/** 下播信号到了,断流接续开着:进等待,这一场还没结束。 */
	| { kind: "ending"; subscriptionId: string; session: LiveSession }
	/**
	 * 这一场结束了。`endedAt`:下播是信号带的下播时刻,其余是结束的那一刻;`details` / `reportedStartedAt`:下播信号
	 * 带的格与开播时刻(ISO)。
	 */
	| {
			kind: "end";
			subscriptionId: string;
			session: LiveSession;
			reason: LiveSessionEndReason;
			endedAt: string;
			details?: LiveDetails;
			reportedStartedAt?: string;
	  }
	/** 下播信号到了,手里却没有这一场(BN 中途重启过、来源没报过状态)。 */
	| {
			kind: "unmatched-end";
			subscriptionId: string;
			endedAt: string;
			details?: LiveDetails;
			reportedStartedAt?: string;
	  };

/**
 * 来源经 `reportLiveInteraction(externalId, report)` 上报的观众互动:形状是对应事件去掉 `subscriptionId`
 * (订阅 id 来源不知道,核心按身份展开成每条订阅一份时补上)。四种:特别弹幕、特别进场、醒目留言、会员。
 *
 * `fallbackText`:出不了卡时发的那句;来源给了就用它(平台自己的叫法由来源拼好),没给就用核心字典里一句中性的。
 */
export type LiveInteractionReport =
	| ({ kind: "viewerChat" } & Omit<ViewerChatEvent, "subscriptionId">)
	| ({ kind: "viewerEnter" } & Omit<ViewerEnterEvent, "subscriptionId">)
	| ({ kind: "superchat" } & Omit<SuperchatEvent, "subscriptionId"> & {
				fallbackText?: string;
			})
	| ({ kind: "membership" } & Omit<MembershipEvent, "subscriptionId"> & {
				fallbackText?: string;
			});

/** 核心按身份展开后喂给场次引擎的:每条订阅一份。 */
export type LiveSignal = LiveSignalReport & { subscriptionId: string; identity: Identity };
