import type {
	DeliveryResult,
	Disposable,
	Logger,
	NotificationPayload,
	PushAdapter,
	PushTarget,
	PushTargetScope,
	QQOfficialAdapterConfig,
	QQOfficialSession,
	ServiceContext,
} from "@bilibili-notify/internal";
import { type RawData, WebSocket } from "ws";
import type { PlatformAdapter, ProbeResult } from "./types.js";

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

/** 正式 / 沙箱 REST API base host。沙箱在 api 前插 `sandbox.`(对齐 koishi)。 */
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
	adapterId: string;
	/** 解析 wss 网关地址(REST GET /gateway → url,沙箱改写)。每次连接前调,便于换 host。 */
	resolveGatewayUrl(): Promise<string>;
	/** 取当前 App Access Token(token manager 已缓存/刷新),用于 IDENTIFY/RESUME。 */
	getToken(): Promise<string>;
	/** 捞到群/C2C 会话时回调 —— adapter 落进 {@link QQSessionRegistry}。 */
	onDiscovered(session: QQDiscoveredSession): void;
	serviceCtx: ServiceContext;
	logger: Logger;
	/** 订阅 intents,默认 {@link QQ_PUSH_INTENTS}。 */
	intents?: number;
	/** 指数退避基数(ms),默认 1000。测试注入小值加速。 */
	reconnectBaseMs?: number;
}

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
	const { adapterId, serviceCtx, logger } = opts;
	const intents = opts.intents ?? QQ_PUSH_INTENTS;
	const reconnectBase = opts.reconnectBaseMs ?? QQ_RECONNECT_BASE_MS;

	let ws: WebSocket | null = null;
	let heartbeatTimer: Disposable | null = null;
	let reconnectTimer: Disposable | null = null;
	let attempt = 0;
	let closed = false;
	let online = false;

	let sessionId = "";
	let lastSeq: number | null = null;
	let acked = true;
	const state = { lastError: null as string | null };

	function clearHeartbeat(): void {
		heartbeatTimer?.dispose();
		heartbeatTimer = null;
	}

	function heartbeat(): void {
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		if (!acked) {
			// 上一拍心跳没收到 ACK = 僵尸连接,关掉触发重连(对齐 @satorijs)。
			logger.warn(`[qq] adapter=${adapterId} 心跳无 ACK,判定僵尸连接,关闭重连`);
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
			state.lastError = `getToken 失败: ${String(e)}`;
			logger.warn(`[qq] adapter=${adapterId} ${state.lastError}`);
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

	function onDispatch(frame: QQFrame): void {
		if (typeof frame.s === "number") lastSeq = frame.s;
		const t = frame.t;
		const d = (frame.d ?? {}) as Record<string, unknown>;
		if (t === "READY") {
			if (typeof d.session_id === "string") sessionId = d.session_id;
			online = true;
			logger.info(`[qq] adapter=${adapterId} 网关已就绪(READY)`);
			return;
		}
		if (t === "RESUMED") {
			online = true;
			logger.info(`[qq] adapter=${adapterId} 网关已续连(RESUMED)`);
			return;
		}
		if (t === "MESSAGE_AUDIT_REJECT") {
			logger.warn(`[qq] adapter=${adapterId} 消息审核未通过(MESSAGE_AUDIT_REJECT)`);
			return;
		}
		if (typeof t === "string") {
			const discovered = extractQQDiscoveredSession(t, d);
			if (discovered) opts.onDiscovered(discovered);
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
				logger.warn(`[qq] adapter=${adapterId} 会话失效(INVALID_SESSION),将重新鉴权`);
				break;
			case QQ_OPCODE.RECONNECT:
				logger.warn(`[qq] adapter=${adapterId} 服务端要求重连(RECONNECT)`);
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
		const base = Math.min(reconnectBase * 2 ** attempt, QQ_RECONNECT_MAX_MS);
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
			state.lastError = `解析网关地址失败: ${String(e)}`;
			scheduleReconnect();
			return;
		}
		if (closed) return;
		let socket: WebSocket;
		try {
			socket = new WebSocket(url);
		} catch (e) {
			state.lastError = e instanceof Error ? e.message : String(e);
			scheduleReconnect();
			return;
		}
		ws = socket;
		socket.on("open", () => {
			attempt = 0;
			state.lastError = null;
		});
		socket.on("message", (raw: RawData) => onMessage(raw));
		socket.on("error", (err: Error) => {
			state.lastError = err.message;
		});
		socket.on("close", (code: number) => {
			online = false;
			clearHeartbeat();
			if (ws === socket) ws = null;
			// 4000+ 非限流/超时 → 清会话(强制重新 IDENTIFY);否则保留以便 RESUME。
			if (qqShouldResetSessionOnClose(code)) {
				sessionId = "";
				lastSeq = null;
			}
			if (!closed) scheduleReconnect();
		});
	}

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

export type QQSendVerdict =
	| { ok: true; id?: string; pendingAudit?: true; auditId?: string }
	| { ok: false; err: string };

/**
 * 解析发送响应为 A+ 投递语义(提交即成功)。主动推送几乎总是走审核:HTTP 202 +
 * `code 304023` + `audit_id` —— 算「已提交·审核中」(ok,后台听 MESSAGE_AUDIT 才知拒绝);
 * 200 + id = 已发;2xx 但带非零业务 code(无 id/audit)= 失败;非 2xx = 失败。
 */
export function interpretQQSend(status: number, body: unknown): QQSendVerdict {
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
		if (typeof auditId === "string") return { ok: true, pendingAudit: true, auditId };
		if (typeof b.id === "string" || typeof b.id === "number") return { ok: true, id: String(b.id) };
		// 2xx 但带非零业务 code 且无 id/audit = QQ 以 200 包装的业务错误。
		if (code !== undefined && code !== 0) return { ok: false, err: `code ${code}: ${message}` };
		return { ok: true };
	}
	return { ok: false, err: code !== undefined ? `code ${code}: ${message}` : message };
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
			return `![图片${dim}](${img.url})`;
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
			// QQ 无合并转发 —— forward 标志忽略,每张图展开成独立片段(尺寸透传给 markdown 用)。
			return payload.images.map((img) => ({
				kind: "image-url" as const,
				url: img.url,
				width: img.width,
				height: img.height,
			}));
		case "composite": {
			const parts: QQSendPart[] = [];
			for (const seg of payload.segments) {
				if (seg.type === "text") parts.push({ kind: "text", text: seg.text });
				else if (seg.type === "image") parts.push({ kind: "image-buffer", buffer: seg.buffer });
				else if (seg.type === "link")
					parts.push({ kind: "text", text: seg.title ? `${seg.title} ${seg.href}` : seg.href });
				// at-all:QQ 群 @全体需特殊权限,best-effort 跳过,不阻断推送。
			}
			return attachFollowingTextToImages(parts);
		}
		default:
			return [];
	}
}

