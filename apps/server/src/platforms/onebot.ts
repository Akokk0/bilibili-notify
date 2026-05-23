import type { IncomingMessage } from "node:http";
import type {
	DeliveryResult,
	Disposable,
	Logger,
	NotificationPayload,
	OnebotAdapterConfig,
	OnebotSession,
	PayloadSegment,
	PushAdapter,
	PushTarget,
	ServiceContext,
} from "@bilibili-notify/internal";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import type { PlatformAdapter, ProbeResult } from "./types.js";

/**
 * OneBot v11 adapter — HTTP / 正向 WS(ws)/ 反向 WS(ws-reverse)三种连接方式。
 *
 * 由 adapter config 的 `transport` 字段区分(见 `OnebotAdapterConfigSchema`):
 * - `http`:独立端 fetch POST 到 bot 的 HTTP API(无状态,沿用原实现)。
 * - `ws`:独立端作 WS 客户端主动连 bot,长连接 + 自动重连。
 * - `ws-reverse`:独立端按 adapter 各自的 `port` 监听,bot 主动连入(端口即身份)。
 *
 * WS 两种方式都用 OneBot v11 的 action 帧 `{action,params,echo}` 发消息,按 `echo`
 * 收响应。本插件 push-only:入站的 message/notice/heartbeat 事件帧一律忽略。
 *
 * 有状态:`ws`/`ws-reverse` 连接由 `reconcile()` 按当前 adapter 集合 start/stop/rebind,
 * `dispose()` 在 shutdown 时全部关闭。
 *
 * Token 鉴权:`accessToken` 在 http/ws 经 `Authorization: Bearer` 头带出;ws-reverse
 * 用它校验入站 bot 的握手头。
 */
