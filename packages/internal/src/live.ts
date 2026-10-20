/**
 * 直播的中立形状(形状全文在 `docs/1.0/data-model.md`「直播」)。
 *
 * 来源把「一场直播发生了什么」报成 {@link LiveSignalReport},核心按身份展开成每条订阅一份
 * {@link LiveSignal}、喂给场次引擎;在播表的行装的就是 {@link LiveDetails}。核心不认识任何平台:
 * 图一律是图库引用({@link PostImage}),来源先存进图库再交。
 */

import type { Identity } from "./constants";
import type { ViewerChatEvent, ViewerEnterEvent } from "./membership";
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

/**
 * 来源推送式上报的直播信号:发生了就报,`reportLive(externalId, signal)`。时刻一律是 ISO。
 *
 * ⚠️ `status` 与 `end` 上的 `startedAt` 是对 data-model 的补充(待回写):拓展的直播状态、下播本来就能带开播时刻
 * (BN 认出一场时拿它当时长的起点;下播时手里没有这一场,下播卡的时长靠它),形状里没有就丢了。
 */
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
 * 来源经 `reportLiveInteraction(externalId, report)` 上报的观众互动:形状是对应事件去掉 `subscriptionId`
 * (订阅 id 来源不知道,核心按身份展开成每条订阅一份时补上)。本提交开 `viewerChat`、`viewerEnter`,
 * 醒目留言、会员随后追加。
 */
export type LiveInteractionReport =
	| ({ kind: "viewerChat" } & Omit<ViewerChatEvent, "subscriptionId">)
	| ({ kind: "viewerEnter" } & Omit<ViewerEnterEvent, "subscriptionId">);

/** 核心按身份展开后喂给场次引擎的:每条订阅一份。 */
export type LiveSignal = LiveSignalReport & { subscriptionId: string; identity: Identity };
