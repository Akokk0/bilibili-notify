import type {
	Disposable,
	Logger,
	NotificationPayload,
	PushTargetScope,
	QQOfficialSession,
	ServiceContext,
} from "@bilibili-notify/internal";

/** QQ 开放平台换取 App Access Token 的端点(与沙箱/正式无关,固定走 bots.qq.com)。 */
const QQ_TOKEN_ENDPOINT = "https://bots.qq.com/app/getAppAccessToken";

export interface QQAccessToken {
	token: string;
	/** 有效期(秒),通常 7200;token 管理器据此提前刷新。 */
	expiresInSec: number;
}

/**
 * 调 QQ 开放平台换取 App Access Token。后续 REST(`Authorization: QQBot {token}`)
 * 与 WS Identify 都带它。失败抛错,由 token 管理器决定重试/降级。
 */
export async function fetchAppAccessToken(
	appId: string,
	clientSecret: string,
): Promise<QQAccessToken> {
	const res = await fetch(QQ_TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ appId, clientSecret }),
	});
	if (!res.ok) throw new Error(`getAppAccessToken HTTP ${res.status}`);
	const data = (await res.json()) as { access_token?: string; expires_in?: number | string };
	if (!data.access_token) throw new Error("getAppAccessToken: 响应缺 access_token");
	const expiresInSec = Number(data.expires_in);
	return {
		token: data.access_token,
		expiresInSec: Number.isFinite(expiresInSec) && expiresInSec > 0 ? expiresInSec : 7200,
	};
}

/** token 提前刷新缓冲(秒);对齐 koishi(快到期前 40s 换新 token)。 */
const QQ_TOKEN_REFRESH_BUFFER_SEC = 40;

export interface QQTokenManager {
	/** 取当前有效 token;未就绪则发起获取并缓存,并发共享同一 Promise。 */
	getToken(): Promise<string>;
	/** 关闭:停掉刷新定时器,后续 getToken 拒绝。 */
	dispose(): void;
}

export interface QQTokenManagerOptions {
	appId: string;
	clientSecret: string;
	serviceCtx: ServiceContext;
	logger: Logger;
	/** 提前刷新缓冲(秒),默认 40。 */
	refreshBufferSec?: number;
}

/**
 * App Access Token 管理器:首次 getToken 拉取并缓存,按 `expires_in - buffer` 排一个
 * 提前刷新定时器(到点自动换新 token,长连无需重连)。失败结果不缓存 → 下次 getToken 重试。
 * dispose 停定时器(对齐有状态 adapter 生命周期)。
 */
export function createQQTokenManager(opts: QQTokenManagerOptions): QQTokenManager {
	const buffer = opts.refreshBufferSec ?? QQ_TOKEN_REFRESH_BUFFER_SEC;
	let tokenPromise: Promise<string> | null = null;
	let refreshTimer: Disposable | null = null;
	let disposed = false;

	async function refresh(): Promise<string> {
		const { token, expiresInSec } = await fetchAppAccessToken(opts.appId, opts.clientSecret);
		if (!disposed) {
			refreshTimer?.dispose();
			const delayMs = Math.max(expiresInSec - buffer, 1) * 1000;
			refreshTimer = opts.serviceCtx.setTimeout(() => {
				tokenPromise = refresh().catch((e) => {
					opts.logger.warn(`[qq] App Access Token 刷新失败,下次发送将重试: ${String(e)}`);
					tokenPromise = null;
					throw e;
				});
			}, delayMs);
		}
		return token;
	}

	return {
		getToken() {
			if (disposed) return Promise.reject(new Error("qq token manager disposed"));
			if (!tokenPromise) {
				tokenPromise = refresh().catch((e) => {
					tokenPromise = null; // 失败不缓存,允许下次重试
					throw e;
				});
			}
			return tokenPromise;
		},
		dispose() {
			disposed = true;
			refreshTimer?.dispose();
			refreshTimer = null;
			tokenPromise = null;
		},
	};
}

export interface QQDiscoveredSession {
	scope: "group" | "private";
	/** group_openid(群)或用户 openid(C2C)。 */
	openid: string;
	/** 触发者用户名等展示提示 —— 群事件不带群名,只能靠它给用户辨认。 */
	displayHint?: string;
}

