/**
 * **直播装配**(ADR-0019 决策 65 / 67):一张直播卡从出卡到交出去的那一段 —— 出卡 → 按版式
 * 把卡片 / 文案 / 链接分组 → 交给绑到这条订阅上的发送。
 *
 * 中立:吃中立的直播卡输入({@link LiveCardInput}),不认 uid、不认 B 站的房间数据。
 * - B 站:`RoomContext.sendLiveNotifyCard` 先把接口数据翻成输入(`biliLiveCardInput`)、把
 *   「按 uid 推」绑成发送,再调它。
 * - 拓展订阅的直播:宿主拿事件与订阅资料拼输入、把「按订阅 id 推」绑成发送,再调它。
 *
 * **什么时候推不在这里**(计时器、断流接续、串行闸):两边各管各的,决策 67。
 */

import type { ImageRenderer, LiveCardInput } from "@bilibili-notify/image";
import {
	assembleMessageGroups,
	type Logger,
	type MessageKindLayout,
	type MessageLayoutSegment,
} from "@bilibili-notify/internal";
import type { CustomCardStyleLike, LiveBroadcastOptions, LivePushType } from "./push-like";

/** 直播卡的三种推送:开播 / 直播中(周期「正在直播」、重启补推)/ 下播。 */
export type LiveNotifyPushType =
	| LivePushType.StartBroadcasting
	| LivePushType.Live
	| LivePushType.LiveEnd;

/**
 * 绑到这条订阅上的发送。装配只交「推什么」:按版式分好的消息组(至少一组;一组是一条消息,
 * 由中立的图片 / 文字段组成)、推送类型、这次推送的选项。推给谁、翻成哪个平台的消息、
 * 一条还是一串,都归绑定的那一方。
 */
export type LiveNotifySend = (
	groups: MessageLayoutSegment[][],
	type: LiveNotifyPushType,
	opts: LiveBroadcastOptions,
) => Promise<void>;

export interface LiveNotifyParams {
	/** 卡上画什么。 */
	input: LiveCardInput;
	/** 文字部件(模板已经渲染好的文案)。 */
	text: string;
	/** 链接部件(裸链接)。没有就空串。 */
	link: string;
	/** 这条订阅折好的消息版式(直播那一份)。 */
	layout: MessageKindLayout;
	/** 这条订阅折好的直播卡样式;没启用(`enable` 为假)= 吃渲染器的全局配置。 */
	cardStyle?: CustomCardStyleLike;
	/** 这张卡用哪套皮肤(ADR-0014);不给 = 内置默认。 */
	cardSkin?: string;
	pushType: LiveNotifyPushType;
	/** 见 {@link LiveBroadcastOptions.pushId}:下播卡传它,附加项才能追加到同一行。 */
	pushId?: string;
	/** 日志里怎么称呼这条订阅(比如 `uid=…`、`sub=…`)。 */
	label: string;
}

export interface LiveNotifyDeps {
	/** 出卡的渲染器。null / 不给 = 不出卡(关了出图、渲染服务没起来),只发文字。 */
	renderer?: Pick<ImageRenderer, "generateNeutralLiveCard"> | null;
	send: LiveNotifySend;
	logger: Logger;
}

/**
 * 出卡 → 分组 → 发送。出卡失败降级为只发文字;所有部件都藏起来或缺席就整条不发。
 * 发送途中的失败原样往外抛,由调用方决定怎么办。
 */
export async function pushLiveNotify(
	params: LiveNotifyParams,
	deps: LiveNotifyDeps,
): Promise<void> {
	const { layout } = params;
	// 版式里 card 块隐藏 → 连图片渲染都跳过(白渲染更亏)。
	const wantCard = layout.blocks.some((b) => b.visible && b.type === "card");

	let card: Buffer | undefined;
	if (deps.renderer && wantCard) {
		try {
			card = await deps.renderer.generateNeutralLiveCard(params.input, {
				// 样式没启用 = 吃渲染器的全局配置;皮肤 id 与它无关,恒要带上。
				...(params.cardStyle?.enable ? params.cardStyle : undefined),
				cardSkin: params.cardSkin,
			});
		} catch (e) {
			deps.logger.error(`[image] 生成直播图片失败：${(e as Error).message}，降级为文字推送`);
		}
	}

	// 隐藏的块由 `assembleMessageGroups` 自己剔掉,这里照值交。
	const groups = assembleMessageGroups(layout, { card, text: params.text, link: params.link });
	if (groups.length === 0) {
		deps.logger.debug(`[push] ${params.label} 消息版式所有部件隐藏/缺失,本次不推送`);
		return;
	}
	await deps.send(groups, params.pushType, { pushId: params.pushId });
}
