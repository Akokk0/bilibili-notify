/**
 * 入站私聊消息 —— 各平台事件帧到「谁说了什么」的收口。
 *
 * 从 `roast-command` 提出来的:审批曾经是唯一的入站消费者,所以这段解析住在那儿。
 * 现在指令分发器也要用,再让通用设施去 import 某一条具体指令就反了 —— 谁都能用的
 * 东西放这里,`roast-command` 继续 re-export 以免改动既有调用点。
 */

/** OneBot v11 私聊文本事件里我们用得到的那几个字段。 */
export interface InboundPrivateMessage {
	userId: string;
	text: string;
}

/**
 * 从一帧 OneBot 事件里挑出私聊文本。不是私聊消息就返回 null。
 *
 * `message` 段可能是字符串,也可能是 OneBot 的段数组;后者只取 text 段拼起来 ——
 * 主人回 `y` 时客户端可能顺手带上别的段(比如 reply),不该因此认不出来。
 */
export function extractPrivateMessage(
	frame: Record<string, unknown>,
): InboundPrivateMessage | null {
	if (frame.post_type !== "message") return null;
	if (frame.message_type !== "private") return null;
	const userId = frame.user_id;
	if (typeof userId !== "number" && typeof userId !== "string") return null;

	let text = "";
	if (typeof frame.raw_message === "string" && frame.raw_message.trim()) {
		text = frame.raw_message;
	} else if (typeof frame.message === "string") {
		text = frame.message;
	} else if (Array.isArray(frame.message)) {
		text = frame.message
			.filter(
				(seg): seg is { type: string; data: { text?: string } } =>
					typeof seg === "object" && seg !== null && (seg as { type?: string }).type === "text",
			)
			.map((seg) => seg.data?.text ?? "")
			.join("");
	}
	if (!text.trim()) return null;
	return { userId: String(userId), text };
}
