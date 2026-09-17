/**
 * CSS 框旁那颗「请女仆帮忙写」的那条流(`POST /api/card-skins/:id/ai-css`,ADR-0015 决策 3–10)。
 *
 * 与聊天那条同一套读法:fetch + 手读 body,帧由 {@link createSseParser} 切。不用
 * `EventSource` 的理由也一样 —— 它只会发 GET。开流之前的拒绝是普通 JSON,照常抛
 * {@link ApiError}。取消就是掐断这次 fetch,服务端跟着掐断到模型的请求。
 */

import type { CardSkinAiCssEvent, CardSkinAiCssRequest } from "@bilibili-notify/contract";
import { createSseParser } from "./aiChat";
import { ApiError } from "./api";
import { withDesktopTokenHeader } from "./desktop-token";

export interface CardSkinAiHandlers {
	/** 写完的一整条规则,按到达顺序拼起来就是框里的新内容。 */
	onRule: (text: string) => void;
	/** 第一趟没过清洗器、要重来了:之后的规则从头拼。 */
	onRetry: (errors: string[]) => void;
}

/** 写完了:框里该留的内容,以及清洗器削掉了什么。 */
export interface CardSkinAiDone {
	css: string;
	warnings: string[];
}

export async function streamCardSkinAiCss(
	skinId: string,
	body: CardSkinAiCssRequest,
	handlers: CardSkinAiHandlers,
	signal: AbortSignal | undefined,
): Promise<CardSkinAiDone> {
	const res = await fetch(`/api/card-skins/${encodeURIComponent(skinId)}/ai-css`, {
		method: "POST",
		headers: withDesktopTokenHeader({ "content-type": "application/json" }),
		body: JSON.stringify(body),
		credentials: "include",
		signal,
	});
	if (!res.ok || !res.body) {
		const payload = await res.json().catch(() => undefined);
		throw new ApiError(res.status, payload, refusal(payload, res.status));
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	const parse = createSseParser();
	let done: CardSkinAiDone | null = null;
	let failure: string[] | null = null;

	while (true) {
		const { value, done: finished } = await reader.read();
		if (finished) break;
		// stream:true —— 一个多字节汉字可能横跨两块。
		for (const frame of parse(decoder.decode(value, { stream: true }))) {
			const e = { event: frame.event, data: JSON.parse(frame.data) } as CardSkinAiCssEvent;
			if (e.event === "rule") handlers.onRule(e.data.text);
			else if (e.event === "retry") handlers.onRetry(e.data.errors);
			else if (e.event === "done") done = e.data;
			else if (e.event === "error") failure = e.data.errors;
		}
	}

	if (failure !== null) throw new Error(failure.join("\n"));
	// 既没 done 也没 error:服务端进程被掐了、或反代掐了连接。当成写完的话,框里会留下半截。
	if (!done) throw new Error("连接中断,AI 没能写完");
	return done;
}

/** 开流之前的拒绝:服务端这条路回的是 `{ ok: false, errors }`。 */
function refusal(payload: unknown, status: number): string {
	const errors = (payload as { errors?: unknown } | undefined)?.errors;
	if (Array.isArray(errors) && errors.length > 0) return errors.join("\n");
	return `请求失败(${status})`;
}
