/**
 * **特别弹幕 / 特别进场的装配**:名单里的人发了弹幕 / 进了场 → 套文案 → 交一条文字。
 *
 * 中立:吃中立的观众 `{ id, name }`、这条订阅的特别关注名单与文案、主播,不认 uid、房号、B 站的视图。
 * 名单条目按观众 id 整串比对,并且要带这一把特性键(`viewerChat` / `viewerEnter`)才触发。
 * 发送由调用方绑到这条订阅上(推给谁、包成哪种消息、引擎拆了发不发都归绑的那一方),这里只交一句
 * 渲染好的文字。B 站那边只负责把帧翻成这些值、绑好发送。
 */

import type { SpecialViewer } from "@bilibili-notify/internal";
import { renderViewerChat, renderViewerEnter } from "./live-text";
import type { SpecialViewerSettings } from "./live-types";

export interface ViewerChatOptions {
	/** 发弹幕的观众。`id` 是字符串(名单里存的就是字符串),比对时整串相等。 */
	viewer: { id: string; name: string };
	/** 弹幕正文。 */
	text: string;
	/** 这条订阅的特别关注名单与「特别弹幕」文案。 */
	settings: SpecialViewerSettings;
	/** 主播;名字拿不到给空串。 */
	creator: { name: string };
}

export interface ViewerEnterOptions {
	/** 进场的观众。 */
	viewer: { id: string; name: string };
	/** 这条订阅的特别关注名单与「特别进场」文案。 */
	settings: SpecialViewerSettings;
	/** 主播;名字拿不到给空串。 */
	creator: { name: string };
}

export interface SpecialViewerDeps {
	/** 绑到这条订阅上的发送:收一句渲染好的文字。 */
	send: (text: string) => void;
}

/** 名单上有没有这位观众、并且他带着这一把特性键。 */
function listed(
	viewers: readonly SpecialViewer[],
	id: string,
	feature: SpecialViewer["features"][number],
): boolean {
	return viewers.some((v) => v.id === id && v.features.includes(feature));
}

/** 特别弹幕:观众在名单里、带着 `viewerChat`,才交出一句。不按推送目标挡(没配目标由推送层记成「无目标」)。 */
export function pushViewerChat(options: ViewerChatOptions, deps: SpecialViewerDeps): void {
	const { viewer, text, settings, creator } = options;
	if (!listed(settings.specialViewers, viewer.id, "viewerChat")) return;
	deps.send(
		renderViewerChat({
			template: settings.template,
			viewerName: viewer.name,
			creatorName: creator.name,
			text,
		}),
	);
}

/** 特别进场:同上,带着 `viewerEnter`。 */
export function pushViewerEnter(options: ViewerEnterOptions, deps: SpecialViewerDeps): void {
	const { viewer, settings, creator } = options;
	if (!listed(settings.specialViewers, viewer.id, "viewerEnter")) return;
	deps.send(
		renderViewerEnter({
			template: settings.template,
			viewerName: viewer.name,
			creatorName: creator.name,
		}),
	);
}
