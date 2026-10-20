/**
 * 直播的中立形状(形状全文在 `docs/1.0/data-model.md`「直播」)。
 *
 * 来源把「一场直播发生了什么」报成 {@link LiveSignalReport},核心按身份展开成每条订阅一份
 * {@link LiveSignal}、喂给场次引擎;在播表的行装的就是 {@link LiveDetails}。核心不认识任何平台:
 * 图一律是图库引用({@link PostImage}),来源先存进图库再交。
 */

import type { Identity } from "./constants";
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

/** 核心按身份展开后喂给场次引擎的:每条订阅一份。 */
export type LiveSignal = LiveSignalReport & { subscriptionId: string; identity: Identity };
