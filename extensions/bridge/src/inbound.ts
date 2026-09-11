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

import type { ExtensionContext, InboundMeta } from "@bilibili-notify/extension";
import type { BridgeBot, BridgeInboundFrame } from "./contract.js";

/**
 * 这一帧归哪条连接(收到它的那个 bot 绑成的那条,由 `index.ts` 按接入 + `botId` 查出来),
 * 以及那条桥当下报的 bot 名单(只为查 `selfId`)。
 */
export interface BridgeInboundSource {
	connectionId: string;
	bots: readonly BridgeBot[];
	/**
	 * 帧里自报的 platform 与名单里那个 bot 的对不上时叫一声(先自报的、后名单的)。
	 * **去重归调用方** —— 这一层每条消息都会经过,叫一声不等于每条都记一行。
	 */
	onPlatformMismatch?(declared: string, actual: string): void;
}

/**
 * 一帧 → 一路。
 *
 * `selfId` 从 bot 名单里查:链接解析那道「机器人自己贴的链接不解析」的闸全靠它。
 * **查不到也照走** —— 名单是全量快照,新上线的 bot 可能比它的第一条消息晚到;为这个
 * 丢消息,代价比多解析一条自己发的链接大得多(而协议本来就要求桥别回传自己的消息)。
 *
 * 🔴 `platform` 同样**认名单不认帧**:它是主人身份比对(平台 + 地址 + bot 三坐标)与
 * 逐群策略的键,让一条入站帧自报等于让对面挑拿哪把钥匙开门。名单里查不到那个 bot 时才
 * 退回帧里自报的那个 —— 那时没有更好的答案,而丢掉整条消息更糟。
 */
export function routeBridgeInbound(
	frame: BridgeInboundFrame,
	source: BridgeInboundSource,
	inbound: ExtensionContext["inbound"],
): void {
	const bot = source.bots.find((candidate) => candidate.botId === frame.botId);
	if (bot && bot.platform !== frame.platform) {
		source.onPlatformMismatch?.(frame.platform, bot.platform);
	}
	const meta: InboundMeta = {
		connectionId: source.connectionId,
		platform: bot?.platform ?? frame.platform,
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
			selfId: bot?.selfId,
			// 协议 1.4 起桥把分享卡里的链接单独放两格(§5.3),这里原样转交 —— 尤其是
			// `miniAppCardLinks` 那一格必须独立活到链接解析那儿:它刻意不读那一格(群里
			// 已经有一张能点开播放的卡了),混进 `cardLinks` 就等于 BN 对着一张卡再回一张。
			// 老桥(1.3)不报这两格,把链接拼在 `text` 里照旧收 —— 缺省与「这条没有卡」同义。
			cardLinks: frame.message.cardLinks ?? [],
			miniAppCardLinks: frame.message.miniAppCardLinks ?? [],
		},
		meta,
	);
}
