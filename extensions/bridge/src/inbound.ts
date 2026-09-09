/**
 * 桥的入站帧 → 平台中立的那两个形状({@link InboundPrivateMessage} /
 * {@link InboundGroupMessage})。
 *
 * 与 `platforms/onebot-inbound.ts` 是同一个位置的东西:平台差异到此为止,交出去的与
 * 直连交出来的一模一样。区别只在于**这里没有解析** —— 帧在桥那一侧就已经被 koishi /
 * AstrBot 的适配器归一化过了,我们只是换个字段名。
 *
 * 协议见 `../PROTOCOL.md` §5.3。
 */

import type { ExtensionContext } from "@bilibili-notify/extension";
import type { InboundMeta } from "@bilibili-notify/internal";
import type { BridgeBot, BridgeInboundFrame } from "./contract.js";

/** 这一帧从哪条桥来,以及那条桥当下报的 bot 名单(只为查 `selfId`)。 */
export interface BridgeInboundSource {
	connectionId: string;
	bots: readonly BridgeBot[];
}

/**
 * 一帧 → 一路。
 *
 * `selfId` 从 bot 名单里查:链接解析那道「机器人自己贴的链接不解析」的闸全靠它。
 * **查不到也照走** —— 名单是全量快照,新上线的 bot 可能比它的第一条消息晚到;为这个
 * 丢消息,代价比多解析一条自己发的链接大得多(而协议本来就要求桥别回传自己的消息)。
 */
export function routeBridgeInbound(
	frame: BridgeInboundFrame,
	source: BridgeInboundSource,
	inbound: ExtensionContext["inbound"],
): void {
	const meta: InboundMeta = {
		connectionId: source.connectionId,
		platform: frame.platform,
		botId: frame.botId,
	};
	if (frame.message.scope === "private") {
		inbound.private({ userId: frame.message.userId, text: frame.message.text }, meta);
		return;
	}
	inbound.group(
		{
			groupId: frame.message.groupId,
			userId: frame.message.userId,
			text: frame.message.text,
			selfId: source.bots.find((bot) => bot.botId === frame.botId)?.selfId,
			// 协议要求桥把分享卡 / 小程序卡里的链接**拼进正文**再发上来(§5.3),所以这两格
			// 恒空:它们是 OneBot 那种「原始帧里另有一段 json」的产物,桥那侧没有原始帧。
			cardLinks: [],
			miniAppCardLinks: [],
		},
		meta,
	);
}