export interface OnebotPlatformAdapterOptions {
	logger: Logger;
	serviceCtx: ServiceContext;
	/** Fallback timeout (ms) when adapter.config.timeoutMs is missing. Defaults to 15s. */
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_INTERVAL_MS = 1_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

type OnebotHttpConfig = Extract<OnebotAdapterConfig, { transport: "http" }>;
type OnebotWsConfig = Extract<OnebotAdapterConfig, { transport: "ws" }>;
type OnebotWsReverseConfig = Extract<OnebotAdapterConfig, { transport: "ws-reverse" }>;

interface OneBotMessageSegment {
	type: "text" | "image" | "at";
	data: Record<string, string>;
}

/** OneBot v11 action 响应帧 / HTTP 响应体(同形)。 */
interface OneBotResponse {
	status?: "ok" | "failed" | "async";
	retcode?: number;
	message?: string;
	wording?: string;
	msg?: string;
	data?: unknown;
	echo?: unknown;
}

// ---------------------------------------------------------------------------
// Payload → OneBot segment 翻译(三种 transport 共用)
// ---------------------------------------------------------------------------

function bufferToBase64Uri(buffer: Buffer): string {
	// OneBot v11 的 image segment 接受 `base64://` 形式;NapCat / go-cqhttp /
	// Lagrange 都支持,mime 由运行时推断。
	return `base64://${buffer.toString("base64")}`;
}

function segmentToOnebot(seg: PayloadSegment): OneBotMessageSegment {
	switch (seg.type) {
		case "text":
			return { type: "text", data: { text: seg.text } };
		case "image":
			return { type: "image", data: { file: bufferToBase64Uri(seg.buffer) } };
		case "link":
			return { type: "text", data: { text: seg.title ? `${seg.title} ${seg.href}` : seg.href } };
		case "at-all":
			return { type: "at", data: { qq: "all" } };
	}
}

function buildSegments(payload: NotificationPayload): OneBotMessageSegment[] {
	switch (payload.kind) {
		case "text":
			return [{ type: "text", data: { text: payload.text } }];
		case "image": {
			const out: OneBotMessageSegment[] = [
				{ type: "image", data: { file: bufferToBase64Uri(payload.image.buffer) } },
			];
			if (payload.caption) out.push({ type: "text", data: { text: payload.caption } });
			return out;
		}
		case "composite":
			return payload.segments.map(segmentToOnebot);
		case "forward-images":
			// 命名遗留:c3ee457 引入时走 send_group_forward_msg 长消息,但 NapCat 的
			// SsoSendLongMsg 通道常超时并阻塞后续 sendMsg 队列 → liveEnd/wordcloud 等
			// 普通推送也被连累卡 60s。改为多张 image segment 合并到一条普通 send_group_msg,
			// 对齐 koishi onebot adapter 的默认行为(多图自然合并,不走 forward 容器)。
			return payload.urls.map((url) => ({ type: "image", data: { file: url } }));
	}
}

/**
 * 把一次推送翻成 OneBot action(`send_group_msg` / `send_private_msg`)+ params。
 * HTTP 把 action 当 endpoint(加前导 `/`),WS 直接作 action 帧字段。
 */
function buildSendAction(
	target: PushTarget,
	payload: NotificationPayload,
	opts: { private?: boolean },
): { action: string; params: Record<string, unknown> } | { err: string } {
	const segments = buildSegments(payload);
	if (segments.length === 0) return { err: "empty payload" };
	const session = target.session as OnebotSession;
	// `opts.private` 是「强制私聊」覆盖标志,仅 `=== true` 时覆盖 target.scope。
	// 旧写法 `opts.private ?? scope==="private"` 的坑:caller(MultiplexSink.send)
	// 恒传 `{ private: false }`,??（nullish coalescing）不替换 false,导致
	// scope==="private" 的 target 永远走 group 分支并返回 "group: groupId missing"。
	const isPrivate = opts.private === true || target.scope === "private";
	const params: Record<string, unknown> = { message: segments };
	if (isPrivate) {
		if (!session.userId) return { err: "private: userId missing" };
		const uid = Number(session.userId);
		// 非数字 userId → Number()=NaN → 序列化成 null,OneBot 端静默错投。提前拒。
		if (!Number.isFinite(uid)) return { err: `private: userId 非数字 (${session.userId})` };
		params.user_id = uid;
		return { action: "send_private_msg", params };
	}
	if (!session.groupId) return { err: "group: groupId missing" };
	const gid = Number(session.groupId);
	if (!Number.isFinite(gid)) return { err: `group: groupId 非数字 (${session.groupId})` };
	params.group_id = gid;
	return { action: "send_group_msg", params };
}

/** OneBot 响应判定:`status:"ok"` + `retcode:0` 为成功。 */
function interpretResponse(r: OneBotResponse): { ok: true } | { ok: false; err: string } {
	if (r.status === "ok" && (r.retcode ?? 0) === 0) return { ok: true };
	const err = r.wording ?? r.message ?? r.msg ?? `retcode=${r.retcode}`;
	return { ok: false, err };
}

// ---------------------------------------------------------------------------
// HTTP transport(沿用原实现)
// ---------------------------------------------------------------------------

function trimTrailingSlash(s: string): string {
	return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * 拆开 undici `TypeError: fetch failed` 外壳,暴露底层 ECONNREFUSED / ENOTFOUND 等。
 */
function describeFetchError(e: unknown): string {
	if (!(e instanceof Error)) return String(e);
	const cause = (e as Error & { cause?: unknown }).cause;
	if (cause instanceof Error) {
		const code = (cause as NodeJS.ErrnoException).code;
		return code ? `${e.message}: ${code} ${cause.message}` : `${e.message}: ${cause.message}`;
	}
	return e.message;
}

async function postOnebotOnce(
	cfg: OnebotHttpConfig,
	endpoint: string,
	body: Record<string, unknown>,
	fallbackTimeoutMs: number,
): Promise<OneBotResponse> {
	const url = `${trimTrailingSlash(cfg.baseUrl)}${endpoint}`;
	const headers: Record<string, string> = { "content-type": "application/json", ...cfg.headers };
	if (cfg.accessToken) headers.authorization = `Bearer ${cfg.accessToken}`;

	const ctrl = new AbortController();
	const timeoutMs = cfg.timeoutMs ?? fallbackTimeoutMs;
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: ctrl.signal,
		});
		if (!res.ok) {
			return {
				status: "failed",
				retcode: res.status,
				message: `HTTP ${res.status} ${res.statusText}`,
			};
		}
		return (await res.json()) as OneBotResponse;
	} finally {
		clearTimeout(timer);
	}
}

