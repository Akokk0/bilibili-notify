/**
 * **B 站直播接口数据 → 中立的直播卡输入**(ADR-0019 决策 65 / 68)。
 *
 * 只此一份:出卡入口的 B 站适配层(`ImageRenderer.generateLiveCard`)与直播引擎的推送
 * (`@bilibili-notify/live` 的 `RoomContext.sendLiveNotifyCard`)都调它,再各自把
 * {@link LiveCardInput} 交给中立的那一头 —— 两边各翻一份的话,迟早出现「预览是这样、
 * 推出去是那样」。
 */

import { DateTime } from "luxon";
import { htmlToPlain } from "./html-to-plain";
import { LIVE_TIME_FORMAT, LIVE_TIME_ZONE } from "./live-view";
import type { LiveCardInput, LiveCardStatus } from "./templates/live-card";
import type { LiveData } from "./types";

/**
 * B 站给卡片的状态码 → 明写的状态。直播引擎传 `LiveType`,私聊指令传接口原值(0 没在播 /
 * 1 在播),两套在 0 ~ 3 上恰好对得上。
 */
const BILI_LIVE_STATUS: Record<number, LiveCardStatus> = {
	0: "offline",
	1: "start",
	2: "streaming",
	3: "end",
};

/** B 站 `live_time`(北京时间字符串)→ 毫秒时间戳;缺失或解析不出时 undefined。 */
function parseBiliLiveTime(raw: unknown): number | undefined {
	if (typeof raw !== "string" || raw === "") return undefined;
	const at = DateTime.fromFormat(raw, LIVE_TIME_FORMAT, { zone: LIVE_TIME_ZONE });
	return at.isValid ? at.toMillis() : undefined;
}

/**
 * **B 站那头 → 中立的直播卡输入**。卡上画什么全在这一步定好:
 *
 * - 封面:直播中先用关键帧(实时画面),开播 / 下播 / 没在播先用房间封面;**先取的那张没有,
 *   拿另一张兜** —— 没开播时 B 站给的关键帧是空串,刚开播时关键帧也常常还没生成。两张都
 *   没有就不给,出卡那头画占位图(`buildLiveCardView`)。
 * - 其余状态码(比如 4 首次开播,今天没有调用方传进出卡)照旧画成「直播中」角标、不写那句
 *   时间、先用房间封面 —— 与从前的默认分支一个样。
 * - 简介是富文本(可能带 `<p>` / `<br>` 或 entity-encoded 形式),先剥成纯文本。
 *
 * @param data B 站直播间接口的 `data`(`getLiveRoomInfo`)。
 * @param liveStatus 见 {@link BILI_LIVE_STATUS}。
 */
export function biliLiveCardInput(
	// biome-ignore lint/suspicious/noExplicitAny: Bilibili 直播 API 返回类型
	data: any,
	username: string,
	userface: string,
	liveData: LiveData,
	liveStatus: number,
): LiveCardInput {
	const known = BILI_LIVE_STATUS[liveStatus];
	const status = known ?? "start";
	const text = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
	const keyframe = text(data?.keyframe);
	const roomCover = text(data?.user_cover);
	return {
		status,
		author: { name: username, face: userface },
		title: text(data?.title),
		area: text(data?.area_name),
		description: htmlToPlain(text(data?.description)),
		cover: (status === "streaming" ? keyframe || roomCover : roomCover || keyframe) || undefined,
		startedAt: known ? parseBiliLiveTime(data?.live_time) : undefined,
		online: +(data?.online ?? 0),
		likes: liveData.likedNum,
		totalViewers: liveData.watchedNum,
		fans: liveData.fansNum,
		fansChanged: liveData.fansChanged,
	};
}
