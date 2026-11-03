import { formatCount } from "@bilibili-notify/internal";
import { t as serverText } from "../i18n/index.js";
import { renderTemplate } from "../util/render-template";

/**
 * Plain string-substitution based template renderer for live-related notification
 * text. Mirrors the per-occurrence templates of the live push:
 *
 * - `customLiveStart` / `customLiveStreaming` / `customLiveEnd`
 * - `specialViewerChat.template`
 * - `specialViewerEnter.template`
 */

/**
 * 「特别弹幕」那一句:模板套上中立的值。占位符:`name`(主播名)/ `viewer`(发弹幕的人)/ `msg`(弹幕正文)。
 * 0.x 起的 `mastername` / `uname` 由迁移改写成这两个(3b-21)。
 */
export function renderViewerChat(params: {
	template: string;
	viewerName: string;
	creatorName: string;
	text: string;
}): string {
	return renderTemplate(params.template, {
		name: params.creatorName,
		viewer: params.viewerName,
		msg: params.text,
	});
}

/** 「特别进场」那一句:占位符 `name` / `viewer`。 */
export function renderViewerEnter(params: {
	template: string;
	viewerName: string;
	creatorName: string;
}): string {
	return renderTemplate(params.template, {
		name: params.creatorName,
		viewer: params.viewerName,
	});
}

/**
 * 「弹幕总结」那一句(AI 总结用不了时的模板兜底)。占位符:`{dmc}`(发言人数)、`{fanclub}`(粉丝团名字)、`{dca}`(弹幕总数)、
 * `{un1..5}`(发言最多的几位)、`{dc1..5}`(各自的条数)。
 */
export function renderLiveSummary(params: {
	template: string;
	senderCount: number;
	/** 粉丝团的名字;没有(平台没有粉丝团,或还不知道)就缺着,`{fanclub}` 填空串。 */
	fanClubName?: string;
	viewerChatCount: number;
	topSenders: Array<[string, number]>;
}): string {
	const top = params.topSenders;
	// 公共导出:topSenders 可能 <5(直播弹幕发送者不足 5 人)。此前无条件
	// 索引 top[0..4] 在 <5 时直接 `undefined[0]` 抛 TypeError;缺位安全降级
	// 为空名 / 0 条。
	const at = (i: number): [string, number] => top[i] ?? ["", 0];
	return renderTemplate(params.template, {
		dmc: `${params.senderCount}`,
		fanclub: params.fanClubName ?? "",
		dca: `${params.viewerChatCount}`,
		un1: at(0)[0],
		dc1: `${at(0)[1]}`,
		un2: at(1)[0],
		dc2: `${at(1)[1]}`,
		un3: at(2)[0],
		dc3: `${at(2)[1]}`,
		un4: at(3)[0],
		dc4: `${at(3)[1]}`,
		un5: at(4)[0],
		dc5: `${at(4)[1]}`,
	});
}

/** 三句直播文案:开播 / 正在直播(周期推送、重启补报)/ 下播。 */
export type LiveTextKind = "liveStart" | "liveStreaming" | "liveEnd";

/**
 * 三句直播文案的变量,**中立的值**(ADR-0019 决策 65 / 67)—— 推送这头从场次详情与订阅资料
 * 取值填它。数字由渲染排成「1.2万」(粉丝数变化带正负号),平台给的成品文字原样;没有的格子空着
 * (决策 56:来源没报过资料,粉丝那一格就空着)。
 */
export interface LiveTextInput {
	/** `{name}`。 */
	name: string;
	/** `{time}`:开播到此刻(下播:到下播那一刻)播了多久,已经排好的一句。 */
	time: string;
	/** `{follower}`(开播):当前粉丝数。 */
	follower?: number | string;
	/** `{watched}`(正在直播):本场累计观看,精确数。缺了(一帧都没收到 / 来源没报)由 {@link renderLiveText} 在出口印「暂未获取到」。 */
	watched?: number;
	/** `{follower_change}`(下播):本场粉丝数变化。 */
	followerChange?: number | string;
}

/** `{watched}` 缺数时印的那句。 */
const watchedUnknownText = () => serverText("service.live.live-text.text.1");

/** 数字按 `format` 排,文字原样,没有就空串。 */
function textOf(v: number | string | undefined, format: (n: number) => string): string {
	return typeof v === "number" ? format(v) : (v ?? "");
}

/**
 * **三句直播文案的中立渲染**:把调用方给的模板套上中立的值。
 *
 * 每一种只认自己那几个变量 —— 开播:`{name}` `{time}` `{follower}`;正在直播:`{name}` `{time}`
 * `{watched}`;下播:`{name}` `{time}` `{follower_change}`。别的原样留在文案里(与从前 B 站那三句一样,
 * 主人在开播模板里写了 `{watched}`,看到的就是字面的 `{watched}`)。
 */
export function renderLiveText(
	kind: LiveTextKind,
	template: string,
	values: LiveTextInput,
): string {
	const vars: Record<string, string> = { name: values.name, time: values.time };
	switch (kind) {
		case "liveStart":
			vars.follower = textOf(values.follower, (n) => formatCount(n));
			break;
		case "liveStreaming":
			// 缺数时的「暂未获取到」只在这里(文字出口)印,不写回直播数据。
			vars.watched =
				values.watched === undefined ? watchedUnknownText() : formatCount(values.watched);
			break;
		case "liveEnd":
			vars.follower_change = textOf(values.followerChange, (n) => formatCount(n, { signed: true }));
			break;
	}
	return renderTemplate(template, vars);
}
