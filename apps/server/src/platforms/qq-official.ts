import type {
	AddressCandidate,
	Connection,
	ConnectionCandidate,
	ConnectionCapabilities,
	DeliveryResult,
	DestinationRef,
	Disposable,
	Failure,
	FetchOptions,
	HttpClient,
	HttpResponse,
	InboundGroupMessage,
	InboundPrivateMessage,
	Logger,
	NotificationPayload,
	PlatformAdapter,
	PlatformAdapterContext,
	ProbeResult,
	PushTargetScope,
	QQOfficialConnectionSettings,
	Result,
	ServiceContext,
	WebSocketLike,
} from "@bilibili-notify/internal";
import { fail, ok, QQOfficialConnectionSettingsSchema } from "@bilibili-notify/internal";
import type { RawData } from "ws";
import { z } from "zod";
import type { IntegrationSettingsSegment } from "../config/store.js";
import { t } from "../i18n/index.js";
import type { LocaleReader } from "../i18n/locale-reader.js";
import { builtinCandidatesFor } from "./builtin-candidates.js";
import { describeDestination } from "./destination-label.js";
import { imageGroupUrls } from "./image-group.js";
import { createQQConnectionAuth } from "./qq-bind.js";
import { upstreamMessage } from "./upstream-message.js";

/** QQ 开放平台换取 App Access Token 的端点(与沙箱/正式无关,固定走 bots.qq.com)。 */
const QQ_TOKEN_ENDPOINT = "https://bots.qq.com/app/getAppAccessToken";

/**
 * QQ 请求的单跳超时,毫秒。这几处出网在改走请求客户端之前没有任何超时(原生 fetch 不设总时限),
 * 而客户端的默认是 20 秒;显式给 300 秒是**只为保行为**,收紧另议。
 */
const QQ_REQUEST_TIMEOUT_MS = 300_000;

/** QQ 的请求都走这里:不带浏览器身份、不碰 cookie 罐(线上只有调用方给的头),超时见 {@link QQ_REQUEST_TIMEOUT_MS}。 */
function qqFetch(http: HttpClient, url: string, options: FetchOptions) {
	return http.fetch(url, { timeoutMs: QQ_REQUEST_TIMEOUT_MS, ...options, bare: true });
}

/** WebSocket 的「已连上」(WHATWG 的 `readyState` 取值,`WebSocketLike` 不带常量)。 */
const WS_OPEN = 1;

export interface QQAccessToken {
	token: string;
	/** 有效期(秒),通常 7200;token 管理器据此提前刷新。 */
	expiresInSec: number;
}

/**
 * 换 token 没成的两种「对端答了」的情形。带上够翻标准码的那一点信息:回了非 2xx 的带状态码;
 * 回了 2xx 却没给 token 的不带。连不上时抛的是 fetch 自己的错,不是它。
 */
class QQTokenError extends Error {
	constructor(
		message: string,
		readonly httpStatus?: number,
	) {
		super(message);
	}
}

/**
 * 调 QQ 开放平台换取 App Access Token。后续 REST(`Authorization: QQBot {token}`)
 * 与 WS Identify 都带它。失败抛错,由 token 管理器决定重试/降级。
 */
export async function fetchAppAccessToken(
	http: HttpClient,
	appId: string,
	clientSecret: string,
	signal?: AbortSignal,
): Promise<QQAccessToken> {
	const res = await qqFetch(http, QQ_TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ appId, clientSecret }),
		signal,
	});
	// 没走通(连不上、超时、被中止):抛普通错,token 管理器与 `tokenFailure` 记成 unavailable。
	if (!res.ok) throw new Error(res.message);
	if (!res.isSuccess) {
		throw new QQTokenError(`getAppAccessToken HTTP ${res.status}`, res.status);
	}
	const parsed = res.json();
	if (!parsed.ok) throw new Error(parsed.message);
	const data = parsed.value as { access_token?: string; expires_in?: number | string };
	if (!data.access_token) throw new QQTokenError(t("qqOfficial.token.missingAccessToken"));
	const expiresInSec = Number(data.expires_in);
	return {
		token: data.access_token,
		expiresInSec: Number.isFinite(expiresInSec) && expiresInSec > 0 ? expiresInSec : 7200,
	};
}

// ---------------------------------------------------------------------------
// WS 网关协议帧(纯函数)—— 蓝本 @satorijs/adapter-qq/src/ws.ts + QQ 官方网关文档
// ---------------------------------------------------------------------------

/** QQ 网关 opcode。HELLO→IDENTIFY/RESUME→心跳(op1)+ack(op11)→DISPATCH(op0)。 */
export const QQ_OPCODE = {
	DISPATCH: 0,
	HEARTBEAT: 1,
	IDENTIFY: 2,
	RESUME: 6,
	RECONNECT: 7,
	INVALID_SESSION: 9,
	HELLO: 10,
	HEARTBEAT_ACK: 11,
} as const;

/**
 * push-only intents 超集 —— 只订阅推送需要的事件:
 * GUILDS(频道增删,频道发现)| USER_MESSAGE(1<<25,群@/C2C 入站,**openid 捞取命门**)|
 * MESSAGE_AUDIT(消息审核回执,A+ 投递语义)| PUBLIC_GUILD_MESSAGES(频道@消息)。
 * 公私域都能设(不含私域专属的 GUILD_MESSAGES 1<<9)。
 */
export const QQ_PUSH_INTENTS = ((1 << 0) | (1 << 25) | (1 << 27) | (1 << 30)) >>> 0;

/** 正式 / 沙箱 REST API base host。沙箱在 api 前插 `sandbox.`(对齐上游 koishi 框架的 qq adapter)。 */
export function qqApiBase(sandbox: boolean): string {
	return sandbox ? "https://sandbox.api.sgroup.qq.com" : "https://api.sgroup.qq.com";
}

/**
 * `GET /gateway` 返回的 wss url 改写到沙箱 host(正式原样)。沙箱网关与正式同路径、
 * 仅 host 不同 —— 对齐 @satorijs 的 `.replace('api.sgroup.qq.com', sandboxHost)`。
 */
export function qqGatewayUrlForHost(url: string, sandbox: boolean): string {
	return sandbox ? url.replace("api.sgroup.qq.com", "sandbox.api.sgroup.qq.com") : url;
}

export interface QQFrame {
	op: number;
	/** DISPATCH 帧的序列号,心跳/RESUME 要回带。 */
	s?: number;
	/** DISPATCH 帧的事件名(READY / GROUP_AT_MESSAGE_CREATE / …)。 */
	t?: string;
	d?: unknown;
}

/** IDENTIFY(op2)鉴权帧。token 统一前缀 `QQBot `;shard 固定 [0,1](单分片)。 */
export function buildQQIdentify(
	accessToken: string,
	intents: number = QQ_PUSH_INTENTS,
): { op: number; d: { token: string; intents: number; shard: [number, number] } } {
	return {
		op: QQ_OPCODE.IDENTIFY,
		d: { token: `QQBot ${accessToken}`, intents, shard: [0, 1] },
	};
}

/** RESUME(op6)续连帧 —— 断线重连且会话未失效时复用 session_id + seq,免重建状态。 */
export function buildQQResume(
	accessToken: string,
	sessionId: string,
	seq: number,
): { op: number; d: { token: string; session_id: string; seq: number } } {
	return {
		op: QQ_OPCODE.RESUME,
		d: { token: `QQBot ${accessToken}`, session_id: sessionId, seq },
	};
}

/** HEARTBEAT(op1)心跳帧。d=最近收到的 seq;尚未收到 DISPATCH 时为 null。 */
export function buildQQHeartbeat(seq: number | null): { op: number; d: number | null } {
	return { op: QQ_OPCODE.HEARTBEAT, d: seq };
}

/** 解析入站帧;非法 JSON 或缺 `op`(非数字)→ null,绝不抛(网关偶发噪声不应崩连接)。 */
export function parseQQFrame(raw: string): QQFrame | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const frame = parsed as QQFrame;
	if (typeof frame.op !== "number") return null;
	return frame;
}

/**
 * 关闭码是否应清空会话(下次握手强制重新 IDENTIFY 而非 RESUME)。对齐 @satorijs:
 * code > 4000 且非 4008(限流)/4009(连接超时,可续连)→ 清。普通断开(<4000,如 1006)
 * 可 RESUME。
 */
export function qqShouldResetSessionOnClose(code: number): boolean {
	return code > 4000 && code !== 4008 && code !== 4009;
}

