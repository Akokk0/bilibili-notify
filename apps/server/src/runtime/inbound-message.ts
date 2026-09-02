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

/** OneBot v11 群消息文本事件里我们用得到的那几个字段。 */
export interface InboundGroupMessage {
	groupId: string;
	userId: string;
	/** 收到这条消息的 bot 自己的号;老客户端可能不带。 */
	selfId?: string;
	/** 正文,后面接着分享卡(json / xml 段)里的链接 —— 见 {@link extractGroupMessage}。 */
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
	const text = extractText(frame);
	if (!text.trim()) return null;
	return { userId: String(userId), text };
}

/**
 * 从一帧 OneBot 事件里挑出群消息文本。不是群消息就返回 null。
 *
 * 与私聊那条只差「认哪种 message_type、多带一个 group_id」;文本抽取共用一份 ——
 * 段数组优先、raw_message 回落的那套容错两边都要。
 *
 * 多做一件事:**分享卡里的链接也接到正文后面**。用 B 站 App 的「分享到 QQ」把视频发进群,
 * 交过来的是一张卡(json / xml 段),正文一个字都没有,链接藏在卡的字段里 —— 只取 text 段
 * 的话,这条最常见的分享方式一个字都看不见。私聊那条不做这个:指令入口只认文字。
 */
export function extractGroupMessage(frame: Record<string, unknown>): InboundGroupMessage | null {
	if (frame.post_type !== "message") return null;
	if (frame.message_type !== "group") return null;
	const groupId = frame.group_id;
	const userId = frame.user_id;
	if (typeof groupId !== "number" && typeof groupId !== "string") return null;
	if (typeof userId !== "number" && typeof userId !== "string") return null;
	const text = [extractText(frame), ...extractCardLinks(frame)].join(" ").trim();
	if (!text) return null;
	const selfId = frame.self_id;
	return {
		groupId: String(groupId),
		userId: String(userId),
		selfId: typeof selfId === "number" || typeof selfId === "string" ? String(selfId) : undefined,
		text,
	};
}

/**
 * 段数组优先:真实客户端两个字段**都发**,raw_message 是裹着 CQ 码的字符串
 * ("[CQ:reply,id=…]y")。让它抢跑的话,「主人回 y 时顺手带上 reply 段也该
 * 认得出」的容错永远轮不到 —— 引用回复的 y/n 与指令全认不出。raw_message
 * 只作老客户端(没有段数组)的回落,且要先还原 CQ 转义。
 */
function extractText(frame: Record<string, unknown>): string {
	if (Array.isArray(frame.message)) {
		return frame.message
			.filter(
				(seg): seg is { type: string; data: { text?: string } } =>
					typeof seg === "object" && seg !== null && (seg as { type?: string }).type === "text",
			)
			.map((seg) => seg.data?.text ?? "")
			.join("");
	}
	// 字符串格式的 message 与 raw_message 一样裹着 CQ 转义,同样要还原。
	if (typeof frame.message === "string") return unescapeCq(frame.message);
	if (typeof frame.raw_message === "string") return unescapeCq(frame.raw_message);
	return "";
}

const URL_RE = /https?:\/\/[^\s"'<>\\]+/g;
/** 分享卡的 payload 顶多几 KB;再大的不是卡,不往里翻。 */
const MAX_CARD_CHARS = 64 * 1024;
const MAX_CARD_DEPTH = 8;

/**
 * 段数组里 json / xml 卡片(OneBot 的 `data.data` 是一整段 JSON / XML 文本)里的所有链接,
 * 按出现顺序。json 先 `JSON.parse` 再逐字符串找 —— 结构化消息里的 `jumpUrl` 是 `https:\/\/…`
 * 这种转义写法,对着原文找是找不到的;解析不动就退回原文找。xml 只需把 `&amp;` 还原。
 * 找出来的是「链接候选」,认不认由 {@link extractVideoLinks} 说了算。
 */
function extractCardLinks(frame: Record<string, unknown>): string[] {
	if (!Array.isArray(frame.message)) return [];
	const links: string[] = [];
	for (const seg of frame.message) {
		if (typeof seg !== "object" || seg === null) continue;
		const { type, data } = seg as { type?: unknown; data?: { data?: unknown } };
		if (type !== "json" && type !== "xml") continue;
		const raw = data?.data;
		if (typeof raw !== "string" || raw.length > MAX_CARD_CHARS) continue;
		for (const s of cardStrings(type, raw)) {
			for (const m of s.matchAll(URL_RE)) links.push(m[0]);
		}
	}
	return links;
}

function cardStrings(type: "json" | "xml", raw: string): string[] {
	if (type === "xml") return [raw.replace(/&amp;/g, "&")];
	try {
		const out: string[] = [];
		collectStrings(JSON.parse(raw), out, 0);
		return out;
	} catch {
		return [raw.replace(/\\\//g, "/")];
	}
}

function collectStrings(v: unknown, out: string[], depth: number): void {
	if (depth > MAX_CARD_DEPTH) return;
	if (typeof v === "string") out.push(v);
	else if (Array.isArray(v)) for (const x of v) collectStrings(x, out, depth + 1);
	else if (v !== null && typeof v === "object") {
		for (const x of Object.values(v)) collectStrings(x, out, depth + 1);
	}
}

/** OneBot 的 CQ 码转义还原([ ] , & 在 raw_message 里以 HTML 实体出现)。 */
function unescapeCq(s: string): string {
	return s
		.replace(/&#91;/g, "[")
		.replace(/&#93;/g, "]")
		.replace(/&#44;/g, ",")
		.replace(/&amp;/g, "&");
}
