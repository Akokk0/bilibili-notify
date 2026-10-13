import type { DeliveryResult, NotificationPayload } from "@bilibili-notify/internal";
import type { EnginesRuntime } from "../runtime/engines.js";
import type { LinkReplyDestination } from "./link-parser.js";

/**
 * 链接解析回到来源群的发送口。
 *
 * 不走推送目标表(机器人在的所有群都算,群不必配成目标),但出口只有一个:经派发器的
 * `sendToAddress`,用收到那一帧的那条连接 + 群这个会话坐标。连接缺 / 停用 / 没适配器 / 不可达
 * 都在派发器那头收成结果形状,这里不再自己查连接、找适配器。
 */
export function createLinkReplySender(
	engines: Pick<EnginesRuntime, "sendToAddress">,
): (dest: LinkReplyDestination, payload: NotificationPayload) => Promise<DeliveryResult> {
	return ({ connectionId, groupId }, payload) =>
		engines.sendToAddress(connectionId, { scope: "group", address: groupId }, payload);
}
