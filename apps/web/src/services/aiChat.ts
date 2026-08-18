import type {
	AiChatMode,
	AiChatReplyResponse,
	AiConversationDTO,
	AiConversationListResponse,
	AiConversationMetaDTO,
	AiConversationMetaResponse,
	AiConversationResponse,
} from "@bilibili-notify/contract";
import { ApiError, api } from "./api";
import { withDesktopTokenHeader } from "./desktop-token";

/**
 * 女仆 AI 聊天的 REST 门面 + query key。
 *
 * 会话列表与会话详情是**两个** query:侧栏一次要列几十条,把每条的整段对话都
 * 拉下来只为显示一行标题太亏;点进去再取全文。两者的失效关系是「聊完一句 →
 * 列表和当前会话都脏了」,在 useSendMessage 里一并 invalidate。
 */

export type {
	AiChatMessageDTO,
	AiChatMode,
	AiConversationDTO,
	AiConversationMetaDTO,
	AiToolTraceDTO,
} from "@bilibili-notify/contract";

export const conversationsQueryKey = ["ai", "conversations"] as const;
export const conversationQueryKey = (id: string) => ["ai", "conversation", id] as const;

export function listConversations(): Promise<AiConversationListResponse> {
	return api.get<AiConversationListResponse>("/api/ai/conversations");
}

/**
 * 开一场新对话。`init` 是这场对话的**面孔**,只在这一刻定得了 —— 之后没有任何
 * 接口能改它(见服务端 newConversationSchema)。
 */
export async function createConversation(init?: {
	mode?: AiChatMode;
	persona?: boolean;
}): Promise<AiConversationDTO> {
	const res = await api.post<AiConversationResponse>("/api/ai/conversations", init ?? {});
	return res.conversation;
}

export async function getConversation(id: string): Promise<AiConversationDTO> {
	const res = await api.get<AiConversationResponse>(
		`/api/ai/conversations/${encodeURIComponent(id)}`,
	);
	return res.conversation;
}

/**
 * 让女仆给这个会话起个标题。第一轮聊完之后调一次。
 *
 * 失败不抛给主人看 —— 服务端那头起名失败也回 200 + 当前标题(等于没变)。标题
 * 是装饰,不值得为它在刚聊完的界面上弹一条红字。
 */
export async function retitleConversation(id: string): Promise<AiConversationMetaDTO> {
	const res = await api.post<AiConversationMetaResponse>(
		`/api/ai/conversations/${encodeURIComponent(id)}/title`,
	);
	return res.conversation;
}

export function deleteConversation(id: string): Promise<{ ok: boolean }> {
	return api.delete<{ ok: boolean }>(`/api/ai/conversations/${encodeURIComponent(id)}`);
}

/**
 * 把 SSE 字节流切成一条条事件。
 *
 * 独立成纯函数(而不是埋在 fetch 里)是为了能单测:**分片边界不认帧边界** ——
 * 网络给什么就是什么,一条 `data:` 完全可能被劈成两块到达,而两条事件也可能
 * 挤在同一块里。这里靠一个残留缓冲跨块粘合,是整条链上最容易写错的一环。
 */
export interface SseFrame {
	event: string;
	data: string;
}

export function createSseParser(): (chunk: string) => SseFrame[] {
	let buf = "";
	return (chunk: string) => {
		buf += chunk;
		const out: SseFrame[] = [];
		// 帧以空行分隔。最后一段可能只到一半,留在 buf 里等下一块。
		const parts = buf.split("\n\n");
		buf = parts.pop() ?? "";
		for (const frame of parts) {
			if (!frame.trim()) continue;
			let event = "message";
			const data: string[] = [];
			for (const line of frame.split("\n")) {
				if (line.startsWith("event:")) event = line.slice(6).trim();
				// 只裁掉紧跟冒号的那一个空格(SSE 规范),不 trim —— 正文分片
				// 里的前导 / 尾随空格是内容的一部分,裁了就会把词粘在一起。
				else if (line.startsWith("data:")) data.push(line.slice(line[5] === " " ? 6 : 5));
			}
			if (data.length > 0) out.push({ event, data: data.join("\n") });
		}
		return out;
	};
}

/**
 * 一次工具调用的两拍,与服务端 `event: tool` 的载荷同形。
 *
 * 工具轮不产生正文,所以那几秒在界面上跟「模型卡住了」长得一模一样 —— 这两拍
 * 就是把那段空白讲出来。`end` 靠 `id` 认回自己的 `start`。
 */
export type ChatToolEvent =
	| { phase: "start"; id: string; name: string; args: Record<string, string> }
	| {
			phase: "end";
			id: string;
			ok: boolean;
			/** `web_search` 专属:搜到的来源(标题 + 链接),给「来源」折叠列表。 */
			sources?: Array<{ title: string; url: string; siteName?: string }>;
	  };

export interface ChatStreamHandlers {
	/** 正文分片,来一段回调一次。 */
	onDelta: (text: string) => void;
	/** 工具调用的两拍。不关心就不传。 */
	onTool?: (ev: ChatToolEvent) => void;
	/** 思考分片(思考模型「先想后说」的那段草稿)。不关心就不传。 */
	onReasoning?: (text: string) => void;
}

/**
 * 发一句并**边收边回调**。响应是 SSE 而不是一次性 JSON。
 *
 * 不用 `EventSource`:它只会发 GET,而这里要 POST 一段消息体,还要带 dashboard
 * 那套鉴权头。所以走 fetch + 手读 `body` 流。
 *
 * 前置条件类错误(没配 key、会话不存在)仍是普通的非 200 JSON —— 服务端刻意
 * 没把它们塞进流里,这里也就照常抛 {@link ApiError},与其它接口一个样。
 */