/** token 提前刷新缓冲(秒);对齐上游 koishi 框架的 qq adapter(快到期前 40s 换新 token)。 */
const QQ_TOKEN_REFRESH_BUFFER_SEC = 40;

export interface QQTokenManager {
	/** 取当前有效 token;未就绪则发起获取并缓存,并发共享同一 Promise。 */
	getToken(): Promise<string>;
	/** 关闭:停掉刷新定时器,后续 getToken 拒绝。 */
	dispose(): void;
}

export interface QQTokenManagerOptions {
	/** 换 token 走这个集成的请求客户端。 */
	http: HttpClient;
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
		const { token, expiresInSec } = await fetchAppAccessToken(
			opts.http,
			opts.appId,
			opts.clientSecret,
		);
		if (!disposed) {
			refreshTimer?.dispose();
			const delayMs = Math.max(expiresInSec - buffer, 1) * 1000;
			refreshTimer = opts.serviceCtx.setTimeout(() => {
				// 定时刷新没有 awaiter:成功时把新 token 缓存进 tokenPromise(后续 getToken 直接命中),
				// 失败时清空让下次 getToken 重试。错误处理器不 re-throw —— 否则这条无人 await 的
				// 拒绝 Promise 会触发 unhandledRejection(strict 模式下可崩进程)。
				const p = refresh();
				tokenPromise = p;
				p.catch((e) => {
					opts.logger.warn(`[qq] App Access Token 刷新失败,下次发送将重试: ${String(e)}`);
					if (tokenPromise === p) tokenPromise = null;
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
 *
 * 不认 GROUP_MESSAGE_CREATE(不 @ 的普通群聊):它在「获取群内全部消息」档下是群里每一句话,
 * 都进发现表的话面板那份「最近优先」的列表会随人说话不停重排。入群与被 @ 两条路已经足够
 * 让一个群露面 —— 面板提示也是这么写的(「从机器人被 @ 的群消息事件捞」)。
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
		// 只认 C2C 用户 openid(author.user_openid)/ FRIEND_ADD 顶层 openid。绝不回退
		// author.member_openid —— 那是群成员域的身份,与 C2C 用户 openid 是两个命名空间,
		// 拿它当 C2C 地址会发错人 / 404。
		const openid = (author?.user_openid ?? data.openid) as string | undefined;
		if (!openid) return null;
		return { scope: "private", openid, ...(hint ? { displayHint: hint } : {}) };
	}
	return null;
}

/** 一条 C2C 私聊消息 —— 审批指令(主人回的 y/n)就是从这儿进来的。 */
/**
 * 从 C2C 事件取私聊正文。**只认 C2C_MESSAGE_CREATE**。
 *
 * 与 {@link extractQQDiscoveredSession} 分成两个函数而不是合并:那个只要 openid
 * (拿来当推送地址,群和 C2C 都要),这个要正文且**只能是私聊** —— 群里有人打个 y
 * 不该把一份待审的周报发出去。合起来写迟早有人顺手把群那条也接上。
 *
 * `member_openid` 同样绝不回退,理由见 {@link extractQQDiscoveredSession}:那是群成员
 * 域的身份,与 C2C 用户 openid 是两个命名空间,拿它去比对主人身份会认错人。
 *
 * 交出去的 `address` 就是 C2C 用户 openid,与 PushTarget 里存的 `session.userOpenid`
 * 同一命名空间 —— 形状与 OneBot 那边一样,消费者不分平台。
 */
export function extractQQPrivateMessage(
	eventType: string,
	data: Record<string, unknown>,
): InboundPrivateMessage | null {
	if (eventType !== "C2C_MESSAGE_CREATE") return null;
	const author = data.author as { user_openid?: string } | undefined;
	const userOpenid = author?.user_openid;
	if (typeof userOpenid !== "string" || !userOpenid) return null;
	const content = data.content;
	if (typeof content !== "string" || !content.trim()) return null;
	return { address: userOpenid, text: content };
}

/**
 * 从群事件取正文。认两种:`GROUP_AT_MESSAGE_CREATE`(@ 了机器人)与 `GROUP_MESSAGE_CREATE`
 * (群主把消息范围放到「获取群内全部消息」后,不 @ 的消息走这个)。三档范围是 QQ 那边的
 * 设置,这里收到什么交什么。@ 消息的正文里可能带 `<@!id>` 与前导空格,原样交出。
 *
 * 与 {@link extractQQPrivateMessage} 分开:那条是主人专属的指令入口,这条是谁都能触发的
 * 群消息,合起来写迟早有人把群那条也当私聊认。
 *
 * 不带消息 id:官机的主动群消息已经没有条数限制(2026-09-02 主人告知),回复走主动路径,
 * 被动回复的 `msg_id` 用不上 —— 留一个没人接的字段只会让人以为被动路径存在。
 */
export function extractQQGroupMessage(
	eventType: string,
	data: Record<string, unknown>,
): InboundGroupMessage | null {
	if (eventType !== "GROUP_AT_MESSAGE_CREATE" && eventType !== "GROUP_MESSAGE_CREATE") return null;
	const groupOpenid = data.group_openid;
	if (typeof groupOpenid !== "string" || !groupOpenid) return null;
	const content = data.content;
	if (typeof content !== "string" || !content.trim()) return null;
	const author = data.author as { member_openid?: string } | undefined;
	const memberOpenid = author?.member_openid;
	// address = 群 openid(与 PushTarget 的 `session.groupOpenid` 同一命名空间);senderId =
	// 发言者在群成员域的 openid,只当身份用。官机的群消息没有分享卡这一说。
	return {
		address: groupOpenid,
		senderId: typeof memberOpenid === "string" ? memberOpenid : "",
		text: content,
		sharedLinks: [],
	};
}

/** 单 adapter 发现列表上限 —— 内存 ring buffer,超出丢最旧(纯便利选择器,不持久化)。 */
const QQ_DISCOVERY_MAX_PER_CONNECTION = 50;

/** 发现表里的一条:发现到的会话 + 最近见到的时间戳(ms)。只在适配器内部用,时间不出适配器。 */
type QQDiscoveredEntry = QQDiscoveredSession & { lastSeenMs: number };

/**
 * per-adapter「最近活跃会话」发现表 —— 群/C2C 的 openid 只能从入站事件捞,做成内存
 * ring buffer(不落盘)供面板选择器列出。一旦用户把某会话做成 PushTarget,openid 就存进
 * target,发现表只是一次性选择器;重启清空靠机器人再被 @ 唤回。
 */
export interface QQSessionRegistry {
	/** 记一次发现:同 scope+openid 去重(更新 lastSeen/hint 并移到最前),超容丢最旧。 */
	record(connectionId: string, session: QQDiscoveredSession, atMs: number): void;
	/** 列出某 adapter 最近发现的会话(最近优先)。 */
	list(connectionId: string): QQDiscoveredEntry[];
	/** 删除某 adapter 的全部发现(reconcile 删该 adapter 时)。 */
	clear(connectionId: string): void;
}

export function createQQSessionRegistry(opts?: { maxPerConnection?: number }): QQSessionRegistry {
	const max = opts?.maxPerConnection ?? QQ_DISCOVERY_MAX_PER_CONNECTION;
	const byConnection = new Map<string, QQDiscoveredEntry[]>();
	const keyOf = (s: { scope: string; openid: string }) => `${s.scope}:${s.openid}`;

	return {
		record(connectionId, session, atMs) {
			const prev = byConnection.get(connectionId) ?? [];
			// 后到的事件没带 displayHint(GROUP_ADD_ROBOT 不带用户名)时留着先前记住的那个:
			// 群事件本来就不带群名,那个 hint 是面板上唯一能认的东西。带了就以新的为准。
			const known = prev.find((e) => keyOf(e) === keyOf(session));
			const next = prev.filter((e) => keyOf(e) !== keyOf(session));
			next.unshift({ ...known, ...session, lastSeenMs: atMs });
			if (next.length > max) next.length = max;
			byConnection.set(connectionId, next);
		},
		list(connectionId) {
			return [...(byConnection.get(connectionId) ?? [])];
		},
		clear(connectionId) {
			byConnection.delete(connectionId);
		},
	};
}

// ---------------------------------------------------------------------------
// WS 网关长连接 —— 复刻 @satorijs/adapter-qq/src/ws.ts 握手 + onebot ForwardConn 重连
// ---------------------------------------------------------------------------

const QQ_RECONNECT_BASE_MS = 1_000;
const QQ_RECONNECT_MAX_MS = 30_000;
/** HELLO 帧未带 heartbeat_interval 时的兜底心跳间隔(ms)。 */
const QQ_DEFAULT_HEARTBEAT_MS = 45_000;

function qqRawToString(raw: RawData): string {
	if (typeof raw === "string") return raw;
	if (Buffer.isBuffer(raw)) return raw.toString("utf8");
	if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
	return Buffer.from(raw as ArrayBuffer).toString("utf8");
}

export interface QQGatewayConnOptions {
	/** 网关长连经这个集成的请求客户端建(不带浏览器身份)。 */
	http: HttpClient;
	connectionId: string;
	/** 解析 wss 网关地址(REST GET /gateway → url,沙箱改写)。每次连接前调,便于换 host。 */
	resolveGatewayUrl(): Promise<string>;
	/** 取当前 App Access Token(token manager 已缓存/刷新),用于 IDENTIFY/RESUME。 */
	getToken(): Promise<string>;
	/** 捞到群/C2C 会话时回调 —— adapter 落进 {@link QQSessionRegistry}。 */
	onDiscovered(session: QQDiscoveredSession): void;
	/**
	 * 收到 C2C 私聊正文时回调 —— 审批指令(主人回的 y/n)靠它送出去。
	 *
	 * 可选:没接就当没有入站,这条连接退回纯 push-only(与接这个功能之前一样)。
	 * 由回调那边决定认不认发送者,这里只负责搬运。
	 */
	onInboundPrivate?(msg: InboundPrivateMessage): void;
	/** 可选:群消息出口(链接解析)。不接就不解析群消息。 */
	onInboundGroup?(msg: InboundGroupMessage): void;
	serviceCtx: ServiceContext;
	logger: Logger;
	/** 订阅 intents,默认 {@link QQ_PUSH_INTENTS}。 */
	intents?: number;
	/** 指数退避基数(ms),默认 1000。测试注入小值加速。 */
	reconnectBaseMs?: number;
	/** 指数退避上限(ms),默认 30000。测试注入小值,免得反复失败后退避涨到好几秒。 */
	reconnectMaxMs?: number;
	/** 是否记录 RECONNECT/RESUMED 事件日志。QQ 官方网关约每 30 分钟主动要求重连一次,
	 * 属正常协议行为;缺省/false 时静默,避免刷屏。取活值(而非创建时定值)—— 每次
	 * 事件发生才读,配置热更新(见 reconcile 的 logReconnectsBox 同步)无需重建连接。 */
	shouldLogReconnects?(): boolean;
	/**
	 * 从开机或掉线起连续不在线满 {@link offlineReportMs} 才叫一次(带最近一次的错误原话);
	 * 几秒内就回来的(QQ 约每 30 分钟主动要求重连一次)不算。
	 */
	onOffline?(reason: string | null): void;
	/** 报过 {@link onOffline} 之后又 READY / RESUMED 了,叫一次。没报过不叫。 */
	onOnline?(): void;
	/** 连续不在线多久才算「连不上」,默认 60 秒。测试注入小值加速。 */
	offlineReportMs?: number;
}

/** 网关连续不在线多久才报,毫秒。 */
export const QQ_GATEWAY_OFFLINE_REPORT_MS = 60_000;

export interface QQGatewayConn {
	/** 是否已 READY/RESUMED 在线。 */
	isOnline(): boolean;
	/** 最近一次连接错误(probe / UI 展示用)。 */
	readonly lastError: string | null;
	/** 关闭长连:停心跳/重连定时器,关 socket,不再重连。幂等。 */
	close(): void;
}

/**
 * 每 adapter 一条 QQ 网关长连。HELLO→(首连)IDENTIFY /(重连未失效)RESUME;心跳 op1 +
 * ack op11 僵尸检测;DISPATCH 事件经 {@link extractQQDiscoveredSession} 捞 openid 回调;
 * 断线指数退避重连(close code 决定清会话重连 vs 续连)。push-only:入站消息只用来捞
 * openid 与监听审核,不回消息。
 */
export function createQQGatewayConn(opts: QQGatewayConnOptions): QQGatewayConn {
	const { connectionId, serviceCtx, logger } = opts;
	const intents = opts.intents ?? QQ_PUSH_INTENTS;
	const reconnectBase = opts.reconnectBaseMs ?? QQ_RECONNECT_BASE_MS;
	const reconnectMax = opts.reconnectMaxMs ?? QQ_RECONNECT_MAX_MS;

	let ws: WebSocketLike | null = null;
	let heartbeatTimer: Disposable | null = null;
	let reconnectTimer: Disposable | null = null;
	let attempt = 0;
	let closed = false;
	let online = false;

	let sessionId = "";
	let lastSeq: number | null = null;
	let acked = true;
	const state = { lastError: null as string | null };

	// --- 连不上的上报 ---
	const offlineReportMs = opts.offlineReportMs ?? QQ_GATEWAY_OFFLINE_REPORT_MS;
	let offlineTimer: Disposable | null = null;
	let reportedOffline = false;

	/** 从现在起计「连续不在线」;已经在计、已经报过、关了、在线都不用再起。 */
	function armOfflineTimer(): void {
		if (offlineTimer || reportedOffline || closed || online) return;
		offlineTimer = serviceCtx.setTimeout(() => {
			offlineTimer = null;
			if (closed || online) return;
			reportedOffline = true;
			opts.onOffline?.(state.lastError);
		}, offlineReportMs);
	}

	/** 在线了(READY / RESUMED):计时作废;报过的叫一声。 */
	function markOnline(): void {
		online = true;
		offlineTimer?.dispose();
		offlineTimer = null;
		if (reportedOffline) {
			reportedOffline = false;
			opts.onOnline?.();
		}
	}

	function clearHeartbeat(): void {
		heartbeatTimer?.dispose();
		heartbeatTimer = null;
	}

	function heartbeat(): void {
		if (!ws || ws.readyState !== WS_OPEN) return;
		if (!acked) {
			// 上一拍心跳没收到 ACK = 僵尸连接,关掉触发重连(对齐 @satorijs)。
			logger.warn(`[qq] adapter=${connectionId} 心跳无 ACK,判定僵尸连接,关闭重连`);
			try {
				ws.close();
			} catch {
				/* ignore */
			}
			return;
		}
		try {
			ws.send(JSON.stringify(buildQQHeartbeat(lastSeq)));
			acked = false;
		} catch {
			/* close 事件会接管清理 */
		}
	}

	async function onHello(heartbeatInterval: number): Promise<void> {
		let token: string;
		try {
			token = await opts.getToken();
		} catch (e) {
			state.lastError = t("qqOfficial.token.getFailed", { error: String(e) });
			logger.warn(`[qq] adapter=${connectionId} ${state.lastError}`);
			try {
				ws?.close();
			} catch {
				/* ignore */
			}
			return;
		}
		// 有 sessionId(重连未失效)→ RESUME 续连;否则首次 IDENTIFY。
		const frame = sessionId
			? buildQQResume(token, sessionId, lastSeq ?? 0)
			: buildQQIdentify(token, intents);
		try {
			ws?.send(JSON.stringify(frame));
		} catch {
			/* ignore */
		}
		acked = true;
		clearHeartbeat();
		heartbeatTimer = serviceCtx.setInterval(() => heartbeat(), heartbeatInterval);
	}

	/**
	 * 一路入站消息:没接就连解析都不做,解出来了才交出去。**catch 不能省** —— 这条
	 * 连接同时担着推送,下游处理里抛个错不该把整条长连带走。每加一路入站都要重述
	 * 一遍这条规矩,所以只写这一处。
	 */
	function deliver<T>(
		sink: ((msg: T) => void) | undefined,
		parse: () => T | null,
		route: "private" | "group",
	) {
		if (!sink) return;
		const msg = parse();
		if (!msg) return;
		try {
			sink(msg);
		} catch (err) {
			logger.warn(
				`[qq] adapter=${connectionId} 处理入站${route === "private" ? "私聊" : "群消息"}失败: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	function onDispatch(frame: QQFrame): void {
		if (typeof frame.s === "number") lastSeq = frame.s;
		const eventName = frame.t;
		const d = (frame.d ?? {}) as Record<string, unknown>;
		if (eventName === "READY") {
			if (typeof d.session_id === "string") sessionId = d.session_id;
			markOnline();
			logger.info(`[qq] adapter=${connectionId} 网关已就绪(READY)`);
			return;
		}
		if (eventName === "RESUMED") {
			markOnline();
			if (opts.shouldLogReconnects?.())
				logger.info(`[qq] adapter=${connectionId} 网关已续连(RESUMED)`);
			return;
		}
		if (eventName === "MESSAGE_AUDIT_REJECT") {
			logger.warn(`[qq] adapter=${connectionId} 消息审核未通过(MESSAGE_AUDIT_REJECT)`);
			return;
		}
		if (typeof eventName === "string") {
			const discovered = extractQQDiscoveredSession(eventName, d);
			if (discovered) opts.onDiscovered(discovered);
			// 私聊正文另走一路(只有 C2C 认),群消息再一路。
			deliver(opts.onInboundPrivate, () => extractQQPrivateMessage(eventName, d), "private");
			deliver(opts.onInboundGroup, () => extractQQGroupMessage(eventName, d), "group");
		}
	}

	function onMessage(raw: RawData): void {
		const frame = parseQQFrame(qqRawToString(raw));
		if (!frame) return;
		switch (frame.op) {
			case QQ_OPCODE.HELLO: {
				const d = (frame.d ?? {}) as { heartbeat_interval?: number };
				void onHello(d.heartbeat_interval ?? QQ_DEFAULT_HEARTBEAT_MS);
				break;
			}
			case QQ_OPCODE.HEARTBEAT_ACK:
				acked = true;
				break;
			case QQ_OPCODE.INVALID_SESSION:
				sessionId = "";
				lastSeq = null;
				logger.warn(`[qq] adapter=${connectionId} 会话失效(INVALID_SESSION),将重新鉴权`);
				break;
			case QQ_OPCODE.RECONNECT:
				if (opts.shouldLogReconnects?.())
					logger.warn(`[qq] adapter=${connectionId} 服务端要求重连(RECONNECT)`);
				try {
					ws?.close();
				} catch {
					/* ignore */
				}
				break;
			case QQ_OPCODE.DISPATCH:
				onDispatch(frame);
				break;
		}
	}

	function scheduleReconnect(): void {
		if (closed || reconnectTimer) return;
		const base = Math.min(reconnectBase * 2 ** attempt, reconnectMax);
		const jitter = Math.round(base * (0.8 + Math.random() * 0.4)); // ±20% 抖动
		attempt += 1;
		reconnectTimer = serviceCtx.setTimeout(() => {
			reconnectTimer = null;
			void connect();
		}, jitter);
	}

	async function connect(): Promise<void> {
		if (closed) return;
		let url: string;
		try {
			url = await opts.resolveGatewayUrl();
		} catch (e) {
			state.lastError = t("qqOfficial.gateway.resolveFailed", { error: String(e) });
			scheduleReconnect();
			return;
		}
		if (closed) return;
		// 不带浏览器身份、不带 cookie:网关握手今天就没有任何附加头。
		const opened = opts.http.websocket(url, { bare: true });
		if (!opened.ok) {
			// 地址不合法 / 协议不收:与原来 `new WebSocket` 同步抛的那一路一样,记下原话、退避重连。
			state.lastError = opened.message;
			scheduleReconnect();
			return;
		}
		const socket = opened.socket;
		ws = socket;
		socket.on("open", () => {
			attempt = 0;
			state.lastError = null;
		});
		socket.on("message", (raw) => onMessage(raw as RawData));
		socket.on("error", (err) => {
			state.lastError = (err as Error).message;
		});
		socket.on("close", (code) => {
			online = false;
			armOfflineTimer();
			clearHeartbeat();
			if (ws === socket) ws = null;
			// 4000+ 非限流/超时 → 清会话(强制重新 IDENTIFY);否则保留以便 RESUME。
			if (qqShouldResetSessionOnClose(code as number)) {
				sessionId = "";
				lastSeq = null;
			}
			if (!closed) scheduleReconnect();
		});
	}

	armOfflineTimer();
	void connect();

	return {
		get lastError() {
			return state.lastError;
		},
		isOnline() {
			return online;
		},
		close() {
			closed = true;
			clearHeartbeat();
			reconnectTimer?.dispose();
			reconnectTimer = null;
			offlineTimer?.dispose();
			offlineTimer = null;
			online = false;
			try {
				ws?.close();
			} catch {
				/* ignore */
			}
			ws = null;
		},
	};
}

/**
 * QQ 官方机器人(q.qq.com)推送目标 → 发消息 REST endpoint。
 * - channel(频道子频道):POST /channels/{channelId}/messages
 * - group(群):POST /v2/groups/{groupOpenid}/messages
 * - private(C2C 单聊):POST /v2/users/{userOpenid}/messages
 *
 * 会话缺对应字段时回 `invalid` —— 发送前运行期校验(群/C2C 的 openid 只能从入站
 * 事件捞,缺失即配置未就绪),不浪费一次注定失败的 REST 往返。
 */
export function qqMessageEndpoint(
	scope: PushTargetScope,
	address: string,
): Result<{ path: string }> {
	if (!address) {
		const what =
			scope === "channel" ? "channelId" : scope === "group" ? "groupOpenid" : "userOpenid";
		return fail("invalid", `${scope}: ${what} missing`);
	}
	if (scope === "channel") return ok({ path: `/channels/${address}/messages` });
	if (scope === "group") return ok({ path: `/v2/groups/${address}/messages` });
	return ok({ path: `/v2/users/${address}/messages` });
}

// ---------------------------------------------------------------------------
// REST 发送原语 —— 鉴权头 / 富媒体上传路径 / A+ 投递语义判定
// ---------------------------------------------------------------------------

/** REST 鉴权头:`Authorization: QQBot {token}` + `X-Union-Appid: {appId}`。 */
export function qqRestHeaders(token: string, appId: string): Record<string, string> {
	return { authorization: `QQBot ${token}`, "x-union-appid": appId };
}

/** 群/C2C 富媒体上传 endpoint(两步发图第一步,拿 file_info)。 */
export function qqFilesPath(scope: "group" | "private", openid: string): string {
	return scope === "group" ? `/v2/groups/${openid}/files` : `/v2/users/${openid}/files`;
}

export type QQSendResult = Result<{ id?: string; pendingAudit?: true; auditId?: string }>;

/**
 * 对端回了非 2xx:状态码 → 标准码。`upstreamCode` 放 QQ 自己的错误码;错误体里没有码时
 * 放 HTTP 状态,写成 `http:<status>`(与 QQ 的数字码分得开)。
 */
function httpFailure(status: number, message: string, qqCode?: number): Failure {
	const upstreamCode = qqCode ?? `http:${status}`;
	if (status === 401 || status === 403) return fail("unauthorized", message, { upstreamCode });
	if (status === 404 || status === 410) return fail("not_found", message, { upstreamCode });
	if (status === 429) return fail("rate_limited", message, { upstreamCode });
	if (status >= 400 && status < 500) return fail("invalid", message, { upstreamCode });
	return fail("unavailable", message, { upstreamCode });
}

/** 换 token 没成 → 失败。它发生在任何一条消息发出去之前。 */
function tokenFailure(e: unknown): Failure {
	const message = t("qqOfficial.token.fetchFailed", { error: String(e) });
	if (e instanceof QQTokenError) {
		// 回了 2xx 却没给 token:回应不是约定的形状。
		return e.httpStatus === undefined
			? fail("invalid", message)
			: httpFailure(e.httpStatus, message);
	}
	return fail("unavailable", message);
}

/**
 * 解析发送响应为 A+ 投递语义(提交即成功)。主动推送几乎总是走审核:HTTP 202 +
 * `code 304023` + `audit_id` —— 算「已提交·审核中」(ok,后台听 MESSAGE_AUDIT 才知拒绝);
 * 200 + id = 已发;2xx 但带非零业务 code(无 id/audit)= 失败;非 2xx = 失败。
 *
 * 失败的码(ADR-0026):非 2xx 按 HTTP 状态翻;2xx 包着的业务错误这里没有对照,记 `unknown`。
 * QQ 自己的错误码一律只进 `upstreamCode`。
 */
export function interpretQQSend(status: number, body: unknown): QQSendResult {
	const b = (body ?? {}) as {
		id?: unknown;
		code?: unknown;
		message?: unknown;
		msg?: unknown;
		data?: { message_audit?: { audit_id?: unknown } };
		message_audit?: { audit_id?: unknown };
	};
	const auditId = b.data?.message_audit?.audit_id ?? b.message_audit?.audit_id;
	const code = typeof b.code === "number" ? b.code : undefined;
	const message =
		(typeof b.message === "string" && b.message) ||
		(typeof b.msg === "string" && b.msg) ||
		`HTTP ${status}`;
	if (status >= 200 && status < 300) {
		// audit 判定收进 2xx 门内:主动推送的审核回执是 HTTP 202;非 2xx 错误体即便
		// 回带 audit_id 也是失败,不能误判成「已提交·审核中」而吞掉一条发不出去的推送。
		if (typeof auditId === "string") return ok({ pendingAudit: true as const, auditId });
		if (typeof b.id === "string" || typeof b.id === "number") return ok({ id: String(b.id) });
		// 2xx 但带非零业务 code 且无 id/audit = QQ 以 200 包装的业务错误。
		if (code !== undefined && code !== 0) {
			return fail("unknown", `code ${code}: ${message}`, { upstreamCode: code });
		}
		return ok();
	}
	return httpFailure(status, code !== undefined ? `code ${code}: ${message}` : message, code);
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

export interface QQFileMedia {
	file_info: string;
	file_uuid?: string;
	ttl?: number;
	[key: string]: unknown;
}

export interface QQV2MessageBody {
	content: string;
	msg_type: number;
	media?: QQFileMedia;
}

/**
 * 群/C2C 单条消息体。带 `media` → 富媒体消息(msg_type 7;content 作图说明,QQ 要求
 * content 非空,空时占位一个空格);否则纯文本(msg_type 0)。一条 media 消息只能带一张图,
 * 多图由 adapter 拆成多条消息。media 需透传 /files 返回的完整对象(file_uuid/file_info/ttl),
 * 对齐 @satorijs/adapter-qq;只塞 file_info 会让部分 QQ 官方接口拒绝发送。
 */
export function buildQQV2Message(opts: { content?: string; media?: QQFileMedia }): QQV2MessageBody {
	if (opts.media) {
		return {
			content: opts.content && opts.content.length > 0 ? opts.content : " ",
			msg_type: QQ_MSG_TYPE.MEDIA,
			media: opts.media,
		};
	}
	return { content: opts.content ?? "", msg_type: QQ_MSG_TYPE.TEXT };
}

/**
 * 把图集合并成一条多图 markdown 文本(QQ 原生 markdown 图片语法
 * `![图片 #宽px #高px](url)`,每行一图)。**这是绕过 QQ「无合并转发」的关键** ——
 * 私域机器人可一条消息带多张图。尺寸来自 B站图集元数据;缺失则退化为无尺寸
 * `![图片](url)`(QQ 可能按默认尺寸渲染)。依赖 QQ 能拉取图片 url(hdslb 公网可达)。
 */
export function buildQQMarkdownGallery(
	images: { url: string; width?: number; height?: number }[],
): string {
	return images
		.map((img) => {
			const dim = img.width && img.height ? ` #${img.width}px #${img.height}px` : "";
			return `![${t("qqOfficial.markdown.imageAlt")}${dim}](${img.url})`;
		})
		.join("\n");
}

/**
 * 群/C2C 原生 markdown 消息体(msg_type 2)。仅私域机器人可发原生 markdown;
 * 公域需报备模板,不走这里。不带顶层 content(对齐 @satorijs:markdown 时 delete content)。
 */
export function buildQQV2MarkdownMessage(content: string): {
	msg_type: number;
	markdown: { content: string };
} {
	return { msg_type: QQ_MSG_TYPE.MARKDOWN, markdown: { content } };
}

/**
 * 一条待发送片段。QQ 官方一条 media 消息只能带一张图,故图集/composite 会展开成多片段,
 * adapter 按序逐条发(图片片段:群/C2C 先富媒体上传拿 file_info 再发 media 消息;
 * 频道走 multipart `file_image`)。
 */
export type QQSendPart =
	| { kind: "text"; text: string }
	| { kind: "image-buffer"; buffer: Buffer; caption?: string }
	| { kind: "image-url"; url: string; width?: number; height?: number; caption?: string };

function withCaption(part: QQSendPart, caption: string): QQSendPart {
	if (part.kind === "text") return part;
	const prev = part.caption?.trim();
	const next = caption.trim();
	if (!next) return part;
	return { ...part, caption: prev ? `${prev}\n${next}` : next };
}

/**
 * 对齐 @satorijs/adapter-qq 的「先图后文」:图片片段后紧跟的文本塞进同一条
 * media 消息的 `content`,避免卡片图和通知文案被拆成两条 QQ 消息。
 */
function attachFollowingTextToImages(parts: QQSendPart[]): QQSendPart[] {
	const out: QQSendPart[] = [];
	for (let i = 0; i < parts.length; i += 1) {
		let part = parts[i];
		if (part?.kind === "image-buffer" || part?.kind === "image-url") {
			const text: string[] = [];
			while (parts[i + 1]?.kind === "text") {
				const next = parts[i + 1];
				if (next?.kind === "text" && next.text.trim().length > 0) text.push(next.text);
				i += 1;
			}
			part = withCaption(part, text.join("\n"));
		}
		if (part) out.push(part);
	}
	return out;
}

/**
 * 把平台中立 `NotificationPayload` 翻译成有序发送片段。QQ 无「合并转发」,多图一律展开成
 * 多条;`image-group` 的 `mergeForward` 标志对 QQ 无意义。卡片 Buffer 走 image-buffer
 * (群/C2C base64 上传 / 频道 multipart),图集 URL 走 image-url。
 */
export function qqPayloadToParts(payload: NotificationPayload): QQSendPart[] {
	switch (payload.kind) {
		case "text":
			return [{ kind: "text", text: payload.text }];
		case "image":
			return [{ kind: "image-buffer", buffer: payload.image.buffer, caption: payload.caption }];
		case "image-group":
			// QQ 无合并转发 —— mergeForward 标志忽略,每张图展开成独立片段(尺寸透传给 markdown 用)。
			return imageGroupUrls(payload.images).map((img) => ({
				kind: "image-url" as const,
				...img,
			}));
		case "composite": {
			const parts: QQSendPart[] = [];
			for (const seg of payload.segments) {
				if (seg.kind === "text") parts.push({ kind: "text", text: seg.text });
				else if (seg.kind === "image") parts.push({ kind: "image-buffer", buffer: seg.buffer });
				else if (seg.kind === "link")
					parts.push({ kind: "text", text: seg.title ? `${seg.title} ${seg.href}` : seg.href });
				// at-all:QQ 群 @全体需特殊权限,一律丢弃。推送层据本适配器的 atAll 能力(不支持)不给本平台
				// 单发 @全体,这里只是兜底 —— 混在别的段里时不让它阻断那条消息。
			}
			return attachFollowingTextToImages(parts);
		}
		case "native-share":
			// 官机发不了 ark / 小程序,能给的只有标题加链接(与 webhook 的降级同形状)。
			// 推送层本不会把这种 payload 路到官机(它的 capabilities 里没这一项),留着是
			// 为了别悄悄发出去一条空消息 —— `default: return []` 那样连报错都无从查起。
			return [{ kind: "text", text: `${payload.title}\n${payload.webUrl}` }];
	}
}

// ---------------------------------------------------------------------------
// PlatformAdapter 工厂 —— send 编排(上传→media)+ probe/reconcile/dispose 生命周期
// ---------------------------------------------------------------------------

/**
 * 发消息的两个原语共用的收尾:没走通(连不上、超时、被中止)抛错 —— `send` 的循环接住记成
 * unavailable,与原生 fetch 连不上抛错时同一条路;走通了回 `{status, body}`(body 解析失败回退 {})。
 */
function qqSendOutcome(res: Result<HttpResponse>): { status: number; body: unknown } {
	if (!res.ok) throw new Error(res.message);
	const parsed = res.json();
	return { status: res.status, body: parsed.ok ? parsed.value : {} };
}

/** JSON POST,返回 `{status, body}`(body 解析失败回退 {})。 */
async function qqPostJson(
	http: HttpClient,
	base: string,
	headers: Record<string, string>,
	path: string,
	body: unknown,
): Promise<{ status: number; body: unknown }> {
	return qqSendOutcome(
		await qqFetch(http, `${base}${path}`, {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
}

/** 频道图片走 multipart `file_image`(直传 Buffer,不需公网 URL,不设 content-type 让运行时补 boundary)。 */
async function qqPostChannelForm(
	http: HttpClient,
	base: string,
	headers: Record<string, string>,
	channelId: string,
	content: string,
	buffer: Buffer,
): Promise<{ status: number; body: unknown }> {
	const form = new FormData();
	form.append("content", content);
	form.append("file_image", new Blob([buffer]), "image.png");
	return qqSendOutcome(
		await qqFetch(http, `${base}/channels/${channelId}/messages`, {
			method: "POST",
			headers,
			body: form,
		}),
	);
}

/** 群/C2C 富媒体两步第一步:上传拿 file_info。 */
async function qqUploadMedia(
	http: HttpClient,
	base: string,
	headers: Record<string, string>,
	scope: "group" | "private",
	openid: string,
	upload: QQFileUploadBody | { file_type: number; srv_send_msg: boolean; url: string },
): Promise<Result<{ media: QQFileMedia }>> {
	const { status, body } = await qqPostJson(
		http,
		base,
		headers,
		qqFilesPath(scope, openid),
		upload,
	);
	const data = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
	const fileInfo = data.file_info;
	if (typeof fileInfo === "string") return ok({ media: { ...data, file_info: fileInfo } });
	const verdict = interpretQQSend(status, body);
	// 回了 2xx 却没给 file_info:回应不是约定的形状。
	return verdict.ok ? fail("invalid", t("qqOfficial.upload.noFileInfo")) : verdict;
}

interface QQGuildChannel {
	channelId: string;
	name: string;
	/** QQ 子频道类型:0=文字(可发消息),其余(语音/直播/论坛…)推送用不上。 */
	type: number;
}
export interface QQGuild {
	guildId: string;
	name: string;
	channels: QQGuildChannel[];
}

/**
 * REST 枚举频道(频道 scope target 选择器数据源,与群/C2C 的「只能从事件捞」不同——
 * 频道有「列我加入的频道服务器」接口)。token → `GET /users/@me/guilds` → 逐个
 * `GET /guilds/{id}/channels`,只保留文字子频道(type 0)。某 guild 子频道列失败则跳过
 * 不整体崩。on-demand 一次性 token(不复用网关 manager,UI 偶发调用可接受)。
 */
export async function fetchQQGuildChannels(
	http: HttpClient,
	cfg: QQOfficialConnectionSettings,
	signal?: AbortSignal,
): Promise<QQGuild[]> {
	const { token } = await fetchAppAccessToken(http, cfg.appId, cfg.appSecret, signal);
	const base = qqApiBase(cfg.sandbox);
	const headers = qqRestHeaders(token, cfg.appId);
	const guildsRes = await qqFetch(http, `${base}/users/@me/guilds`, { headers, signal });
	// 没走通(含路由断开中止了请求)抛错,`listAddressCandidates` 接住记成 unavailable。
	if (!guildsRes.ok) throw new Error(guildsRes.message);
	if (!guildsRes.isSuccess) {
		throw new Error(t("qqOfficial.channels.guildsHttpFailed", { status: guildsRes.status }));
	}
	const guildsJson = guildsRes.json();
	const guilds = (guildsJson.ok ? guildsJson.value : []) as Array<{ id?: string; name?: string }>;
	const out: QQGuild[] = [];
	for (const g of guilds) {
		if (!g.id) continue;
		const chRes = await qqFetch(http, `${base}/guilds/${g.id}/channels`, { headers, signal });
		if (!chRes.ok) throw new Error(chRes.message);
		if (!chRes.isSuccess) continue; // 读不了该 guild 子频道 → 跳过,不整体失败
		const channelsJson = chRes.json();
		const channels = (channelsJson.ok ? channelsJson.value : []) as Array<{
			id?: string;
			name?: string;
			type?: number;
		}>;
		out.push({
			guildId: g.id,
			name: g.name ?? g.id,
			channels: channels
				.filter((ch) => ch.type === 0 && typeof ch.id === "string")
				.map((ch) => ({ channelId: ch.id as string, name: ch.name ?? "", type: 0 })),
		});
	}
	return out;
}

export interface QQOfficialAdapterOptions {
	logger: Logger;
	serviceCtx: ServiceContext;
	/**
	 * 发现表 —— 网关捞到的 openid 落这,`listAddressCandidates` 读它。缺省适配器自己建一张
	 * (表只归适配器用,宿主不持有);只在测试里想预先塞几条记录时传。
	 */
	registry?: QQSessionRegistry;
	/** 语言变了的通知口:开着的「网关连不上」随语言重报一遍。 */
	locale: Pick<LocaleReader, "onChange">;
}

interface QQLive {
	tm: QQTokenManager;
	conn: QQGatewayConn;
	fingerprint: string;
	/** `logReconnects` 的活值容器 —— 这个开关不影响连接本身,不该被塞进
	 * {@link qqConnectionFingerprint}(会导致纯改日志偏好也触发断连重建)。reconcile
	 * 每轮同步这个容器,conn 通过 `shouldLogReconnects` 读它,做到不重建连接也能热更。 */
	logReconnectsBox: { value: boolean };
}

function qqConnectionFingerprint(cfg: QQOfficialConnectionSettings): string {
	return JSON.stringify({ appId: cfg.appId, appSecret: cfg.appSecret, sandbox: cfg.sandbox });
}

/**
 * 凭据齐不齐 —— 存储期允许空 appSecret(见 `QQOfficialConnectionSettingsSchema`:脱敏备份
 * 恢复回来就是空的),所以「能不能真的连上去」得由运行期自己判断。建连(reconcile)
 * 与投递(isAvailable)两条路都走这一个谓词,不会一边挡一边放。
 */
function isConnectable(cfg: QQOfficialConnectionSettings): boolean {
	return cfg.appId.length > 0 && cfg.appSecret.length > 0;
}

/**
 * 这个 adapter 认的那一档连接 —— `isMine(c)` 收窄之后的形状,`settings` 跟着窄。
 * **宿主递来的连接,`settings` 一律是按 `QQOfficialConnectionSettingsSchema` 解过的输出**
 * (派发器与适配器上下文保证),这里只认键、不再解。内部那些 helper 一律收它:
 * 「这是条官机连接」只在几个入口各判一次。
 */
type QQOfficialConnection = Connection & { settings: QQOfficialConnectionSettings };

/** 适配器键。适配器的 `adapterKey`、下面的设置段与 `isMine` 引同一个,免得两处写漂。 */
const ADAPTER_KEY = "qq-official";

/**
 * 登记进配置仓的那一段(ADR-0025 决策 2:每个拿到集成上下文的集成都有一段)。今天它没有任何格 ——
 * 连接的设置住连接自己身上,不在集成级。
 */
export const qqOfficialSettingsSegment: IntegrationSettingsSegment = {
	key: ADAPTER_KEY,
	schema: z.object({}),
};

const isMine = (c: Connection): c is QQOfficialConnection => c.adapterKey === ADAPTER_KEY;

/** 网关长连要用的那几个上下文口:入站交宿主,「连不上」报问题。 */
type GatewayCtx = Pick<
	PlatformAdapterContext,
	"http" | "inbound" | "reportProblem" | "resolveProblem"
>;

/** 网关连续一分钟连不上的问题码(关于这条连接,只进表)。 */
const GATEWAY_OFFLINE_CODE = "gateway_offline";

/**
 * QQ 官方机器人(q.qq.com)平台 adapter。有状态:每 adapter 一条 WS 网关长连(捞 openid
 * 进 registry)+ 一个 token 管理器,由 reconcile 按配置指纹 start/stop/rebind,dispose 全关。
 * send 把 NotificationPayload 译成有序片段逐条 REST 发(频道 multipart file_image;群/C2C
 * 富媒体两步上传→media),A+ 投递语义(202 审核中算 ok)。
 */
export function createQQOfficialAdapter(opts: QQOfficialAdapterOptions): PlatformAdapter {
	const { logger, serviceCtx } = opts;
	const registry = opts.registry ?? createQQSessionRegistry();
	const live = new Map<string, QQLive>();
	/**
	 * 已经报过「网关连不上」、还没清的连接及其原因:关连接时补一次清,免得问题挂到天荒地老;
	 * 语言变了按原因把这一句重报成新语言的字。
	 */
	const gatewayDown = new Map<string, string | null>();
	/** `start(ctx)` 接住的上报口与语言订阅;`stop()` 摘掉。 */
	let reporter: Pick<PlatformAdapterContext, "reportProblem"> | undefined;
	let localeSub: Disposable | undefined;

	/** 报(或重报)「网关连不上」:字在这一刻现出,原因记下来供换语言时再报。 */
	function reportGatewayOffline(
		ctx: Pick<PlatformAdapterContext, "reportProblem">,
		connectionId: string,
		reason: string | null,
	): void {
		gatewayDown.set(connectionId, reason);
		ctx.reportProblem({
			connectionId,
			code: GATEWAY_OFFLINE_CODE,
			message: reason
				? t("qqOfficial.gateway.offline", { reason })
				: t("qqOfficial.gateway.offlineNoReason"),
		});
	}
	/** reconcile 未跑时 send 仍可独立取 token 的兜底管理器(无网关连接)。 */
	const tokenOnly = new Map<string, QQTokenManager>();
	let disposed = false;
	/** `start(ctx)` 接住的请求客户端;还没 start(或已 stop)时是 `undefined`,出网的几个口回 unavailable。 */
	let http: HttpClient | undefined;
	/** 扫码建连接的任务表归适配器;`stop()` 时清空(没取走的草稿不留)。 */
	const bindAuth = createQQConnectionAuth({ logger, http: () => http });
	/** 能力都是静态事实,没有「探」这回事;`checkedAt` 就取适配器创建的这一刻(UTC ISO)。 */
	const adapterStartedAt = new Date().toISOString();

	function makeTokenManager(cfg: QQOfficialConnectionSettings, client: HttpClient): QQTokenManager {
		return createQQTokenManager({
			http: client,
			appId: cfg.appId,
			clientSecret: cfg.appSecret,
			serviceCtx,
			logger,
		});
	}

	function makeLive(connection: QQOfficialConnection, ctx: GatewayCtx): QQLive {
		const { inbound, http: client } = ctx;
		const cfg = connection.settings;
		const tm = makeTokenManager(cfg, client);
		const base = qqApiBase(cfg.sandbox);
		const logReconnectsBox = { value: cfg.logReconnects };
		const conn = createQQGatewayConn({
			http: client,
			connectionId: connection.id,
			resolveGatewayUrl: async () => {
				const token = await tm.getToken();
				const res = await qqFetch(client, `${base}/gateway`, {
					headers: qqRestHeaders(token, cfg.appId),
				});
				// 没走通抛错:连接循环记 lastError、退避重连(原生 fetch 连不上时同一条路)。
				if (!res.ok) throw new Error(res.message);
				const parsed = res.json();
				const body = (parsed.ok ? parsed.value : {}) as { url?: unknown };
				if (typeof body.url !== "string") throw new Error(t("qqOfficial.gateway.noUrl"));
				return qqGatewayUrlForHost(body.url, cfg.sandbox);
			},
			getToken: () => tm.getToken(),
			onDiscovered: (s) => registry.record(connection.id, s, Date.now()),
			// 平台不在这儿报:宿主按连接补(`ctx.inbound` 只收 `connectionId`)。
			onInboundPrivate: (m: InboundPrivateMessage) =>
				inbound.private(m, { connectionId: connection.id }),
			onInboundGroup: (m: InboundGroupMessage) => inbound.group(m, { connectionId: connection.id }),
			serviceCtx,
			logger,
			shouldLogReconnects: () => logReconnectsBox.value,
			// 网关只管入站(捞 openid、链接解析),推送走 REST 不受它影响:只进问题表,不私聊。
			onOffline: (reason) => reportGatewayOffline(ctx, connection.id, reason),
			onOnline: () => {
				gatewayDown.delete(connection.id);
				ctx.resolveProblem({
					connectionId: connection.id,
					code: GATEWAY_OFFLINE_CODE,
					notify: false,
				});
			},
		});
		return { tm, conn, fingerprint: qqConnectionFingerprint(cfg), logReconnectsBox };
	}

	/** send 取 token:优先复用网关连接的 manager,否则起一个仅 token 的兜底。 */
	function tokenManagerFor(connection: QQOfficialConnection, client: HttpClient): QQTokenManager {
		const l = live.get(connection.id);
		if (l) return l.tm;
		let tm = tokenOnly.get(connection.id);
		if (!tm) {
			tm = makeTokenManager(connection.settings, client);
			tokenOnly.set(connection.id, tm);
		}
		return tm;
	}

	function disposeAll(): void {
		if (disposed) return;
		disposed = true;
		bindAuth.clear();
		for (const l of live.values()) {
			l.conn.close();
			l.tm.dispose();
		}
		live.clear();
		for (const tm of tokenOnly.values()) tm.dispose();
		tokenOnly.clear();
	}
	serviceCtx.onDispose(disposeAll, "stop");

	/** 发一个片段。返回 REST `{status, body}`,或上传那一步的失败。 */
	async function sendPart(
		client: HttpClient,
		base: string,
		headers: Record<string, string>,
		scope: PushTargetScope,
		address: string,
		messagesPath: string,
		part: QQSendPart,
	): Promise<{ status: number; body: unknown } | Failure> {
		if (scope === "channel") {
			if (part.kind === "text") {
				return qqPostJson(client, base, headers, messagesPath, { content: part.text });
			}
			if (part.kind === "image-url") {
				return qqPostJson(client, base, headers, messagesPath, {
					content: part.caption ?? " ",
					image: part.url,
				});
			}
			return qqPostChannelForm(client, base, headers, address, part.caption ?? " ", part.buffer);
		}
		// group / private:文本直发;图片两步上传→media。
		const gScope = scope === "group" ? "group" : "private";
		if (part.kind === "text") {
			return qqPostJson(
				client,
				base,
				headers,
				messagesPath,
				buildQQV2Message({ content: part.text }),
			);
		}
		const upload =
			part.kind === "image-buffer"
				? buildQQFileUpload(part.buffer)
				: { file_type: QQ_FILE_TYPE_IMAGE, srv_send_msg: false, url: part.url };
		const up = await qqUploadMedia(client, base, headers, gScope, address, upload);
		if (!up.ok) return up;
		const content =
			part.kind === "image-buffer" || part.kind === "image-url" ? part.caption : undefined;
		return qqPostJson(
			client,
			base,
			headers,
			messagesPath,
			buildQQV2Message({ content, media: up.media }),
		);
	}

	function reconcile(connections: readonly Connection[], ctx: GatewayCtx): void {
		if (disposed) return;
		const desired = new Map<string, QQOfficialConnection>();
		for (const a of connections) {
			if (!isMine(a) || !a.enabled) continue;
			// 空密钥不建连。脱敏备份恢复回来的 adapter 就是这样(appSecret 被抹成空串),
			// 它仍然 enabled —— 拉起来只会拿空密钥反复撞网关。等用户把密钥填回来,
			// settings 一变 reconcile 自然会把它接上。
			if (!isConnectable(a.settings)) continue;
			desired.set(a.id, a);
		}
		// 删除/失效:不再期望或配置指纹变了 → 关连接、清发现表。
		for (const [id, l] of live) {
			const want = desired.get(id);
			if (!want || qqConnectionFingerprint(want.settings) !== l.fingerprint) {
				l.conn.close();
				l.tm.dispose();
				live.delete(id);
				registry.clear(id);
				// 连接不再适用(停用、删了、换了设置):报过的「网关连不上」随它清,不补「已恢复」。
				if (gatewayDown.delete(id)) {
					ctx.resolveProblem({ connectionId: id, code: GATEWAY_OFFLINE_CODE, notify: false });
				}
			}
		}
		// 新建:期望但无 live(或刚被指纹变更删掉)。
		for (const [id, a] of desired) {
			if (live.has(id)) continue;
			live.set(id, makeLive(a, ctx));
		}
		// logReconnects 不参与 fingerprint(纯日志偏好,不该触发断连重建)—— 每轮把
		// 期望配置的当前值同步进已存活连接的 box,做到不重连也能热更开关。
		for (const [id, l] of live) {
			const want = desired.get(id);
			if (want) l.logReconnectsBox.value = want.settings.logReconnects;
		}
		// 全清兜底 token-only:它仅在 reconcile 跑之前给 send 取 token 用。reconcile 后,
		// desired 的连接都有 live(自带 tm),非 desired 的会被 isAvailable 挡掉不再 send ——
		// 故此刻所有 tokenOnly 都是 stale。逐 id 只清 desired 会漏掉「曾被 send、后被删除/
		// 禁用」的连接,泄漏其刷新定时器,这里整张清掉根治。
		for (const tm of tokenOnly.values()) tm.dispose();
		tokenOnly.clear();
	}

	return {
		adapterKey: ADAPTER_KEY,
		settingsSchema: QQOfficialConnectionSettingsSchema,
		connectionAuth: bindAuth.auth,
		// 脸同平台表 `qq-official` 那一行(这个适配器只连这一个平台);连接配置项随 4-29 和表单一起设计。
		descriptor() {
			return {
				label: t("qqOfficial.adapter.label"),
				shortLabel: t("qqOfficial.adapter.shortLabel"),
				color: "#14b8a6",
				settingsFields: [],
			};
		},

		async listConnectionCandidates(): Promise<readonly ConnectionCandidate[]> {
			return builtinCandidatesFor("qq-official");
		},

		async listAddressCandidates(
			connection: Connection,
			scope: PushTargetScope,
			signal: AbortSignal,
		): Promise<Result<{ candidates: readonly AddressCandidate[] }>> {
			if (!isMine(connection)) {
				return fail("invalid", `wrong platform: adapter=${connection.adapterKey}`);
			}
			if (scope !== "channel") {
				// 群 / 私聊:内存发现表里现成的,不出网。表里已是「最近的在前」。
				return ok({
					candidates: registry
						.list(connection.id)
						.filter((e) => e.scope === scope)
						.map(
							(e): AddressCandidate => ({
								address: e.openid,
								...(e.displayHint ? { name: e.displayHint } : {}),
							}),
						),
				});
			}
			// 只有频道要出网:发现表是内存里的,用不着请求客户端,没 start 也读得到。
			if (!http) return fail("unavailable", t("connection.adapterNotStarted"));
			try {
				const guilds = await fetchQQGuildChannels(http, connection.settings, signal);
				return ok({
					candidates: guilds.flatMap((g) =>
						g.channels.map(
							(ch): AddressCandidate => ({
								address: ch.channelId,
								name: ch.name,
								parentAddress: g.guildId,
								parentName: g.name,
							}),
						),
					),
				});
			} catch (e) {
				logger.warn(`[qq] connection=${connection.id} 列频道失败: ${upstreamMessage(e)}`);
				return fail(
					"unavailable",
					t("qqOfficial.channels.listFailed", { reason: upstreamMessage(e) }),
				);
			}
		},

		capabilities(_connection: Connection): ConnectionCapabilities {
			return {
				atAll: {
					state: "unsupported",
					reason: t("qqOfficial.capability.atAllUnsupported"),
					checkedAt: adapterStartedAt,
				},
				inbound: { state: "supported", checkedAt: adapterStartedAt },
				// 没实现原生分享(小程序卡)的发送 = 不支持。
				nativeShare: {
					state: "unsupported",
					reason: t("qqOfficial.capability.nativeShareUnsupported"),
					checkedAt: adapterStartedAt,
				},
			};
		},

		isAvailable(connection: Connection, _destination: DestinationRef): boolean {
			// 连接 / 目标的启停与平台对不对,派发器查过了;这里只留收窄类型。
			if (!isMine(connection)) return false;
			return isConnectable(connection.settings);
		},

		start(ctx: PlatformAdapterContext): void {
			http = ctx.http;
			reporter = ctx;
			// 语言变了:此刻还连不上的连接,问题句照原因再说一遍(已恢复、已清掉的不在表里)。
			localeSub = opts.locale.onChange(() => {
				for (const [connectionId, reason] of [...gatewayDown]) {
					if (reporter) reportGatewayOffline(reporter, connectionId, reason);
				}
			});
			// 登记即启动:先按当前名单对一次账(今天的开机对账),再订连接配置的变动。
			reconcile(ctx.connections(), ctx);
			ctx.onConnectionsChanged(() => reconcile(ctx.connections(), ctx));
		},

		stop(): void {
			http = undefined;
			reporter = undefined;
			localeSub?.dispose();
			localeSub = undefined;
			disposeAll();
		},

		async probe(connection: Connection): Promise<ProbeResult> {
			if (!http) return fail("unavailable", t("connection.adapterNotStarted"));
			const t0 = Date.now();
			if (!isMine(connection)) {
				return fail("invalid", `wrong platform: ${connection.adapterKey}`);
			}
			// 实际推送走 REST(token + /v2/.../messages),与 WS 网关(仅用于捞 openid)彼此独立
			// —— 探连通性应该测「REST 能不能通」,不是「WS 握手有没有跑完」。此前用
			// `l.conn.isOnline()` 判定:①首次启动 reconcile 刚起、握手尚未完成时必然 false,
			// 造成"报错但其实能通"的假阴性;②读缓存布尔值不含任何网络往返,延迟恒为 0ms。
			// 命中只读的 /gateway 端点(不发消息,符合"系统不要主动测试"发消息的既有约束),
			// 换真实的可达性 + 延迟。
			const cfg = connection.settings;
			const base = qqApiBase(cfg.sandbox);
			let token: string;
			try {
				token = await tokenManagerFor(connection, http).getToken();
			} catch (e) {
				return tokenFailure(e);
			}
			const res = await qqFetch(http, `${base}/gateway`, {
				headers: qqRestHeaders(token, cfg.appId),
			});
			// 没走通(连不上、超时)一律 unavailable,与原生 fetch 抛错时一样。
			if (!res.ok) return fail("unavailable", res.message);
			return res.isSuccess
				? ok({ latencyMs: Date.now() - t0 })
				: httpFailure(res.status, `HTTP ${res.status}`);
		},

		async send(
			connection: Connection,
			destination: DestinationRef,
			payload: NotificationPayload,
		): Promise<DeliveryResult> {
			if (!http) return fail("unavailable", t("connection.adapterNotStarted"));
			if (!isMine(connection)) {
				return fail("invalid", `wrong platform: adapter=${connection.adapterKey}`);
			}
			// 端点目标没有会话可言(也没有 scope):与它原来恒为 channel、地址为空时的话一样。
			if (destination.kind !== "session") return fail("invalid", "channel: channelId missing");
			const { scope, address } = destination;
			// 先校验地址:缺 openid/channelId 立即失败,不取 token、不发注定失败的 REST。
			const endpoint = qqMessageEndpoint(scope, address);
			if (!endpoint.ok) return endpoint;

			const t0 = Date.now();
			const cfg = connection.settings;
			const base = qqApiBase(cfg.sandbox);
			let token: string;
			try {
				token = await tokenManagerFor(connection, http).getToken();
			} catch (e) {
				return tokenFailure(e);
			}
			const headers = qqRestHeaders(token, cfg.appId);

			// markdown 图集门控:仅私域机器人 + 群/C2C 的图集 → 合并成一条原生 markdown
			// 多图(绕过 QQ「无合并转发」)。公域不支持原生 markdown(需报备模板),回落 N 条
			// media;频道有独立消息 API,也不走这里。卡片 Buffer(image kind)永远走 media。
			const gallery = payload.kind === "image-group" ? imageGroupUrls(payload.images) : [];
			if (
				cfg.botType === "private" &&
				(scope === "group" || scope === "private") &&
				gallery.length > 0
			) {
				try {
					const { status, body } = await qqPostJson(
						http,
						base,
						headers,
						endpoint.path,
						buildQQV2MarkdownMessage(buildQQMarkdownGallery(gallery)),
					);
					const verdict = interpretQQSend(status, body);
					if (!verdict.ok) {
						logger.warn(
							`[qq] target=${describeDestination(destination)} markdown 图集发送失败: ${verdict.message}`,
						);
						return verdict;
					}
					return ok({ latencyMs: Date.now() - t0 });
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e);
					logger.warn(
						`[qq] target=${describeDestination(destination)} markdown 图集发送异常: ${message}`,
					);
					return fail("unavailable", message);
				}
			}

			const parts = qqPayloadToParts(payload);
			if (parts.length === 0) return fail("invalid", "empty payload");

			// QQ 一条 media 只能带一张图,多片段逐条发;任一条失败即整体失败(已发的无法回滚)。
			let failure: Failure | null = null;
			for (const part of parts) {
				try {
					const r = await sendPart(http, base, headers, scope, address, endpoint.path, part);
					// 上传那一步就没成:失败原样带出。
					if ("ok" in r) {
						failure = r;
						break;
					}
					const verdict = interpretQQSend(r.status, r.body);
					if (!verdict.ok) {
						failure = verdict;
						break;
					}
				} catch (e) {
					failure = fail("unavailable", e instanceof Error ? e.message : String(e));
					break;
				}
			}
			if (failure) {
				logger.warn(
					`[qq] target=${describeDestination(destination)} send failed: ${failure.message}`,
				);
				return failure;
			}
			return ok({ latencyMs: Date.now() - t0 });
		},
	};
}