// ---------------------------------------------------------------------------
// PlatformAdapter 工厂 —— send 编排(上传→media)+ probe/reconcile/dispose 生命周期
// ---------------------------------------------------------------------------

/** JSON POST,返回 `{status, body}`(body 解析失败回退 {})。 */
async function qqPostJson(
	base: string,
	headers: Record<string, string>,
	path: string,
	body: unknown,
): Promise<{ status: number; body: unknown }> {
	const res = await fetch(`${base}${path}`, {
		method: "POST",
		headers: { ...headers, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const parsed = await res.json().catch(() => ({}));
	return { status: res.status, body: parsed };
}

/** 频道图片走 multipart `file_image`(直传 Buffer,不需公网 URL,不设 content-type 让 fetch 补 boundary)。 */
async function qqPostChannelForm(
	base: string,
	headers: Record<string, string>,
	channelId: string,
	content: string,
	buffer: Buffer,
): Promise<{ status: number; body: unknown }> {
	const form = new FormData();
	form.append("content", content);
	form.append("file_image", new Blob([buffer]), "image.png");
	const res = await fetch(`${base}/channels/${channelId}/messages`, {
		method: "POST",
		headers,
		body: form,
	});
	const parsed = await res.json().catch(() => ({}));
	return { status: res.status, body: parsed };
}

/** 群/C2C 富媒体两步第一步:上传拿 file_info。失败返回 err。 */
async function qqUploadMedia(
	base: string,
	headers: Record<string, string>,
	scope: "group" | "private",
	openid: string,
	upload: QQFileUploadBody | { file_type: number; srv_send_msg: boolean; url: string },
): Promise<{ ok: true; media: QQFileMedia } | { ok: false; err: string }> {
	const { status, body } = await qqPostJson(base, headers, qqFilesPath(scope, openid), upload);
	const data = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
	const fileInfo = data.file_info;
	if (typeof fileInfo === "string") return { ok: true, media: { ...data, file_info: fileInfo } };
	const verdict = interpretQQSend(status, body);
	return { ok: false, err: verdict.ok ? "上传成功但无 file_info" : verdict.err };
}

export interface QQGuildChannel {
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
export async function fetchQQGuildChannels(cfg: QQOfficialAdapterConfig): Promise<QQGuild[]> {
	const { token } = await fetchAppAccessToken(cfg.appId, cfg.appSecret);
	const base = qqApiBase(cfg.sandbox);
	const headers = qqRestHeaders(token, cfg.appId);
	const guildsRes = await fetch(`${base}/users/@me/guilds`, { headers });
	if (!guildsRes.ok) throw new Error(`列频道服务器 HTTP ${guildsRes.status}`);
	const guilds = (await guildsRes.json().catch(() => [])) as Array<{ id?: string; name?: string }>;
	const out: QQGuild[] = [];
	for (const g of guilds) {
		if (!g.id) continue;
		const chRes = await fetch(`${base}/guilds/${g.id}/channels`, { headers });
		if (!chRes.ok) continue; // 读不了该 guild 子频道 → 跳过,不整体失败
		const channels = (await chRes.json().catch(() => [])) as Array<{
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
	/** 共享发现表 —— 网关捞到的 openid 落这,路由 qq-sessions 读它。 */
	registry: QQSessionRegistry;
}

interface QQLive {
	tm: QQTokenManager;
	conn: QQGatewayConn;
	fingerprint: string;
}

function qqAdapterFingerprint(cfg: QQOfficialAdapterConfig): string {
	return JSON.stringify({ appId: cfg.appId, appSecret: cfg.appSecret, sandbox: cfg.sandbox });
}

/**
 * QQ 官方机器人(q.qq.com)平台 adapter。有状态:每 adapter 一条 WS 网关长连(捞 openid
 * 进 registry)+ 一个 token 管理器,由 reconcile 按配置指纹 start/stop/rebind,dispose 全关。
 * send 把 NotificationPayload 译成有序片段逐条 REST 发(频道 multipart file_image;群/C2C
 * 富媒体两步上传→media),A+ 投递语义(202 审核中算 ok)。
 */
export function createQQOfficialAdapter(opts: QQOfficialAdapterOptions): PlatformAdapter {
	const { logger, serviceCtx, registry } = opts;
	const live = new Map<string, QQLive>();
	/** reconcile 未跑时 send 仍可独立取 token 的兜底管理器(无网关连接)。 */
	const tokenOnly = new Map<string, QQTokenManager>();
	let disposed = false;

	function makeTokenManager(cfg: QQOfficialAdapterConfig): QQTokenManager {
		return createQQTokenManager({
			appId: cfg.appId,
			clientSecret: cfg.appSecret,
			serviceCtx,
			logger,
		});
	}

	function makeLive(adapter: PushAdapter): QQLive {
		const cfg = adapter.config as QQOfficialAdapterConfig;
		const tm = makeTokenManager(cfg);
		const base = qqApiBase(cfg.sandbox);
		const conn = createQQGatewayConn({
			adapterId: adapter.id,
			resolveGatewayUrl: async () => {
				const token = await tm.getToken();
				const res = await fetch(`${base}/gateway`, { headers: qqRestHeaders(token, cfg.appId) });
				const body = (await res.json().catch(() => ({}))) as { url?: unknown };
				if (typeof body.url !== "string") throw new Error("getGateway 响应无 url");
				return qqGatewayUrlForHost(body.url, cfg.sandbox);
			},
			getToken: () => tm.getToken(),
			onDiscovered: (s) => registry.record(adapter.id, s, Date.now()),
			serviceCtx,
			logger,
		});
		return { tm, conn, fingerprint: qqAdapterFingerprint(cfg) };
	}

	/** send 取 token:优先复用网关连接的 manager,否则起一个仅 token 的兜底。 */
	function tokenManagerFor(adapter: PushAdapter): QQTokenManager {
		const l = live.get(adapter.id);
		if (l) return l.tm;
		let tm = tokenOnly.get(adapter.id);
		if (!tm) {
			tm = makeTokenManager(adapter.config as QQOfficialAdapterConfig);
			tokenOnly.set(adapter.id, tm);
		}
		return tm;
	}

	function disposeAll(): void {
		if (disposed) return;
		disposed = true;
		for (const l of live.values()) {
			l.conn.close();
			l.tm.dispose();
		}
		live.clear();
		for (const tm of tokenOnly.values()) tm.dispose();
		tokenOnly.clear();
	}
	serviceCtx.onDispose(disposeAll);

	/** 发一个片段。返回 REST `{status, body}` 或前置 `{err}`(上传失败)。 */
	async function sendPart(
		base: string,
		headers: Record<string, string>,
		scope: PushTargetScope,
		session: QQOfficialSession,
		messagesPath: string,
		part: QQSendPart,
	): Promise<{ status: number; body: unknown } | { err: string }> {
		if (scope === "channel") {
			const channelId = session.channelId ?? "";
			if (part.kind === "text") {
				return qqPostJson(base, headers, messagesPath, { content: part.text });
			}
			if (part.kind === "image-url") {
				return qqPostJson(base, headers, messagesPath, {
					content: part.caption ?? " ",
					image: part.url,
				});
			}
			return qqPostChannelForm(base, headers, channelId, part.caption ?? " ", part.buffer);
		}
		// group / private:文本直发;图片两步上传→media。
		const gScope = scope === "group" ? "group" : "private";
		const openid = scope === "group" ? (session.groupOpenid ?? "") : (session.userOpenid ?? "");
		if (part.kind === "text") {
			return qqPostJson(base, headers, messagesPath, buildQQV2Message({ content: part.text }));
		}
		const upload =
			part.kind === "image-buffer"
				? buildQQFileUpload(part.buffer)
				: { file_type: QQ_FILE_TYPE_IMAGE, srv_send_msg: false, url: part.url };
		const up = await qqUploadMedia(base, headers, gScope, openid, upload);
		if (!up.ok) return { err: up.err };
		const content =
			part.kind === "image-buffer" || part.kind === "image-url" ? part.caption : undefined;
		return qqPostJson(base, headers, messagesPath, buildQQV2Message({ content, media: up.media }));
	}

	return {
		platforms: ["qq-official"],

		isAvailable(adapter: PushAdapter, target: PushTarget): boolean {
			if (adapter.platform !== "qq-official" || target.platform !== "qq-official") return false;
			if (!adapter.enabled || !target.enabled) return false;
			const cfg = adapter.config as QQOfficialAdapterConfig;
			return cfg.appId.length > 0 && cfg.appSecret.length > 0;
		},

		reconcile(adapters: readonly PushAdapter[]): void {
			if (disposed) return;
			const desired = new Map<string, PushAdapter>();
			for (const a of adapters) {
				if (a.platform === "qq-official" && a.enabled) desired.set(a.id, a);
			}
			// 删除/失效:不再期望或配置指纹变了 → 关连接、清发现表。
			for (const [id, l] of live) {
				const want = desired.get(id);
				if (
					!want ||
					qqAdapterFingerprint(want.config as QQOfficialAdapterConfig) !== l.fingerprint
				) {
					l.conn.close();
					l.tm.dispose();
					live.delete(id);
					registry.clear(id);
				}
			}
			// 新建:期望但无 live(或刚被指纹变更删掉)。
			for (const [id, a] of desired) {
				if (live.has(id)) continue;
				live.set(id, makeLive(a));
			}
			// 全清兜底 token-only:它仅在 reconcile 跑之前给 send 取 token 用。reconcile 后,
			// desired 适配器都有 live(自带 tm),非 desired 的会被 isAvailable 挡掉不再 send ——
			// 故此刻所有 tokenOnly 都是 stale。逐 id 只清 desired 会漏掉「曾被 send、后被删除/
			// 禁用」的适配器,泄漏其刷新定时器,这里整张清掉根治。
			for (const tm of tokenOnly.values()) tm.dispose();
			tokenOnly.clear();
		},

		dispose(): void {
			disposeAll();
		},

		async probe(adapter: PushAdapter): Promise<ProbeResult> {
			const t0 = Date.now();
			if (adapter.platform !== "qq-official") {
				return { ok: false, latencyMs: 0, err: `wrong platform: ${adapter.platform}` };
			}
			const l = live.get(adapter.id);
			if (!l) return { ok: false, latencyMs: Date.now() - t0, err: "网关未连接(尚未 reconcile)" };
			return l.conn.isOnline()
				? { ok: true, latencyMs: Date.now() - t0 }
				: { ok: false, latencyMs: Date.now() - t0, err: l.conn.lastError ?? "网关连接中" };
		},

		async send(
			adapter: PushAdapter,
			target: PushTarget,
			payload: NotificationPayload,
			_opts: { private?: boolean } = {},
		): Promise<DeliveryResult> {
			if (adapter.platform !== "qq-official" || target.platform !== "qq-official") {
				return {
					ok: false,
					latencyMs: 0,
					err: `wrong platform: adapter=${adapter.platform} target=${target.platform}`,
				};
			}
			const scope = target.scope;
			const session = target.session as QQOfficialSession;
			// 先按 scope 校验会话字段:缺 openid/channelId 立即失败,不取 token、不发注定失败的 REST。
			const endpoint = qqMessageEndpoint(scope, session);
			if ("err" in endpoint) return { ok: false, latencyMs: 0, err: endpoint.err };

			const t0 = Date.now();
			const cfg = adapter.config as QQOfficialAdapterConfig;
			const base = qqApiBase(cfg.sandbox);
			let token: string;
			try {
				token = await tokenManagerFor(adapter).getToken();
			} catch (e) {
				return {
					ok: false,
					latencyMs: Date.now() - t0,
					err: `取 App Access Token 失败: ${String(e)}`,
				};
			}
			const headers = qqRestHeaders(token, cfg.appId);

			// markdown 图集门控:仅私域机器人 + 群/C2C 的图集 → 合并成一条原生 markdown
			// 多图(绕过 QQ「无合并转发」)。公域不支持原生 markdown(需报备模板),回落 N 条
			// media;频道有独立消息 API,也不走这里。卡片 Buffer(image kind)永远走 media。
			if (
				payload.kind === "forward-images" &&
				cfg.botType === "private" &&
				(scope === "group" || scope === "private") &&
				payload.images.length > 0
			) {
				try {
					const { status, body } = await qqPostJson(
						base,
						headers,
						endpoint.path,
						buildQQV2MarkdownMessage(buildQQMarkdownGallery(payload.images)),
					);
					const verdict = interpretQQSend(status, body);
					if (!verdict.ok) {
						logger.warn(`[qq] target=${target.id} markdown 图集发送失败: ${verdict.err}`);
						return { ok: false, latencyMs: Date.now() - t0, err: verdict.err };
					}
					return { ok: true, latencyMs: Date.now() - t0 };
				} catch (e) {
					const err = e instanceof Error ? e.message : String(e);
					logger.warn(`[qq] target=${target.id} markdown 图集发送异常: ${err}`);
					return { ok: false, latencyMs: Date.now() - t0, err };
				}
			}

			const parts = qqPayloadToParts(payload);
			if (parts.length === 0)
				return { ok: false, latencyMs: Date.now() - t0, err: "empty payload" };

			// QQ 一条 media 只能带一张图,多片段逐条发;任一条失败即整体失败(已发的无法回滚)。
			let lastErr = "";
			for (const part of parts) {
				try {
					const r = await sendPart(base, headers, scope, session, endpoint.path, part);
					if ("err" in r) {
						lastErr = r.err;
						break;
					}
					const verdict = interpretQQSend(r.status, r.body);
					if (!verdict.ok) {
						lastErr = verdict.err;
						break;
					}
				} catch (e) {
					lastErr = e instanceof Error ? e.message : String(e);
					break;
				}
			}
			if (lastErr) {
				logger.warn(`[qq] target=${target.id} send failed: ${lastErr}`);
				return { ok: false, latencyMs: Date.now() - t0, err: lastErr };
			}
			return { ok: true, latencyMs: Date.now() - t0 };
		},
	};
}