export async function sendChatMessage(
	id: string,
	message: string,
	handlers: ChatStreamHandlers,
	/** 这一问带的图片资产 id(已经传好的),见 {@link uploadChatImage}。 */
	images?: readonly string[],
	/**
	 * 会话级的两颗胶囊(深度思考 / 联网搜索)。它们不落盘,只在这一问的请求体里
	 * 活着 —— 不带 = 都关。**要发的东西必须走参数**,别从组件闭包里读。
	 */
	flags?: { thinking?: boolean; search?: boolean; mode?: "chat" | "skin" },
): Promise<AiChatReplyResponse> {
	const path = `/api/ai/conversations/${encodeURIComponent(id)}/chat`;
	const res = await fetch(path, {
		method: "POST",
		headers: withDesktopTokenHeader({ "content-type": "application/json" }),
		body: JSON.stringify({
			message,
			...(images?.length ? { images: [...images] } : {}),
			...(flags?.thinking ? { thinking: true } : {}),
			...(flags?.search ? { search: true } : {}),
			// 日常聊天不发这个字段:服务端缺省就是它,而「不带 = 只读窗口」这条
			// 缺省语义,正是写能力不会因为漏传字段而凭空出现的那道保险。
			...(flags?.mode === "skin" ? { mode: "skin" } : {}),
		}),
		credentials: "include",
	});
	if (!res.ok || !res.body) {
		const payload = await res.json().catch(() => undefined);
		throw new ApiError(res.status, payload, errorText(payload, res.status));
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	const parse = createSseParser();
	let done: AiChatReplyResponse | null = null;
	let failure: string | null = null;

	while (true) {
		const { value, done: finished } = await reader.read();
		if (finished) break;
		// stream:true —— 一个多字节汉字可能横跨两块,不带它会解出替换字符。
		for (const frame of parse(decoder.decode(value, { stream: true }))) {
			if (frame.event === "delta") {
				handlers.onDelta((JSON.parse(frame.data) as { text: string }).text);
			} else if (frame.event === "reasoning") {
				handlers.onReasoning?.((JSON.parse(frame.data) as { text: string }).text);
			} else if (frame.event === "tool") {
				handlers.onTool?.(JSON.parse(frame.data) as ChatToolEvent);
			} else if (frame.event === "done") {
				done = JSON.parse(frame.data) as AiChatReplyResponse;
			} else if (frame.event === "error") {
				failure = (JSON.parse(frame.data) as { err: string }).err;
			}
		}
	}

	if (failure !== null) throw new Error(failure);
	// 流结束了却既没 done 也没 error:服务端进程被掐了 / 反代掐了连接。
	// 这时磁盘上什么都没落,当失败处理才与服务端状态一致。
	if (!done) throw new Error("连接中断,女仆没能把话说完");
	return done;
}

/** 与 api.ts 的错误取句逻辑同约定:服务端两种错误体形状都认。 */
function errorText(payload: unknown, status: number): string {
	if (payload && typeof payload === "object") {
		const p = payload as { err?: unknown; message?: unknown };
		if (typeof p.err === "string") return p.err;
		if (typeof p.message === "string") return p.message;
	}
	return `聊天请求失败(${status})`;
}

/**
 * 侧栏「最近」的分组标签。
 *
 * 只分「今天 / 昨天 / 更早」三档:再细就得给每一天一个标题,而会话总数上限
 * 只有 50 条,分成十几组反而比不分更难扫。
 */
export function groupLabel(updatedAt: string, now = new Date()): string {
	const d = new Date(updatedAt);
	if (Number.isNaN(d.getTime())) return "更早";
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	if (d.getTime() >= startOfToday) return "今天";
	if (d.getTime() >= startOfToday - 86_400_000) return "昨天";
	return "更早";
}

/** 按 {@link groupLabel} 分组,保持服务端给的倒序。 */
export function groupConversations(
	items: readonly AiConversationMetaDTO[],
	now = new Date(),
): Array<{ label: string; items: AiConversationMetaDTO[] }> {
	const out: Array<{ label: string; items: AiConversationMetaDTO[] }> = [];
	for (const item of items) {
		const label = groupLabel(item.updatedAt, now);
		const last = out[out.length - 1];
		// 列表已按 updatedAt 倒序,同组必然相邻 —— 只看上一组就够,不必用 Map
		// 再排一次序(那样会丢掉服务端定好的组内次序)。
		if (last && last.label === label) last.items.push(item);
		else out.push({ label, items: [item] });
	}
	return out;
}

/** 一张聊天附件的公开地址(dashboard 显示用)。 */
export function chatImageUrl(id: string): string {
	return `/api/ai/assets/${encodeURIComponent(id)}`;
}

/**
 * 上传一张聊天附件,拿回资产 id。
 *
 * 传完就落盘,而不是攒到发送时再传:这样格式不对 / 太大能**当场**报出来,而不是
 * 主人打完一整段话点发送才发现图没进去。
 */
export async function uploadChatImage(file: File): Promise<string> {
	const form = new FormData();
	form.append("file", file);
	const res = await fetch("/api/ai/assets", {
		method: "POST",
		headers: withDesktopTokenHeader({}),
		body: form,
		credentials: "include",
	});
	const payload = (await res.json().catch(() => undefined)) as
		| { ok?: boolean; id?: string; err?: string }
		| undefined;
	if (!res.ok || !payload?.ok || !payload.id) {
		throw new ApiError(res.status, payload, payload?.err ?? "图片上传失败");
	}
	return payload.id;
}
