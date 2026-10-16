/**
 * **特别弹幕 / 特别进场的装配**:名单里的人发了弹幕 / 进了场 → 套文案 → 交一条文字。
 *
 * 中立:吃中立的观众 `{ id, name }`、这条订阅折好的那一格设置与主播名,不认 uid、房号、B 站的视图。
 * 发送由调用方绑到这条订阅上(推给谁、包成哪种消息、引擎拆了发不发都归绑的那一方),这里只交一句
 * 渲染好的文字。B 站那边只负责把帧翻成这些值、绑好发送。
 */

import { renderViewerChat, renderViewerEnter } from "./live-text";
import type {
	CustomSpecialDanmakuUsersLike,
	CustomSpecialUsersEnterTheRoomLike,
} from "./live-types";

export interface ViewerChatOptions {
	/** 发弹幕的观众。`id` 是字符串(名单里存的就是字符串),比对时整串相等。 */
	viewer: { id: string; name: string };
	/** 弹幕正文。 */
	text: string;
	/** 这条订阅折好的「特别弹幕」那一格。 */
	settings: CustomSpecialDanmakuUsersLike;
	/** 主播;名字拿不到给空串。 */
	creator: { name: string };
}

export interface ViewerEnterOptions {
	/** 进场的观众。 */
	viewer: { id: string; name: string };
	/** 这条订阅折好的「特别进场」那一格。 */
	settings: CustomSpecialUsersEnterTheRoomLike;
	/** 主播;名字拿不到给空串。 */
	creator: { name: string };
}

export interface SpecialViewerDeps {
	/** 绑到这条订阅上的发送:收一句渲染好的文字。 */
	send: (text: string) => void;
}

/** 特别弹幕:开关开着、观众在名单里,才交出一句。不按推送目标挡(没配目标由推送层记成「无目标」)。 */
export function pushViewerChat(options: ViewerChatOptions, deps: SpecialViewerDeps): void {
	const { viewer, text, settings, creator } = options;
	if (!settings.enable) return;
	if (!settings.specialDanmakuUsers?.includes(viewer.id)) return;
	deps.send(
		renderViewerChat({
			template: settings.msgTemplate,
			viewerName: viewer.name,
			creatorName: creator.name,
			text,
		}),
	);
}

/** 特别进场:同上。 */
export function pushViewerEnter(options: ViewerEnterOptions, deps: SpecialViewerDeps): void {
	const { viewer, settings, creator } = options;
	if (!settings.enable) return;
	if (!settings.specialUsersEnterTheRoom?.includes(viewer.id)) return;
	deps.send(
		renderViewerEnter({
			template: settings.msgTemplate,
			viewerName: viewer.name,
			creatorName: creator.name,
		}),
	);
}