async function postOnebot(
	cfg: OnebotHttpConfig,
	endpoint: string,
	body: Record<string, unknown>,
	fallbackTimeoutMs: number,
): Promise<OneBotResponse> {
	const retryTimes = cfg.retryTimes ?? 0;
	const retryIntervalMs = cfg.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
	let lastErr: unknown;
	let lastResponse: OneBotResponse | undefined;
	for (let attempt = 0; attempt <= retryTimes; attempt++) {
		try {
			const result = await postOnebotOnce(cfg, endpoint, body, fallbackTimeoutMs);
			if (result.status === "ok" && result.retcode === 0) return result;
			lastResponse = result;
		} catch (e) {
			lastErr = e;
		}
		if (attempt < retryTimes && retryIntervalMs > 0) {
			await new Promise((r) => setTimeout(r, retryIntervalMs));
		}
	}
	if (lastResponse) return lastResponse;
	throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ---------------------------------------------------------------------------
// WS:echo 关联 / 正向连接 / 反向监听器
// ---------------------------------------------------------------------------

function rawToString(raw: RawData): string {
	if (typeof raw === "string") return raw;
	if (Buffer.isBuffer(raw)) return raw.toString("utf8");
	if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
	return Buffer.from(raw as ArrayBuffer).toString("utf8");
}

/**
 * echo 关联 —— 把一条 OneBot WS action 帧与其响应配对。绑定单个 socket。
 * 正向连接每次重连换一个新 WsChannel;反向监听器每个连入的 bot 一个。
 */
class WsChannel {
	private readonly pending = new Map<
		string,
		{ resolve: (r: OneBotResponse) => void; reject: (e: Error) => void; timer: Disposable }
	>();
	private seq = 0;

	constructor(
		private readonly ws: WebSocket,
		private readonly idPrefix: string,
		private readonly serviceCtx: ServiceContext,
	) {
		ws.on("message", (raw: RawData) => this.onMessage(raw));
	}

	/** 发 action 帧,按 echo 等响应;`timeoutMs` 内无响应则 reject。 */
	call(
		action: string,
		params: Record<string, unknown>,
		timeoutMs: number,
	): Promise<OneBotResponse> {
		const echo = `${this.idPrefix}:${this.seq++}`;
		return new Promise<OneBotResponse>((resolve, reject) => {
			const timer = this.serviceCtx.setTimeout(() => {
				this.pending.delete(echo);
				reject(new Error(`ws action ${action} 响应超时 (${timeoutMs}ms)`));
			}, timeoutMs);
			this.pending.set(echo, { resolve, reject, timer });
			try {
				this.ws.send(JSON.stringify({ action, params, echo }));
			} catch (e) {
				this.pending.delete(echo);
				timer.dispose();
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		});
	}

	private onMessage(raw: RawData): void {
		let frame: OneBotResponse;
		try {
			frame = JSON.parse(rawToString(raw)) as OneBotResponse;
		} catch {
			return; // 非 JSON,丢弃
		}
		const echo = typeof frame.echo === "string" ? frame.echo : undefined;
		// 无 echo = 入站事件 / heartbeat;echo 不在表里 = 未知响应。push-only,一律忽略。
		if (!echo) return;
		const p = this.pending.get(echo);
		if (!p) return;
		this.pending.delete(echo);
		p.timer.dispose();
		p.resolve(frame);
	}

	/** 连接断开 / dispose:未决请求全部 reject,避免一直挂到超时。 */
	rejectAll(err: Error): void {
		for (const p of this.pending.values()) {
			p.timer.dispose();
			p.reject(err);
		}
		this.pending.clear();
	}
}

/** 正向 WS:独立端作客户端主动连 bot,断线指数退避重连。 */
class ForwardConn {
	private ws: WebSocket | null = null;
	private channel: WsChannel | null = null;
	private reconnectTimer: Disposable | null = null;
	private attempt = 0;
	private closed = false;
	lastError: string | null = null;

	constructor(
		readonly adapterId: string,
		readonly fingerprint: string,
		private readonly url: string,
		private readonly headers: Record<string, string>,
		private readonly serviceCtx: ServiceContext,
		private readonly log: Logger,
	) {
		this.connect();
	}

	private connect(): void {
		if (this.closed) return;
		this.reconnectTimer = null;
		let ws: WebSocket;
		try {
			ws = new WebSocket(this.url, { headers: this.headers });
		} catch (e) {
			this.lastError = e instanceof Error ? e.message : String(e);
			this.scheduleReconnect();
			return;
		}
		this.ws = ws;
		ws.on("open", () => {
			this.attempt = 0;
			this.lastError = null;
			this.channel = new WsChannel(ws, `fwd:${this.adapterId}`, this.serviceCtx);
			this.log.info(`[onebot] 正向 WS 已连接 adapter=${this.adapterId} url=${this.url}`);
		});
		ws.on("error", (err: Error) => {
			this.lastError = err.message;
		});
		ws.on("close", () => {
			this.channel?.rejectAll(new Error("ws 连接已断开"));
			this.channel = null;
			this.ws = null;
			if (!this.closed) this.scheduleReconnect();
		});
	}

	private scheduleReconnect(): void {
		if (this.closed || this.reconnectTimer) return;
		const base = Math.min(RECONNECT_BASE_MS * 2 ** this.attempt, RECONNECT_MAX_MS);
		const jitter = Math.round(base * (0.8 + Math.random() * 0.4)); // ±20% 抖动
		this.attempt++;
		this.reconnectTimer = this.serviceCtx.setTimeout(() => this.connect(), jitter);
	}

	/** 当前可用的 echo channel(连接 open 且 channel 就绪时)。 */
	getChannel(): WsChannel | null {
		return this.ws !== null && this.ws.readyState === WebSocket.OPEN ? this.channel : null;
	}

	close(): void {
		this.closed = true;
		this.reconnectTimer?.dispose();
		this.reconnectTimer = null;
		this.channel?.rejectAll(new Error("adapter 已关闭"));
		this.channel = null;
		try {
			this.ws?.close();
		} catch {
			/* ignore */
		}
		this.ws = null;
	}
}

/** 反向 WS:独立端按 `port` 监听,bot 主动连入。端口即身份。 */
class ReverseListener {
	private wss: WebSocketServer | null = null;
	bindError: string | null = null;
	/** 当前连入的 bot(通常 0 或 1)。 */
	private readonly bots = new Set<{ ws: WebSocket; channel: WsChannel }>();

	constructor(
		readonly adapterId: string,
		readonly port: number,
		private readonly accessToken: string | undefined,
		private readonly serviceCtx: ServiceContext,
		private readonly log: Logger,
	) {
		this.start();
	}

	private start(): void {
		let wss: WebSocketServer;
		try {
			wss = new WebSocketServer({ port: this.port });
		} catch (e) {
			this.bindError = e instanceof Error ? e.message : String(e);
			return;
		}
		this.wss = wss;
		wss.on("listening", () => {
			this.bindError = null;
			this.log.info(`[onebot] 反向 WS 监听就绪 adapter=${this.adapterId} port=${this.port}`);
		});
		wss.on("error", (err: Error) => {
			const code = (err as NodeJS.ErrnoException).code;
			this.bindError = code ? `${code}: ${err.message}` : err.message;
			this.log.warn(`[onebot] 反向 WS 端口 ${this.port} 监听失败: ${this.bindError}`);
		});
		wss.on("connection", (ws: WebSocket, req: IncomingMessage) => this.onConnection(ws, req));
	}

	private onConnection(ws: WebSocket, req: IncomingMessage): void {
		if (!this.checkAuth(req)) {
			this.log.warn(
				`[onebot] 反向 WS 鉴权失败 adapter=${this.adapterId} port=${this.port},拒绝连接`,
			);
			ws.close(1008, "unauthorized");
			return;
		}
		const channel = new WsChannel(ws, `rev:${this.adapterId}`, this.serviceCtx);
		const entry = { ws, channel };
		this.bots.add(entry);
		this.log.info(`[onebot] 反向 WS bot 已连入 adapter=${this.adapterId}(在线 ${this.bots.size})`);
		if (this.bots.size > 1) {
			// 一个反向 WS 端口正常只对应一个 bot;多个时推送只发往最近连入的那个,
			// 其余静默闲置 —— 大概率是把多个 bot 误指到同一端口,告警提示。
			this.log.warn(
				`[onebot] 反向 WS adapter=${this.adapterId} 端口 ${this.port} 有 ${this.bots.size} 个 bot 连入,` +
					"推送只发往最近连入的那个;通常一个端口应只对应一个 bot",
			);
		}
		ws.on("close", () => {
			channel.rejectAll(new Error("bot 连接已断开"));
			this.bots.delete(entry);
		});
		ws.on("error", () => {
			/* close 事件会随后到达,统一在 close 清理 */
		});
	}

	/** 校验入站 bot 的握手鉴权(`Authorization: Bearer` 头或 `?access_token=` query)。 */
	private checkAuth(req: IncomingMessage): boolean {
		if (!this.accessToken) return true; // 未配 token → 不校验(probe 会提示裸开风险)
		if (req.headers.authorization === `Bearer ${this.accessToken}`) return true;
		const url = req.url ?? "";
		const qIdx = url.indexOf("?");
		if (qIdx >= 0) {
			const params = new URLSearchParams(url.slice(qIdx + 1));
			if (params.get("access_token") === this.accessToken) return true;
		}
		return false;
	}

	get botCount(): number {
		return this.bots.size;
	}

	/** 取一个活跃 bot 的 channel(最近连入的)。 */
	getChannel(): WsChannel | null {
		let last: WsChannel | null = null;
		for (const e of this.bots) last = e.channel;
		return last;
	}

	close(): void {
		for (const e of this.bots) {
			e.channel.rejectAll(new Error("adapter 已关闭"));
			try {
				e.ws.close();
			} catch {
				/* ignore */
			}
		}
		this.bots.clear();
		try {
			this.wss?.close();
		} catch {
			/* ignore */
		}
		this.wss = null;
	}
}

/** 正向 WS 握手头:合并自定义 headers + `Authorization: Bearer <token>`。 */
function forwardHeaders(cfg: OnebotWsConfig): Record<string, string> {
	const headers: Record<string, string> = { ...cfg.headers };
	if (cfg.accessToken) headers.Authorization = `Bearer ${cfg.accessToken}`;
	return headers;
}

/** 正向连接配置指纹 —— 仅取影响连接的字段,变了才重连。 */
function forwardFingerprint(cfg: OnebotWsConfig): string {
	return JSON.stringify({ url: cfg.url, accessToken: cfg.accessToken ?? "", headers: cfg.headers });
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export function createOnebotAdapter(opts: OnebotPlatformAdapterOptions): PlatformAdapter {
	const log = opts.logger;
	const serviceCtx = opts.serviceCtx;
	const fallbackTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	const forwardConns = new Map<string, ForwardConn>();
	const reverseListeners = new Map<string, ReverseListener>();
	let disposed = false;

	function disposeAll(): void {
		if (disposed) return;
		disposed = true;
		for (const c of forwardConns.values()) c.close();
		forwardConns.clear();
		for (const l of reverseListeners.values()) l.close();
		reverseListeners.clear();
	}
	// 兜底:即便 engines.dispose 没显式调到,serviceCtx 结束时也关干净。
	serviceCtx.onDispose(disposeAll);

	/** WS / WS-reverse 共用的发送(echo 帧 + 重试)。 */
	async function sendOverWs(
		adapterId: string,
		cfg: OnebotWsConfig | OnebotWsReverseConfig,
		action: string,
		params: Record<string, unknown>,
		targetId: string,
		t0: number,
	): Promise<DeliveryResult> {
		const timeoutMs = cfg.timeoutMs ?? fallbackTimeoutMs;
		const retryTimes = cfg.retryTimes ?? 0;
		const retryIntervalMs = cfg.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
		let lastErr = "ws send failed";
		for (let attempt = 0; attempt <= retryTimes; attempt++) {
			const channel =
				cfg.transport === "ws"
					? (forwardConns.get(adapterId)?.getChannel() ?? null)
					: (reverseListeners.get(adapterId)?.getChannel() ?? null);
			if (!channel) {
				lastErr = cfg.transport === "ws" ? "正向 WS 未连接" : "无 bot 连入(反向 WS)";
			} else {
				try {
					const verdict = interpretResponse(await channel.call(action, params, timeoutMs));
					if (verdict.ok) return { ok: true, latencyMs: Date.now() - t0 };
					lastErr = verdict.err;
				} catch (e) {
					lastErr = e instanceof Error ? e.message : String(e);
				}
			}
			if (attempt < retryTimes && retryIntervalMs > 0) {
				await new Promise((r) => setTimeout(r, retryIntervalMs));
			}
		}
		log.warn(`[onebot] target=${targetId} ws send failed: ${lastErr}`);
		return { ok: false, latencyMs: Date.now() - t0, err: lastErr };
	}

	return {
		platforms: ["onebot"],

		isAvailable(adapter: PushAdapter, target: PushTarget): boolean {
			if (adapter.platform !== "onebot" || target.platform !== "onebot") return false;
			if (!adapter.enabled || !target.enabled) return false;
			const cfg = adapter.config as OnebotAdapterConfig;
			if (cfg.transport === "http") return cfg.baseUrl.length > 0;
			if (cfg.transport === "ws") return cfg.url.length > 0;
			return true; // ws-reverse:运行期可达性由 send/probe 判断
		},

		reconcile(adapters: readonly PushAdapter[]): void {
			if (disposed) return;
			const onebots = adapters.filter((a) => a.platform === "onebot" && a.enabled);

			// --- 正向 ws ---
			const desiredFwd = new Map<string, OnebotWsConfig>();
			for (const a of onebots) {
				const cfg = a.config as OnebotAdapterConfig;
				if (cfg.transport === "ws") desiredFwd.set(a.id, cfg);
			}
			for (const [id, conn] of forwardConns) {
				if (!desiredFwd.has(id)) {
					conn.close();
					forwardConns.delete(id);
				}
			}
			for (const [id, cfg] of desiredFwd) {
				const fp = forwardFingerprint(cfg);
				const existing = forwardConns.get(id);
				if (existing && existing.fingerprint === fp) continue; // 没变,幂等 no-op
				existing?.close();
				forwardConns.set(
					id,
					new ForwardConn(id, fp, cfg.url, forwardHeaders(cfg), serviceCtx, log),
				);
			}

			// --- 反向 ws ---
			const desiredRev = new Map<string, OnebotWsReverseConfig>();
			for (const a of onebots) {
				const cfg = a.config as OnebotAdapterConfig;
				if (cfg.transport === "ws-reverse") desiredRev.set(a.id, cfg);
			}
			for (const [id, lis] of reverseListeners) {
				const want = desiredRev.get(id);
				if (!want || want.port !== lis.port) {
					lis.close();
					reverseListeners.delete(id);
				}
			}
			for (const [id, cfg] of desiredRev) {
				if (reverseListeners.has(id)) continue; // 端口没变,幂等 no-op
				// 端口冲突(含与另一 ws-reverse adapter 撞 port)由监听器的 EADDRINUSE
				// error 事件落到 bindError,经 probe 暴露给 dashboard。
				reverseListeners.set(
					id,
					new ReverseListener(id, cfg.port, cfg.accessToken, serviceCtx, log),
				);
			}
		},

		dispose(): void {
			disposeAll();
		},

		async probe(adapter: PushAdapter): Promise<ProbeResult> {
			if (adapter.platform !== "onebot") {
				return { ok: false, latencyMs: 0, err: `wrong platform: ${adapter.platform}` };
			}
			const cfg = adapter.config as OnebotAdapterConfig;
			const t0 = Date.now();

			if (cfg.transport === "http") {
				try {
					const result = await postOnebotOnce(cfg, "/get_status", {}, fallbackTimeoutMs);
					const verdict = interpretResponse(result);
					return verdict.ok
						? { ok: true, latencyMs: Date.now() - t0 }
						: { ok: false, latencyMs: Date.now() - t0, err: verdict.err };
				} catch (e) {
					return { ok: false, latencyMs: Date.now() - t0, err: describeFetchError(e) };
				}
			}

			if (cfg.transport === "ws") {
				const conn = forwardConns.get(adapter.id);
				const channel = conn?.getChannel() ?? null;
				if (!channel) {
					return {
						ok: false,
						latencyMs: Date.now() - t0,
						err: conn?.lastError ?? "正向 WS 未连接",
					};
				}
				try {
					const verdict = interpretResponse(
						await channel.call("get_status", {}, cfg.timeoutMs ?? fallbackTimeoutMs),
					);
					return verdict.ok
						? { ok: true, latencyMs: Date.now() - t0 }
						: { ok: false, latencyMs: Date.now() - t0, err: verdict.err };
				} catch (e) {
					return {
						ok: false,
						latencyMs: Date.now() - t0,
						err: e instanceof Error ? e.message : String(e),
					};
				}
			}

			// ws-reverse
			const lis = reverseListeners.get(adapter.id);
			if (!lis) {
				return { ok: false, latencyMs: Date.now() - t0, err: "反向 WS 监听未启动" };
			}
			if (lis.bindError) {
				return {
					ok: false,
					latencyMs: Date.now() - t0,
					err: `端口 ${lis.port} 绑定失败: ${lis.bindError}`,
				};
			}
			const channel = lis.getChannel();
			if (!channel) {
				return {
					ok: false,
					latencyMs: Date.now() - t0,
					err: `端口 ${lis.port} 已监听,等待 bot 连入`,
				};
			}
			try {
				const verdict = interpretResponse(
					await channel.call("get_status", {}, cfg.timeoutMs ?? fallbackTimeoutMs),
				);
				return verdict.ok
					? { ok: true, latencyMs: Date.now() - t0 }
					: { ok: false, latencyMs: Date.now() - t0, err: verdict.err };
			} catch (e) {
				return {
					ok: false,
					latencyMs: Date.now() - t0,
					err: e instanceof Error ? e.message : String(e),
				};
			}
		},

		async send(
			adapter: PushAdapter,
			target: PushTarget,
			payload: NotificationPayload,
			opts: { private?: boolean } = {},
		): Promise<DeliveryResult> {
			if (adapter.platform !== "onebot" || target.platform !== "onebot") {
				return {
					ok: false,
					latencyMs: 0,
					err: `wrong platform: adapter=${adapter.platform} target=${target.platform}`,
				};
			}
			const cfg = adapter.config as OnebotAdapterConfig;
			const built = buildSendAction(target, payload, opts);
			if ("err" in built) return { ok: false, latencyMs: 0, err: built.err };
			const t0 = Date.now();

			if (cfg.transport === "http") {
				try {
					const result = await postOnebot(cfg, `/${built.action}`, built.params, fallbackTimeoutMs);
					const verdict = interpretResponse(result);
					if (!verdict.ok) {
						log.warn(`[onebot] target=${target.id} send failed: ${verdict.err}`);
						return { ok: false, latencyMs: Date.now() - t0, err: verdict.err };
					}
					return { ok: true, latencyMs: Date.now() - t0 };
				} catch (e) {
					const err = describeFetchError(e);
					log.warn(`[onebot] target=${target.id} send threw: ${err} (baseUrl=${cfg.baseUrl})`);
					return { ok: false, latencyMs: Date.now() - t0, err };
				}
			}

			return sendOverWs(adapter.id, cfg, built.action, built.params, target.id, t0);
		},
	};
}
