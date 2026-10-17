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

import type { PlatformAdapterContext } from "@bilibili-notify/extension";
import type { BridgeBot, BridgeInboundFrame } from "./contract.js";

/**
 * 这一帧归哪条连接(收到它的那个 bot 绑成的那条,由 `index.ts` 按接入 + `botId` 查出来),
 * 以及那条桥当下报的 bot 名单(只为查 `selfId`)。
 */
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
 *
 * 🔴 **平台不在这儿报**:它是主人身份比对(平台 + 地址 + bot 三坐标)与逐群策略的键,让一条入站帧
 * (或桥)自报等于让对面挑拿哪把钥匙开门。适配器交入站只带 `connectionId`,宿主按连接那一格补平台。
 */
export function routeBridgeInbound(
	frame: BridgeInboundFrame,
	source: BridgeInboundSource,
	inbound: PlatformAdapterContext["inbound"],
): void {
	const bot = source.bots.find((candidate) => candidate.botId === frame.botId);
	const meta = { connectionId: source.connectionId };
	if (frame.message.scope === "private") {
		inbound.private({ address: frame.message.userId, text: frame.message.text }, meta);
		return;
	}
	inbound.group(
		{
			address: frame.message.groupId,
			senderId: frame.message.userId,
			text: frame.message.text,
			selfId: bot?.selfId,
			// 线上帧不改名:协议 1.4 起桥把分享卡里的链接单独放两格(§5.3),在这里映射成 BN 内部
			// 的一格 —— 普通卡记 `"card"`、小程序卡记 `"nativeShare"`,先普通后小程序。两种来源不能
			// 混:`"nativeShare"` 的链接链接解析刻意不读(群里已经有一张能点开播放的卡了),
			// 记成 `"card"` 就等于 BN 对着一张卡再回一张。
			// 老桥(1.3)不报这两格,把链接拼在 `text` 里照旧收 —— 缺省与「这条没有卡」同义。
			sharedLinks: [
				...(frame.message.cardLinks ?? []).map((url) => ({ url, kind: "card" as const })),
				...(frame.message.miniAppCardLinks ?? []).map((url) => ({
					url,
					kind: "nativeShare" as const,
				})),
			],
		},
		meta,
	);
}