/**
 * 从入站事件捞群/C2C 的不透明 openid —— 群/C2C 寻址的唯一来源(QQ 无「列我加入的群」接口,
 * 用户没法手填群号)。群:GROUP_AT_MESSAGE_CREATE / GROUP_ADD_ROBOT → group_openid;
 * C2C:C2C_MESSAGE_CREATE → author.user_openid、FRIEND_ADD → openid。非相关事件返回 null。
 */
export function extractQQDiscoveredSession(
	eventType: string,
	data: Record<string, unknown>,
): QQDiscoveredSession | null {
	const author = data.author as
		| { id?: string; member_openid?: string; user_openid?: string; username?: string }
		| undefined;
	const hint = author?.username;
	if (eventType === "GROUP_AT_MESSAGE_CREATE" || eventType === "GROUP_ADD_ROBOT") {
		const openid = (data.group_openid ?? data.group_id) as string | undefined;
		if (!openid) return null;
		return { scope: "group", openid, ...(hint ? { displayHint: hint } : {}) };
	}
	if (eventType === "C2C_MESSAGE_CREATE" || eventType === "FRIEND_ADD") {
		const openid = (author?.user_openid ?? author?.member_openid ?? data.openid) as
			| string
			| undefined;
		if (!openid) return null;
		return { scope: "private", openid, ...(hint ? { displayHint: hint } : {}) };
	}
	return null;
}

/** 单 adapter 发现列表上限 —— 内存 ring buffer,超出丢最旧(纯便利选择器,不持久化)。 */
const QQ_DISCOVERY_MAX_PER_ADAPTER = 50;

export interface QQDiscoveredEntry extends QQDiscoveredSession {
	/** 最近见到时间戳(caller 传入 Date.now,便于测试与排序)。 */
	lastSeenMs: number;
}

/**
 * per-adapter「最近活跃会话」发现表 —— 群/C2C 的 openid 只能从入站事件捞,做成内存
 * ring buffer(不落盘)供面板选择器列出。一旦用户把某会话做成 PushTarget,openid 就存进
 * target,发现表只是一次性选择器;重启清空靠机器人再被 @ 唤回。
 */
export interface QQSessionRegistry {
	/** 记一次发现:同 scope+openid 去重(更新 lastSeen/hint 并移到最前),超容丢最旧。 */
	record(adapterId: string, session: QQDiscoveredSession, atMs: number): void;
	/** 列出某 adapter 最近发现的会话(最近优先)。 */
	list(adapterId: string): QQDiscoveredEntry[];
	/** 删除某 adapter 的全部发现(reconcile 删该 adapter 时)。 */
	clear(adapterId: string): void;
}

export function createQQSessionRegistry(opts?: { maxPerAdapter?: number }): QQSessionRegistry {
	const max = opts?.maxPerAdapter ?? QQ_DISCOVERY_MAX_PER_ADAPTER;
	const byAdapter = new Map<string, QQDiscoveredEntry[]>();
	const keyOf = (s: { scope: string; openid: string }) => `${s.scope}:${s.openid}`;

	return {
		record(adapterId, session, atMs) {
			const prev = byAdapter.get(adapterId) ?? [];
			const next = prev.filter((e) => keyOf(e) !== keyOf(session));
			next.unshift({ ...session, lastSeenMs: atMs });
			if (next.length > max) next.length = max;
			byAdapter.set(adapterId, next);
		},
		list(adapterId) {
			return [...(byAdapter.get(adapterId) ?? [])];
		},
		clear(adapterId) {
			byAdapter.delete(adapterId);
		},
	};
}

/**
 * QQ 官方机器人(q.qq.com)推送目标 → 发消息 REST endpoint。
 * - channel(频道子频道):POST /channels/{channelId}/messages
 * - group(群):POST /v2/groups/{groupOpenid}/messages
 * - private(C2C 单聊):POST /v2/users/{userOpenid}/messages
 *
 * 会话缺对应字段时返回 `{ err }` —— 发送前运行期校验(群/C2C 的 openid 只能从入站
 * 事件捞,缺失即配置未就绪),不浪费一次注定失败的 REST 往返。
 */
export function qqMessageEndpoint(
	scope: PushTargetScope,
	session: QQOfficialSession,
): { path: string } | { err: string } {
	if (scope === "channel") {
		if (!session.channelId) return { err: "channel: channelId missing" };
		return { path: `/channels/${session.channelId}/messages` };
	}
	if (scope === "group") {
		if (!session.groupOpenid) return { err: "group: groupOpenid missing" };
		return { path: `/v2/groups/${session.groupOpenid}/messages` };
	}
	if (!session.userOpenid) return { err: "private: userOpenid missing" };
	return { path: `/v2/users/${session.userOpenid}/messages` };
}

