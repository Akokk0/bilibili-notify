/**
 * **醒目留言的装配**:过门槛 → 取观众头像 → 出卡 → 交出去;出不了卡退一句文字。
 *
 * 中立:吃中立的 {@link SuperchatEvent}(档位已经算好)、这条订阅折好的门槛与卡样式、主播的名字与头像,不认 uid、房号、
 * B 站的视图。观众头像怎么取、发送怎么绑(推给谁、串行闸、引擎拆了发不发)都由调用方交进来,这里只管次序:
 * 门槛没过什么都不做(不取头像、不出卡、不发);确定要出卡才取头像。
 */

import type { CardSkinChoice, ImageRenderer } from "@bilibili-notify/image";
import type {
	ImageRef,
	Logger,
	MessageLayoutSegment,
	SuperchatEvent,
} from "@bilibili-notify/internal";
import { errorMessageOf } from "../util/error-message";
import { passesSuperchatMinAmount } from "./interaction-gates";
import type { CustomCardStyleLike } from "./live-types";

export interface SuperchatOptions extends CardSkinChoice {
	/** 中立的醒目留言事件(档位已经算好)。 */
	event: SuperchatEvent;
	/** 这条订阅折好的门槛;没配不拦。 */
	minAmount: number | undefined;
	/** 主播:名字与头像(图库引用,没有就不带)。 */
	creator: { name: string; avatar?: ImageRef };
	/** 这条订阅折好的醒目留言卡样式;没启用(`enable` 为假)= 吃渲染器的全局配置。 */
	cardStyle: CustomCardStyleLike;
	/** 出不了卡(没有出图器、出卡抛错)时发的那句文字;平台自己的叫法由调用方拼好交进来。 */
	fallbackText: string;
}

export interface SuperchatDeps {
	/** 出卡的渲染器;null / 不给 = 不出卡,只发那句文字。 */
	renderer?: Pick<ImageRenderer, "generateSuperchatCard"> | null;
	/** 确定要出卡时才取观众头像(可能走网络);取不到回 `undefined`。 */
	fetchViewerAvatar: () => Promise<ImageRef | undefined>;
	/** 绑到这条订阅上的发送:收一段(一张图或一句文字)。 */
	send: (segment: MessageLayoutSegment) => Promise<void>;
	logger: Logger;
}

/**
 * 醒目留言:门槛 → 出卡 → 发。try 只包「取头像 + 出卡」:发送抛了原样往外抛 —— 抛之前可能已经发出去了,
 * 再补一句文字等于重发(失败规矩:发送抛了不许重发)。
 */
export async function pushSuperchat(options: SuperchatOptions, deps: SuperchatDeps): Promise<void> {
	const { event, creator, cardStyle } = options;
	if (!passesSuperchatMinAmount(event, options.minAmount)) return;
	const { renderer } = deps;
	if (renderer) {
		let card: Buffer | undefined;
		try {
			const viewerAvatar = await deps.fetchViewerAvatar();
			card = await renderer.generateSuperchatCard(
				{
					viewer: {
						name: event.viewer.name,
						...(viewerAvatar === undefined ? {} : { avatar: viewerAvatar }),
					},
					creator: {
						name: creator.name,
						...(creator.avatar === undefined ? {} : { avatar: creator.avatar }),
					},
					text: event.text,
					amount: event.amount,
					currency: event.currency,
					tier: event.tier,
				},
				// 样式启用了才展开(渲染器按「缺省 → 吃全局」判,递一份禁用的样式等于把它启用);皮肤两格恒带。
				{
					...(cardStyle.enable ? cardStyle : undefined),
					cardSkin: options.cardSkin,
					cardSkinKnobs: options.cardSkinKnobs,
				},
			);
		} catch (e) {
			deps.logger.error(`[image] 生成醒目留言卡片失败：${errorMessageOf(e)}，降级为文字推送`);
		}
		if (card !== undefined) {
			await deps.send({ kind: "image", buffer: card, mime: "image/jpeg" });
			return;
		}
	}
	await deps.send({ kind: "text", text: options.fallbackText });
}
