/**
 * OneBot v11 事件帧 → 入站消息。平台差异到此为止:交出去的是 `platforms/types.ts` 里
 * 那两个平台中立的形状,与官机网关交出来的一模一样。
 *
 * 曾经住在 `runtime/inbound-message.ts`,由指令分发与链接解析各自对同一帧解析一遍;
 * 现在 adapter 解析一次、按私聊 / 群分两路交出去 —— 第三个消费者不必再记 OneBot 的
 * 转义规则,官机那边也早就是这么做的。
 */

import type { InboundGroupMessage, InboundMeta, InboundPrivateMessage } from "./types.js";

export interface OnebotInboundSinks {
	onInboundPrivate?: (msg: InboundPrivateMessage, meta: InboundMeta) => void;
	onInboundGroup?: (msg: InboundGroupMessage, meta: InboundMeta) => void;
}

/**
 * 一帧 → 至多一路。没接的那路连解析都不做(官机开着「全部消息」时群里每句话都进这儿)。
 * 解析抛错由通道那层兜(它还担着推送,不能因为一帧怪东西断连)。
 */
export function routeInboundFrame(
	frame: Record<string, unknown>,
	meta: InboundMeta,
	sinks: OnebotInboundSinks,
): void {
	if (sinks.onInboundPrivate) {
		const msg = extractPrivateMessage(frame);
		if (msg) {
			sinks.onInboundPrivate(msg, meta);
			return;
		}
	}
	if (sinks.onInboundGroup) {
		const msg = extractGroupMessage(frame);
		if (msg) sinks.onInboundGroup(msg, meta);
	}
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
	const userId = toId(frame.user_id);
	if (!userId) return null;
	const text = extractText(frame);
	if (!text.trim()) return null;
	return { userId, text };
}

/**
 * OneBot 的各种 id 在不同实现里有的是数字有的是字符串,一律收成字符串。三处 id
 * (`user_id` / `group_id` / `self_id`)对「什么算 id」必须是同一个答案。
 */
function toId(v: unknown): string | undefined {
	return typeof v === "number" || typeof v === "string" ? String(v) : undefined;
}

/**
 * 从一帧 OneBot 事件里挑出群消息。不是群消息就返回 null。
 *
 * 与私聊那条只差「认哪种 message_type、多带一个 group_id」;文本抽取共用一份 ——
 * 段数组优先、raw_message 回落的那套容错两边都要。
 *
 * 多做一件事:**分享卡里的链接也交出去**(`cardLinks`,与正文分开)。用 B 站 App 的
 * 「分享到 QQ」把视频发进群,交过来的是一张卡(json / xml 段),正文一个字都没有,链接
 * 藏在卡的字段里 —— 只取 text 段的话,这条最常见的分享方式一个字都看不见。私聊那条
 * 不做这个:指令入口只认文字。正文与卡片链接都空才当没这条消息。
 */
export function extractGroupMessage(frame: Record<string, unknown>): InboundGroupMessage | null {
	if (frame.post_type !== "message") return null;
	if (frame.message_type !== "group") return null;
	const groupId = toId(frame.group_id);
	const userId = toId(frame.user_id);
	if (!groupId || !userId) return null;
	const text = extractText(frame).trim();
	const cardLinks = extractCardLinks(frame);
	if (!text && cardLinks.length === 0) return null;
	return { groupId, userId, selfId: toId(frame.self_id), text, cardLinks };
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

/**
 * 解析一张卡之前先扫一眼原文有没有这两个域名 —— 下游两条视频链接正则都硬要求它们,
 * 没有就绝不可能解出东西。省掉的是每条群消息上的一次 `JSON.parse` + 整棵树的字符串
 * 收集(1KB 的小程序卡实测 4.2µs,而这道预筛 0.15µs)。转义写法照样带着字面量:
 * json 只转义斜杠、xml 只转义 `&amp;`。
 */
const CARD_HOST_HINT = /bilibili\.com|b23\.tv/i;

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
		if (!CARD_HOST_HINT.test(raw)) continue;
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