/** QQ 官方富媒体类型:1=图片 2=视频 3=语音(本插件只发图)。 */
const QQ_FILE_TYPE_IMAGE = 1;

/** 富媒体上传请求体。`POST /v2/groups|users/{id}/files` 拿 file_info 后再发 media 消息。 */
export interface QQFileUploadBody {
	file_type: number;
	/** false = 仅上传拿 file_info,不直接发(我们要把 file_info 拼进后续 media 消息)。 */
	srv_send_msg: boolean;
	/** 图片二进制的 base64(无 data: 前缀)。自包含,不依赖公网可达 URL。 */
	file_data: string;
}

/**
 * 把渲染好的图片 Buffer 转成群/C2C 富媒体上传体 —— 走 base64 `file_data`,
 * 这样本地渲染的卡片无需挂到公网 URL 即可发(QQ 官方群/C2C 发图的命门)。
 */
export function buildQQFileUpload(buffer: Buffer): QQFileUploadBody {
	return {
		file_type: QQ_FILE_TYPE_IMAGE,
		srv_send_msg: false,
		file_data: buffer.toString("base64"),
	};
}

/** QQ 官方 v2(群/C2C)消息类型:0=文本 2=markdown 7=富媒体。 */
export const QQ_MSG_TYPE = { TEXT: 0, MARKDOWN: 2, MEDIA: 7 } as const;

export interface QQV2MessageBody {
	content: string;
	msg_type: number;
	media?: { file_info: string };
}

/**
 * 群/C2C 单条消息体。带 `fileInfo` → 富媒体消息(msg_type 7;content 作图说明,QQ 要求
 * content 非空,空时占位一个空格);否则纯文本(msg_type 0)。一条 media 消息只能带一张图,
 * 多图由 adapter 拆成多条消息。
 */
export function buildQQV2Message(opts: { content?: string; fileInfo?: string }): QQV2MessageBody {
	if (opts.fileInfo) {
		return {
			content: opts.content && opts.content.length > 0 ? opts.content : " ",
			msg_type: QQ_MSG_TYPE.MEDIA,
			media: { file_info: opts.fileInfo },
		};
	}
	return { content: opts.content ?? "", msg_type: QQ_MSG_TYPE.TEXT };
}

/**
 * 一条待发送片段。QQ 官方一条 media 消息只能带一张图,故图集/composite 会展开成多片段,
 * adapter 按序逐条发(图片片段:群/C2C 先富媒体上传拿 file_info 再发 media 消息;
 * 频道走 multipart `file_image`)。
 */
export type QQSendPart =
	| { kind: "text"; text: string }
	| { kind: "image-buffer"; buffer: Buffer; caption?: string }
	| { kind: "image-url"; url: string };

/**
 * 把平台中立 `NotificationPayload` 翻译成有序发送片段。QQ 无「合并转发」,多图一律展开成
 * 多条;`forward-images` 的 `forward` 标志对 QQ 无意义。卡片 Buffer 走 image-buffer
 * (群/C2C base64 上传 / 频道 multipart),图集 URL 走 image-url。
 */
export function qqPayloadToParts(payload: NotificationPayload): QQSendPart[] {
	switch (payload.kind) {
		case "text":
			return [{ kind: "text", text: payload.text }];
		case "image":
			return [{ kind: "image-buffer", buffer: payload.image.buffer, caption: payload.caption }];
		case "forward-images":
			// QQ 无合并转发 —— forward 标志忽略,每张图展开成独立片段。
			return payload.urls.map((url) => ({ kind: "image-url" as const, url }));
		case "composite": {
			const parts: QQSendPart[] = [];
			for (const seg of payload.segments) {
				if (seg.type === "text") parts.push({ kind: "text", text: seg.text });
				else if (seg.type === "image") parts.push({ kind: "image-buffer", buffer: seg.buffer });
				else if (seg.type === "link")
					parts.push({ kind: "text", text: seg.title ? `${seg.title} ${seg.href}` : seg.href });
				// at-all:QQ 群 @全体需特殊权限,best-effort 跳过,不阻断推送。
			}
			return parts;
		}
		default:
			return [];
	}
}
