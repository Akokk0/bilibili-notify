import { type IncomingMessage, STATUS_CODES } from "node:http";
import type {
	CapabilitySupport,
	Connection,
	ConnectionCandidate,
	ConnectionCapabilities,
	DeliveryResult,
	DestinationRef,
	Disposable,
	Failure,
	HttpClient,
	Logger,
	NotificationPayload,
	OnebotConnectionSettings,
	PayloadSegment,
	PlatformAdapter,
	PlatformAdapterContext,
	ProbeResult,
	Result,
	ServiceContext,
	WebSocketLike,
} from "@bilibili-notify/internal";
import { fail, OnebotConnectionSettingsSchema, ok } from "@bilibili-notify/internal";
import {
	ONEBOT_FORWARD_MIN_TIMEOUT_MS,
	ONEBOT_IMAGE_MIN_TIMEOUT_MS,
} from "@bilibili-notify/internal/constants";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import type { IntegrationSettingsSegment } from "../config/store.js";
import { t } from "../i18n/index.js";
import { builtinCandidatesFor } from "./builtin-candidates.js";
import { describeDestination } from "./destination-label.js";
import { imageGroupUrls } from "./image-group.js";
import { routeInboundFrame } from "./onebot-inbound.js";
import { upstreamMessage } from "./upstream-message.js";

/**
 * OneBot v11 adapter — HTTP / 正向 WS(ws)/ 反向 WS(ws-reverse)三种连接方式。
 *
 * 由连接 settings 的 `transport` 字段区分(见 `OnebotConnectionSettingsSchema`):
 * - `http`:独立端 fetch POST 到 bot 的 HTTP API(无状态,沿用原实现)。
 * - `ws`:独立端作 WS 客户端主动连 bot,长连接 + 自动重连。
 * - `ws-reverse`:独立端按 adapter 各自的 `port` 监听,bot 主动连入(端口即身份)。
 *
 * WS 两种方式都用 OneBot v11 的 action 帧 `{action,params,echo}` 发消息,按 `echo`
 * 收响应。本插件 push-only:入站的 message/notice/heartbeat 事件帧一律忽略。
 *
 * 有状态:`ws`/`ws-reverse` 连接在 `start(ctx)` 时按当前连接名单建立,连接配置变了再 start/stop/rebind,
 * `stop()` 在注销 / 关停时全部关闭。
 *
 * Token 鉴权:`accessToken` 在 http/ws 经 `Authorization: Bearer` 头带出;ws-reverse
 * 用它校验入站 bot 的握手头。
 */
export interface OnebotPlatformAdapterOptions {
	logger: Logger;
	serviceCtx: ServiceContext;
	/** Fallback timeout (ms) when settings.timeoutMs is missing. Defaults to 15s. */
	timeoutMs?: number;
	/**
	 * 合并转发动作(send_*_forward_msg)的超时下限(ms)**兜底值**,默认 60s。NapCat
	 * 组装多图 forward 要逐张下载再上传,常规 15s 几乎必超 —— 单独放宽,让慢成功等得
	 * 到真响应,推送历史不再谎报失败。取 `max(cfg.timeoutMs, 下限)`。
	 *
	 * 真正生效的下限来自 adapter config 的同名字段(界面上「合并转发超时下限」那栏);
	 * 本项只在配置里没这个字段时才用得上 —— 测试注入,以及未过 schema 的裸配置。
	 */
	mergeForwardMinTimeoutMs?: number;
	/**
	 * **带图**普通消息(send_group_msg / send_private_msg 里含 image 段)的超时下限
	 * (ms)**兜底值**,默认 30s。与 forward 同一个道理,只是当初只想到了合并转发:带图
	 * 消息在 OneBot 实现那侧要先落盘、传腾讯图床、拿 fileid 才回响应,15s 常不够(用户
	 * 实测 LLOneBot,词云 / 动态卡每条都恰好卡在 15000ms 死线,而同时段纯文字全部秒回)。
	 *
	 * 比 forward 的 60s 短:单图只有一次上传往返,而 forward 要逐张来一遍。同上,配置
	 * 里的同名字段优先,本项只是兜底。
	 */
	imageMinTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_INTERVAL_MS = 1_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
// 两个下限与前端共用一个数(见 `@bilibili-notify/internal/constants` 的说明),否则
// 界面上写着 30s、这边实际按别的数放宽,主人对不上账。
const DEFAULT_FORWARD_MIN_TIMEOUT_MS = ONEBOT_FORWARD_MIN_TIMEOUT_MS;
const DEFAULT_IMAGE_MIN_TIMEOUT_MS = ONEBOT_IMAGE_MIN_TIMEOUT_MS;

/**
 * 「结果未知」类发送失败:action 帧 / HTTP 请求**已经发出去之后**才失败(响应超时、
 * 连接中断)。这不等于消息没发出去 —— NapCat 收到 action 后即使我们这边判超时,它
 * 仍会继续处理并把消息发进群(9 图合并转发常要 20~60s,远超常规 15s 超时)。
 *
 * send_* 动作非幂等:对这类失败盲重试,每次重试都是又一条完整消息,群里会收到
 * maxRetries+1 份(用户实测的「图集重复推送」)。发送路径见到本错误必须立即放弃
 * 重试、如实报失败;只有「确定没发出去」(无连接 / 发送即抛错 / bot 明确报失败)
 * 才允许走重试。
 */
class IndeterminateActionError extends Error {
	constructor(
		message: string,
		/** 是等响应等到超时(true),还是连接中途断了(false)。幂等的探测靠它分 `timeout` 与 `unavailable`。 */
		readonly isTimeout: boolean,
	) {
		super(message);
	}
}

/** 附在「结果未知」失败的原话上,提示用户群里可能已收到、且为何不再重试。 */
const INDETERMINATE_NOTE = "(动作已发出、结果未知,为免重复送达不再重试)";

/** 合并转发动作 —— NapCat 要逐张下载图片再上传组装,处理时长远超普通消息。 */
function isForwardAction(action: string): boolean {
	return action === "send_group_forward_msg" || action === "send_private_forward_msg";
}

/**
 * 这条消息带不带图 —— 带图的 OneBot 实现要先把图落盘再传腾讯图床才回响应,耗时与
 * 图多大关系不大(卡片图只有 0.1MB 量级),但稳定压在十几秒。
 *
 * 按**最终要发出去的 message 段**判,不按 payload.kind:段才是真正决定 bot 侧干多少
 * 活的东西。`image-group` 且 `mergeForward:false` 就是活例 —— 它 kind 看着像图集,却被
 * buildSegments 并成了普通多图 send_group_msg,照 kind 判会漏掉最该放宽的那一类。
 */
function hasImageSegment(params: Record<string, unknown>): boolean {
	const message = params.message;
	if (!Array.isArray(message)) return false;
	return message.some((seg) => (seg as OneBotMessageSegment | null)?.type === "image");
}

/**
 * 这次动作该等多久的**下限**(0 = 不放宽,照配置走)。HTTP 与 WS 两条路共用,免得
 * 两边各判一次、日后漂移成「WS 放宽了 HTTP 没有」。
 *
 * 只给真的慢的活放宽:纯文字消息不动 —— bot 真挂了的场景,每条文本都多等几十秒
 * 只会让失败来得更晚,并拖住串行发送的后续目标。
 */
function minTimeoutFor(
	action: string,
	params: Record<string, unknown>,
	limits: { forward: number; image: number },
): number {
	if (isForwardAction(action)) return limits.forward;
	if (hasImageSegment(params)) return limits.image;
	return 0;
}

/**
 * 这条连接实际生效的两档下限。**adapter 配置里的值优先** —— 界面上那两栏就是主人的
 * 意思,内建默认只是「没配过」时的兜底(schema 会给解析过的配置补 default,所以回落
 * 这条路只在测试注入和未过 schema 的裸配置上走到)。
 *
 * 配 `0` 就是关掉放宽:为快速故障转移特意把 `timeoutMs` 调小的用户,不该被下限静默
 * 无视 —— 串行扇出下,每个目标多等的那几十秒是要累加的。
 */
function minTimeoutLimits(
	cfg: { mergeForwardMinTimeoutMs?: number; imageMinTimeoutMs?: number },
	fallbacks: { forward: number; image: number },
): { forward: number; image: number } {
	return {
		forward: cfg.mergeForwardMinTimeoutMs ?? fallbacks.forward,
		image: cfg.imageMinTimeoutMs ?? fallbacks.image,
	};
}

/**
 * 这个 adapter 认的那一档连接 —— `isMine(c)` 收窄之后的形状,`settings` 跟着窄成
 * {@link OnebotConnectionSettings}。**宿主递来的连接,`settings` 一律是按
 * `OnebotConnectionSettingsSchema` 解过的输出**(派发器与适配器上下文保证),这里只认键、不再解。
 * 内部那些 helper 一律收它,于是「这是条 OneBot 连接」只在几个入口各判一次,底下不用再一路 `as` 下去。
 */
type OnebotConnection = Connection & { settings: OnebotConnectionSettings };

/** 适配器键。适配器的 `adapterKey`、下面的设置段与 `isMine` 引同一个,免得两处写漂。 */
const ADAPTER_KEY = "onebot";

/**
 * 登记进配置仓的那一段(ADR-0025 决策 2:每个拿到集成上下文的集成都有一段)。今天它没有任何格 ——
 * 连接的设置住连接自己身上,不在集成级;登记是为了集成上下文上的 `settings(规则)` 读这个键时有段可读
 * (配置仓对根本没登记的键会抛)。
 */
export const onebotSettingsSegment: IntegrationSettingsSegment = {
	key: ADAPTER_KEY,
	schema: z.object({}),
};

const isMine = (c: Connection): c is OnebotConnection => c.adapterKey === ADAPTER_KEY;

type OnebotHttpConfig = Extract<OnebotConnectionSettings, { transport: "http" }>;
type OnebotWsConfig = Extract<OnebotConnectionSettings, { transport: "ws" }>;
type OnebotWsReverseConfig = Extract<OnebotConnectionSettings, { transport: "ws-reverse" }>;

interface OneBotMessageSegment {
	type: "text" | "image" | "at" | "json";
	data: Record<string, string>;
}

/** OneBot v11 action 响应帧 / HTTP 响应体(同形)。 */
interface OneBotResponse {
	status?: "ok" | "failed" | "async";
	retcode?: number;
	/**
	 * 不是协议里的格:HTTP 非 2xx 时我们自己合成的那一帧才有,装 HTTP 状态。`retcode` 里照旧也抄一份
	 * (重试与「接口不存在」的判读都看它),翻成失败时靠这一格把「HTTP 状态」与「bot 的 retcode」分开。
	 */
	httpStatus?: number;
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
	switch (seg.kind) {
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
		case "image-group":
			// payload.mergeForward === true 时 buildSendAction 会单独走 send_group_forward_msg
			// 路径,这里返回 []。mergeForward === false 时把多个 URL 转为多 image segment 合并
			// 到一条普通 send_group_msg(对齐上游 koishi 框架 onebot adapter 的多图默认行为,避开
			// NapCat 长消息 SsoSendLongMsg 通道的潜在超时)。
			if (payload.mergeForward) return [];
			return imageGroupUrls(payload.images).map(({ url }) => ({
				type: "image",
				data: { file: url },
			}));
		case "miniapp-card":
			// 要先向腾讯签 ark 才有段可发,send() 单独走 sendMiniAppCard;这里没有现成的段。
			return [];
	}
}

/** OneBot bot 自身身份(由 get_login_info 拉取),决定 forward node 上展示的头像/昵称。 */
interface BotIdentity {
	/** 机器人 QQ 号 → forward node 的 `uin`,客户端按 uin 反查头像。 */
	uin: string;
	/** 机器人昵称 → forward node 的 `name`,客户端按此渲染发送人名。 */
	name: string;
}

/**
 * forward node 在 bot 身份未知时的兜底身份。仅在 get_login_info 失败 / 未实现的
 * OneBot 实现上落到这里 —— uin=10000 是 QQ 官方占位号,头像为默认头像。比"整条
 * forward 推送崩"安全,但显示效果不佳;正常路径都拉得到真实身份。
 */
const FALLBACK_BOT_IDENTITY: BotIdentity = { uin: "10000", name: "bilibili-notify" };

/** 一条翻好的 OneBot 动作:HTTP 把 `action` 当 endpoint,WS 当 action 帧的字段。 */
interface OnebotAction {
	action: string;
	params: Record<string, unknown>;
}

/**
 * 把一次推送翻成 OneBot action(`send_group_msg` / `send_private_msg`)+ params。
 * HTTP 把 action 当 endpoint(加前导 `/`),WS 直接作 action 帧字段。
 *
 * `botInfo` 仅 forward 分支用,缺省走 {@link FALLBACK_BOT_IDENTITY}。caller 应在
 * 走 forward 前先 await `getBotIdentity(adapter)`,拿到真实身份后传进来。
 */
function buildSendAction(
	destination: DestinationRef,
	payload: NotificationPayload,
	botInfo: BotIdentity = FALLBACK_BOT_IDENTITY,
): Result<OnebotAction> {
	// 图集合并转发分支:payload.mergeForward 由设置里的 `imageGroup.mergeForward`
	// 决定。走 send_group_forward_msg / send_private_forward_msg 长消息通道(NapCat
	// 的 SsoSendLongMsg trpc 在某些部署不稳,故默认 false)。
	if (payload.kind === "image-group" && payload.mergeForward) {
		// node.name + node.uin 决定客户端展示的发送人头像 / 昵称。用机器人真身
		// (botInfo)→ 收件人看到的是"机器人发的",对齐上游 koishi 框架的 onebot adapter
		// (它在 src/bot/message.ts 用 `bot.user.name` / `bot.userId` 当 fallback)。
		const nodes = imageGroupUrls(payload.images).map(({ url }) => ({
			type: "node",
			data: {
				name: botInfo.name,
				uin: botInfo.uin,
				content: [{ type: "image", data: { file: url } }],
			},
		}));
		const to = onebotNumericAddress(destination);
		if (!to.ok) return to;
		return to.private
			? ok({ action: "send_private_forward_msg", params: { user_id: to.id, messages: nodes } })
			: ok({ action: "send_group_forward_msg", params: { group_id: to.id, messages: nodes } });
	}
	return buildSendActionFromSegments(destination, buildSegments(payload));
}

/** 普通消息(send_group_msg / send_private_msg)的 action + params;段已经翻好了。 */
function buildSendActionFromSegments(
	destination: DestinationRef,
	segments: OneBotMessageSegment[],
): Result<OnebotAction> {
	if (segments.length === 0) return fail("invalid", "empty payload");
	const to = onebotNumericAddress(destination);
	if (!to.ok) return to;
	const params: Record<string, unknown> = { message: segments };
	if (to.private) {
		params.user_id = to.id;
		return ok({ action: "send_private_msg", params });
	}
	params.group_id = to.id;
	return ok({ action: "send_group_msg", params });
}

/**
 * 目标的地址 → OneBot 要的那个数字 id,外加「这一发是不是私聊」。
 *
 * 群还是私聊只看 `destination.scope`(原来的「强制私聊」覆盖已删)。
 *
 * 非数字地址 → `Number()` 得 NaN → 序列化成 null,OneBot 端静默错投。提前拒。
 */
function onebotNumericAddress(
	destination: DestinationRef,
): Result<{ private: boolean; id: number }> {
	// 端点目标没有会话可言(也没有 scope):按群的说法回,与它原来恒为 channel 时的话一样。
	if (destination.kind !== "session") return fail("invalid", "group: groupId missing");
	const isPrivate = destination.scope === "private";
	const what = isPrivate ? "private: userId" : "group: groupId";
	if (!destination.address) return fail("invalid", `${what} missing`);
	const id = Number(destination.address);
	if (!Number.isFinite(id)) return fail("invalid", `${what} 非数字 (${destination.address})`);
	return ok({ private: isPrivate, id });
}

/**
 * 识别 NapCat 内部因为 QQ 掉线 / 未登录 / NT 框架卡死产生的错误模式,这些是
 * NapCat ↔ QQNT 通信问题(不是我们 payload 的事),靠 retry / 改 payload 都
 * 解决不了 —— 用户需要重启 / 重登 NapCat。把它们用人话标出来,避免一眼看不出
 * 是 NapCat 端问题。
 */
const NAPCAT_DISCONNECT_HINTS = [
	"NTEvent",
	"NodeIKernelMsgService",
	"onMsgInfoListUpdate",
	"SsoSendLongMsg",
	"PacketClient",
	"not logged in",
	"bot offline",
];
function isLikelyNapcatDisconnected(err: string): boolean {
	const lower = err.toLowerCase();
	return NAPCAT_DISCONNECT_HINTS.some((h) => lower.includes(h.toLowerCase()));
}
const NAPCAT_DISCONNECT_SUFFIX = "(NapCat 可能掉线 / QQ 未登录,请检查 NapCat 状态)";

/** OneBot 11 的「不支持的动作」—— 这个实现没有这个接口。 */
const RETCODE_ACTION_NOT_FOUND = 1404;

/**
 * OneBot 响应判定:`status:"ok"` + `retcode:0` 为成功。失败翻成标准码(ADR-0026):
 * - HTTP 非 2xx(我们合成的那一帧)按状态码翻,`upstreamCode` 写成 `http:<status>`;
 * - retcode 1404 是「接口不存在」→ `unsupported`;
 * - 别的 retcode 这里没有对照 → `unknown`,数字原样放 `upstreamCode`。
 */
function interpretResponse(r: OneBotResponse): Result {
	if (r.status === "ok" && (r.retcode ?? 0) === 0) return ok();
	const raw = r.wording ?? r.message ?? r.msg ?? `retcode=${r.retcode}`;
	const message = isLikelyNapcatDisconnected(raw) ? `${raw} ${NAPCAT_DISCONNECT_SUFFIX}` : raw;
	if (r.httpStatus !== undefined) return httpFailure(r.httpStatus, message);
	if (r.retcode === RETCODE_ACTION_NOT_FOUND) {
		return fail("unsupported", message, { upstreamCode: r.retcode });
	}
	return fail("unknown", message, r.retcode === undefined ? {} : { upstreamCode: r.retcode });
}

/** 对端回了非 2xx:状态码 → 标准码;状态码本身留在 `upstreamCode`,带 `http:` 前缀好与 retcode 分开。 */
function httpFailure(status: number, message: string): Failure {
	const upstreamCode = `http:${status}`;
	if (status === 401 || status === 403) return fail("unauthorized", message, { upstreamCode });
	if (status === 404 || status === 410) return fail("not_found", message, { upstreamCode });
	if (status === 429) return fail("rate_limited", message, { upstreamCode });
	if (status >= 400 && status < 500) return fail("invalid", message, { upstreamCode });
	return fail("unavailable", message, { upstreamCode });
}

/**
 * 调用抛出来的错 → 失败。分两种场合:
 * - `sent`:非幂等的 send_* 已经发出去了。「结果未知」(超时 / 断连)记 `indeterminate`,原话注明不再重试;
 * - `idempotent`:探测、签卡这类可以重来、且真正的消息还没发的。超时记 `timeout`。
 * 两种场合下别的错(连不上、没连着、发帧即抛)都是 `unavailable`。
 */
function thrownFailure(e: unknown, phase: "sent" | "idempotent"): Failure {
	if (e instanceof IndeterminateActionError) {
		if (phase === "sent") return fail("indeterminate", e.message + INDETERMINATE_NOTE);
		return fail(e.isTimeout ? "timeout" : "unavailable", e.message);
	}
	return fail("unavailable", upstreamMessage(e));
}

// ---------------------------------------------------------------------------
// HTTP transport(沿用原实现)
// ---------------------------------------------------------------------------

function trimTrailingSlash(s: string): string {
	return s.endsWith("/") ? s.slice(0, -1) : s;
}

async function postOnebotOnce(
	http: HttpClient,
	cfg: OnebotHttpConfig,
	endpoint: string,
	body: Record<string, unknown>,
	timeoutMs: number,
): Promise<OneBotResponse> {
	const url = `${trimTrailingSlash(cfg.baseUrl)}${endpoint}`;
	const headers: Record<string, string> = { "content-type": "application/json", ...cfg.headers };
	if (cfg.accessToken) headers.authorization = `Bearer ${cfg.accessToken}`;

	// bot 是主人自己填的地址:不带浏览器身份、不碰集成的 cookie 罐,线上只有上面这几个头。
	// 超时交给客户端按单跳算(合并转发的 60 秒下限也在 `timeoutMs` 里,不能落回客户端默认的 20 秒)。
	const res = await http.fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		timeoutMs,
		bare: true,
	});
	if (!res.ok) {
		// 客户端自己的超时:请求已发出、结果未知 —— 与 WS 响应超时同等对待。
		if (res.code === "timeout") {
			throw new IndeterminateActionError(`HTTP 请求超时 (${timeoutMs}ms)`, true);
		}
		throw new Error(res.message);
	}
	if (!res.isSuccess) {
		const statusText = STATUS_CODES[res.status];
		return {
			status: "failed",
			retcode: res.status,
			httpStatus: res.status,
			message: statusText ? `HTTP ${res.status} ${statusText}` : `HTTP ${res.status}`,
		};
	}
	const parsed = res.json();
	if (!parsed.ok) throw new Error(parsed.message);
	return parsed.value as OneBotResponse;
}

async function postOnebot(
	http: HttpClient,
	cfg: OnebotHttpConfig,
	endpoint: string,
	body: Record<string, unknown>,
	fallbackTimeoutMs: number,
	opts?: {
		/** 超时下限(合并转发动作放宽用),取 max(cfg.timeoutMs, minTimeoutMs)。 */
		minTimeoutMs?: number;
		/** 非幂等动作(send_*):「结果未知」失败不得盲重试,见 IndeterminateActionError。 */
		nonIdempotent?: boolean;
	},
): Promise<OneBotResponse> {
	const maxRetries = cfg.maxRetries ?? 0;
	const retryIntervalMs = cfg.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
	const timeoutMs = Math.max(cfg.timeoutMs ?? fallbackTimeoutMs, opts?.minTimeoutMs ?? 0);
	let lastErr: unknown;
	let lastResponse: OneBotResponse | undefined;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			const result = await postOnebotOnce(http, cfg, endpoint, body, timeoutMs);
			if (result.status === "ok" && result.retcode === 0) return result;
			lastResponse = result;
		} catch (e) {
			// 超时 = 结果未知,消息可能已送达 —— 非幂等动作重发即重复,立即向上抛。
			if (opts?.nonIdempotent && e instanceof IndeterminateActionError) throw e;
			lastErr = e;
		}
		if (attempt < maxRetries && retryIntervalMs > 0) {
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
	/** 作废了(见 {@link rejectAll}):之后这条连接上再来的帧一律不认。 */
	private retired = false;

	constructor(
		// 正向连接是客户端交来的 `WebSocketLike`,反向是 `ws` 的实例:两边都满足的窄形状。
		private readonly ws: WebSocketLike,
		private readonly idPrefix: string,
		private readonly serviceCtx: ServiceContext,
		/**
		 * 入站事件出口。缺省 = 保持纯 push-only(旧行为)。
		 *
		 * 只在这里开了一道口子:帧仍旧原样交出去,认不认、认哪些,全由上层决定。
		 * adapter 自己不解析业务语义 —— 它只知道「这是一条没有 echo 的帧」。
		 */
		private readonly onInbound?: (frame: Record<string, unknown>) => void,
	) {
		ws.on("message", (raw) => this.onMessage(raw as RawData));
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
				// 帧已发出、只是没等到响应 → 结果未知(bot 可能仍在处理并最终发出消息)。
				reject(new IndeterminateActionError(`ws action ${action} 响应超时 (${timeoutMs}ms)`, true));
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
		if (this.retired) return;
		let frame: OneBotResponse;
		try {
			frame = JSON.parse(rawToString(raw)) as OneBotResponse;
		} catch {
			return; // 非 JSON,丢弃
		}
		const echo = typeof frame.echo === "string" ? frame.echo : undefined;
		// 无 echo = 入站事件 / heartbeat。以前一律忽略(纯 push-only);现在交给上层,
		// 由它决定认不认 —— 审批要靠这条路把主人回的 y 收回来。没接 onInbound 的
		// 场景行为不变。echo 不在表里 = 未知响应,仍旧丢弃。
		if (!echo) {
			try {
				this.onInbound?.(frame as unknown as Record<string, unknown>);
			} catch {
				// 上层解析炸了不该影响这条 WS 的收发 —— 它还担着推送。
			}
			return;
		}
		const p = this.pending.get(echo);
		if (!p) return;
		this.pending.delete(echo);
		p.timer.dispose();
		p.resolve(frame);
	}

	/**
	 * 连接断开 / dispose:未决请求全部 reject,避免一直挂到超时。
	 * 未决 = 帧已写入 socket、还没等到响应 → 一律按「结果未知」处置
	 * (统一包成 IndeterminateActionError,发送路径见之不重试)。
	 *
	 * 同时把通道作废:`ws.close()` 只是发出关闭帧,对端回关闭帧之前(不配合的对端最长 30 秒)底下的消息监听
	 * 还在,这段时间里来的帧不能再当入站消息往上交 —— 被请出去的那一头(比如 token 换掉之后凭旧 token 连着的)
	 * 否则还能接着往里发指令。
	 */
	rejectAll(err: Error): void {
		this.retired = true;
		for (const p of this.pending.values()) {
			p.timer.dispose();
			p.reject(
				err instanceof IndeterminateActionError
					? err
					: new IndeterminateActionError(err.message, false),
			);
		}
		this.pending.clear();
	}
}

/**
 * 通道只知道帧;归一化与来源 adapter 由这一层补上。两种连法(正向 / 反向)都要补,
 * 而交出去的形状是适配器与消费者之间的契约 —— 各写一份的话,往里加字段时另一种连法
 * 就悄悄少了那个字段。
 */
function inboundSink(
	inbound: PlatformAdapterContext["inbound"],
	connectionId: string,
): (frame: Record<string, unknown>) => void {
	// 平台不在这儿报:宿主按连接补(`ctx.inbound` 只收 `connectionId`)。
	return (frame) => routeInboundFrame(frame, { connectionId }, inbound);
}

/** 正向 WS:独立端作客户端主动连 bot,断线指数退避重连。 */
class ForwardConn {
	private ws: WebSocketLike | null = null;
	private channel: WsChannel | null = null;
	private reconnectTimer: Disposable | null = null;
	private attempt = 0;
	private closed = false;
	lastError: string | null = null;

	constructor(
		readonly connectionId: string,
		readonly fingerprint: string,
		private readonly url: string,
		private readonly headers: Record<string, string>,
		private readonly http: HttpClient,
		private readonly serviceCtx: ServiceContext,
		private readonly log: Logger,
		private readonly inbound: PlatformAdapterContext["inbound"],
	) {
		this.connect();
	}

	private connect(): void {
		if (this.closed) return;
		this.reconnectTimer = null;
		// 不带浏览器身份、不带 cookie:线上握手的头只有 `forwardHeaders`(Bearer 与主人配的头)。
		const opened = this.http.websocket(this.url, { headers: this.headers, bare: true });
		if (!opened.ok) {
			this.lastError = opened.message;
			this.scheduleReconnect();
			return;
		}
		const ws = opened.socket;
		this.ws = ws;
		ws.on("open", () => {
			this.attempt = 0;
			this.lastError = null;
			this.channel = new WsChannel(
				ws,
				`fwd:${this.connectionId}`,
				this.serviceCtx,
				inboundSink(this.inbound, this.connectionId),
			);
			this.log.info(`[onebot] 正向 WS 已连接 adapter=${this.connectionId} url=${this.url}`);
		});
		ws.on("error", (err) => {
			this.lastError = upstreamMessage(err);
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
		readonly connectionId: string,
		readonly port: number,
		private accessToken: string | undefined,
		private readonly serviceCtx: ServiceContext,
		private readonly log: Logger,
		private readonly inbound: PlatformAdapterContext["inbound"],
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
			this.log.info(`[onebot] 反向 WS 监听就绪 adapter=${this.connectionId} port=${this.port}`);
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
				`[onebot] 反向 WS 鉴权失败 adapter=${this.connectionId} port=${this.port},拒绝连接`,
			);
			ws.close(1008, "unauthorized");
			return;
		}
		const channel = new WsChannel(
			ws,
			`rev:${this.connectionId}`,
			this.serviceCtx,
			inboundSink(this.inbound, this.connectionId),
		);
		const entry = { ws, channel };
		this.bots.add(entry);
		this.log.info(
			`[onebot] 反向 WS bot 已连入 adapter=${this.connectionId}(在线 ${this.bots.size})`,
		);
		if (this.bots.size > 1) {
			// 一个反向 WS 端口正常只对应一个 bot;多个时推送只发往最近连入的那个,
			// 其余静默闲置 —— 大概率是把多个 bot 误指到同一端口,告警提示。
			this.log.warn(
				`[onebot] 反向 WS adapter=${this.connectionId} 端口 ${this.port} 有 ${this.bots.size} 个 bot 连入,` +
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

	/**
	 * 换握手要验的 token(没变就什么都不做)。端口不用重绑,监听器还是这一个;但已经连着的 bot 是凭旧 token
	 * 进来的,一并请出去 —— 不然泄露的旧 token 换掉之后,拿着它连进来的那一头照样收得到推送。
	 */
	replaceAccessToken(accessToken: string | undefined): void {
		if ((accessToken ?? "") === (this.accessToken ?? "")) return;
		this.accessToken = accessToken;
		if (this.bots.size > 0) {
			this.log.info(
				`[onebot] 反向 WS 的 token 换了 adapter=${this.connectionId},断开凭旧 token 连入的 ${this.bots.size} 个 bot`,
			);
		}
		this.dropBots("token 已更换", 1008);
	}

	private dropBots(reason: string, code?: number): void {
		for (const e of this.bots) {
			e.channel.rejectAll(new Error(reason));
			try {
				e.ws.close(code);
			} catch {
				/* ignore */
			}
		}
		this.bots.clear();
	}

	close(): void {
		this.dropBots("adapter 已关闭");
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
	// 「adapter 配置里没写」时才用得上的兜底;真正生效的值见 minTimeoutLimits()。
	const minTimeoutFallbacks = {
		forward: opts.mergeForwardMinTimeoutMs ?? DEFAULT_FORWARD_MIN_TIMEOUT_MS,
		image: opts.imageMinTimeoutMs ?? DEFAULT_IMAGE_MIN_TIMEOUT_MS,
	};

	const forwardConns = new Map<string, ForwardConn>();
	const reverseListeners = new Map<string, ReverseListener>();
	/**
	 * Per-adapter bot 身份 lazy 缓存。key = adapter.id,value = 调 get_login_info
	 * 的 Promise(返回真实身份,失败时返回 null)。命中走缓存避免每次 forward 都
	 * 调一次 API;首次未命中由 forward 分支按 transport 路由发起请求。
	 *
	 * 失效场景:reconcile 删 adapter 时同步删 entry。WS 重连不清缓存(self_id
	 * 与 nickname 极少变;若 bot 换号了得显式改 adapter 配置触发 reconcile)。
	 */
	const botIdentityCache = new Map<string, Promise<BotIdentity | null>>();
	let disposed = false;
	/** `start(ctx)` 接住的那份客户端;生产里登记即 start,所以只有测试会碰到「还没接住」。 */
	let http: HttpClient | undefined;

	/** 要发 HTTP / 开正向 WS 的地方取客户端;还没 start 就抛,由各处的失败路翻成 `unavailable`。 */
	function httpOrThrow(): HttpClient {
		if (!http) throw new Error(t("connection.adapterNotStarted"));
		return http;
	}

	function disposeAll(): void {
		if (disposed) return;
		disposed = true;
		for (const c of forwardConns.values()) c.close();
		forwardConns.clear();
		for (const l of reverseListeners.values()) l.close();
		reverseListeners.clear();
		botIdentityCache.clear();
		miniAppCardSupport.clear();
		capabilityFingerprints.clear();
	}
	// 兜底:即便 engines.dispose 没显式调到,serviceCtx 结束时也关干净。
	serviceCtx.onDispose(disposeAll, "stop");

	/**
	 * OneBot v11 `get_login_info` 返回 `{ user_id: number, nickname: string }`,
	 * 翻译成 forward node 用的 `{ uin, name }`。无效响应返回 null,由 caller 决
	 * 定 fallback 策略(目前都 fallback 到 {@link FALLBACK_BOT_IDENTITY})。
	 */
	function parseLoginInfo(raw: unknown): BotIdentity | null {
		if (!raw || typeof raw !== "object") return null;
		const d = raw as { user_id?: unknown; nickname?: unknown };
		// OneBot v11 协议 user_id 通常是 number,但部分实现(NapCat 老版本 / JS 数字
		// 精度兜底)序列化为 string。两种都收;数字串(纯 \d+)以外的 string 视无效。
		let uin: string | null = null;
		if (typeof d.user_id === "number" && Number.isFinite(d.user_id)) {
			uin = String(d.user_id);
		} else if (typeof d.user_id === "string" && /^\d+$/.test(d.user_id)) {
			uin = d.user_id;
		}
		const name = typeof d.nickname === "string" && d.nickname.length > 0 ? d.nickname : null;
		if (!uin || !name) return null;
		return { uin, name };
	}

	/**
	 * 调 OneBot `get_login_info` 拿 bot 身份。三种 transport 各自分发:
	 *   - http:走 `postOnebot`
	 *   - ws / ws-reverse:从 channel 调 `call("get_login_info", ...)`
	 *
	 * 失败统一返回 null,buildSendAction 兜到 FALLBACK_BOT_IDENTITY,保推送可达。
	 */
	async function fetchBotIdentity(connection: OnebotConnection): Promise<BotIdentity | null> {
		const cfg = connection.settings;
		try {
			if (cfg.transport === "http") {
				const res = await postOnebot(httpOrThrow(), cfg, "/get_login_info", {}, fallbackTimeoutMs);
				const verdict = interpretResponse(res);
				if (!verdict.ok) return null;
				return parseLoginInfo(res.data);
			}
			const channel = channelOf(connection.id, cfg);
			if (!channel) return null;
			const res = await channel.call("get_login_info", {}, cfg.timeoutMs ?? fallbackTimeoutMs);
			const verdict = interpretResponse(res);
			if (!verdict.ok) return null;
			return parseLoginInfo(res.data);
		} catch (e) {
			log.warn(`[onebot] adapter=${connection.id} get_login_info 失败: ${String(e)}`);
			return null;
		}
	}

	/**
	 * 取 bot 身份:命中缓存返回缓存 Promise,未命中发起请求并缓存。
	 *
	 * **只缓存成功结果**:若 fetch 失败(返回 null),立即把 entry 移除 —— 下一次
	 * send 会重试。否则 OneBot 实现"暂时挂掉再起"的场景下,本进程会永远 fallback
	 * 到 FALLBACK_BOT_IDENTITY,直到 reconcile 才清缓存,体验不好。
	 *
	 * 并发安全:同一 adapter 多个 send 并发触发首次 fetch,共享同一个 Promise —— 后
	 * 续 send 命中缓存(此时 Promise 还未 resolve),不会重复发请求;Promise resolve
	 * 后若是 null,后续来的 send 会重新发起 fetch。
	 */
	function getBotIdentity(connection: OnebotConnection): Promise<BotIdentity | null> {
		const cached = botIdentityCache.get(connection.id);
		if (cached) return cached;
		const p = fetchBotIdentity(connection);
		botIdentityCache.set(connection.id, p);
		p.then((result) => {
			// 失败结果不留缓存,允许下次 send 重新探测。已被新 fetch 覆盖时不动。
			if (result === null && botIdentityCache.get(connection.id) === p) {
				botIdentityCache.delete(connection.id);
			}
		});
		return p;
	}

	// ------------------------------------------------------------------
	// 平台能力:能不能签 QQ 小程序卡
	// ------------------------------------------------------------------

	/** 探测结果按 adapter 缓存;配置变了或连接没了才丢。没探过 = unknown。 */
	const miniAppCardSupport = new Map<string, CapabilitySupport>();
	/** 每个 adapter 上次 reconcile 时的配置指纹:没变就不丢它的能力缓存。 */
	const capabilityFingerprints = new Map<string, string>();
	const NOT_PROBED: CapabilitySupport = { state: "unknown" };
	/** `atAll` / `inbound` 是静态事实,没有「探」这回事;`checkedAt` 就取适配器创建的这一刻。 */
	const adapterStartedAt = Date.now();

	function channelOf(connectionId: string, cfg: OnebotWsConfig | OnebotWsReverseConfig) {
		return cfg.transport === "ws"
			? (forwardConns.get(connectionId)?.getChannel() ?? null)
			: (reverseListeners.get(connectionId)?.getChannel() ?? null);
	}

	/**
	 * 调一次 action、不重试 —— 探测与签卡用;真正的发送仍走各自带重试的路。
	 * 三种 transport 在这里汇成一条:http 直接 POST,ws / ws-reverse 从 channel 发 echo 帧。
	 */
	async function callOnce(
		connection: OnebotConnection,
		action: string,
		params: Record<string, unknown>,
	): Promise<OneBotResponse> {
		const cfg = connection.settings;
		const timeoutMs = cfg.timeoutMs ?? fallbackTimeoutMs;
		if (cfg.transport === "http") {
			return postOnebotOnce(httpOrThrow(), cfg, `/${action}`, params, timeoutMs);
		}
		const channel = channelOf(connection.id, cfg);
		if (!channel) {
			throw new Error(cfg.transport === "ws" ? "正向 WS 未连接" : "无 bot 连入(反向 WS)");
		}
		return channel.call(action, params, timeoutMs);
	}

	/** 「这个实现没有 get_mini_app_ark」:OneBot 11 的 1404,或把 action 当路径的实现回 HTTP 404。 */
	function isActionMissing(r: OneBotResponse): boolean {
		return r.retcode === 1404 || r.retcode === 404;
	}

	/**
	 * 空参数探测的判读。1400「参数错」正说明接口在;真成功(0)也算在 —— 有的实现对空参不挑。
	 * 别的都是没探出来:连不上、鉴权失败、实现自己的错误码,原因带出去给面板。
	 */
	function interpretArkProbe(r: OneBotResponse): CapabilitySupport {
		const checkedAt = Date.now();
		if (isActionMissing(r)) {
			return { state: "unsupported", reason: "这个 OneBot 实现没有 get_mini_app_ark", checkedAt };
		}
		if (r.retcode === 1400 || (r.status === "ok" && (r.retcode ?? 0) === 0)) {
			return { state: "supported", checkedAt };
		}
		return { state: "unknown", reason: r.wording ?? r.message ?? r.msg ?? `retcode=${r.retcode}` };
	}

	/**
	 * 探一次,如实回这一趟看到的(探不出来就是「还不知道」,带原因)。什么时候探、探不出来时
	 * 沿用哪个答案不在这里:节奏与「不推翻已探实的答案」归宿主(`push/target-dispatcher.ts`),
	 * 适配器只管自己看到的事实 —— 包括真发时收到 1404 把它翻成「不支持」(见 sendMiniAppCard)。
	 */
	async function probeMiniAppCard(connection: OnebotConnection): Promise<CapabilitySupport> {
		let result: CapabilitySupport;
		try {
			result = interpretArkProbe(await callOnce(connection, "get_mini_app_ark", {}));
		} catch (e) {
			result = { state: "unknown", reason: e instanceof Error ? e.message : String(e) };
		}
		miniAppCardSupport.set(connection.id, result);
		// 与 get_login_info 同一条规矩:探成了不出声。发不了才留一行 —— 主人选了小程序卡却
		// 收到图片卡时,这是唯一能解释原因的地方;没探出来多半是还没连上,宿主每分钟会再试,
		// 放 debug 免得刷屏。
		if (result.state === "unsupported") {
			log.info(`[onebot] adapter=${connection.id} 发不了小程序卡:${result.reason}`);
		} else if (result.state === "unknown") {
			log.debug(`[onebot] adapter=${connection.id} 小程序卡能力还没探出来:${result.reason ?? "?"}`);
		}
		return result;
	}

	/**
	 * 发一张小程序卡:先向腾讯签 ark(bili 模板),再把 ark 当 `json` 段走普通发送。
	 * 签卡收到 1404 → 翻成不支持、不发;别的失败只报这一条,缓存不动(可能只是暂时的)。
	 *
	 * 签卡请求的两个链接字段别看名字:`jumpUrl` 是**小程序页面路径**,`webUrl` 才是网页链接。
	 * QQ 客户端源码里(MiniProgramOpenSdkUtil)前者接的是 OpenSDK 的 `mini_program_path`,
	 * 后者接的是 `url`、签回来落到卡的 `qqdocurl`。NapCat 文档把前者写成「跳转 URL」,照着
	 * 填网址签出来的卡点开是「页面不存在」;`webUrl` 不填则卡上压根没有 `qqdocurl`。
	 */
	async function sendMiniAppCard(
		connection: OnebotConnection,
		destination: DestinationRef,
		card: Extract<NotificationPayload, { kind: "miniapp-card" }>,
	): Promise<DeliveryResult> {
		const t0 = Date.now();
		let ark: unknown;
		try {
			const r = await callOnce(connection, "get_mini_app_ark", {
				type: "bili",
				title: card.title,
				desc: card.desc,
				picUrl: card.picUrl,
				jumpUrl: card.path,
				webUrl: card.jumpUrl,
			});
			if (isActionMissing(r)) {
				const reason = "这个 OneBot 实现没有 get_mini_app_ark,发不了小程序卡";
				miniAppCardSupport.set(connection.id, {
					state: "unsupported",
					reason,
					checkedAt: Date.now(),
				});
				// 把 action 当路径的实现回的是 HTTP 404:在这里它的意思同样是「没有这个接口」。
				return fail("unsupported", reason, {
					upstreamCode: r.httpStatus === undefined ? r.retcode : `http:${r.httpStatus}`,
				});
			}
			const verdict = interpretResponse(r);
			if (!verdict.ok) return signFailure(verdict);
			ark = r.data;
		} catch (e) {
			// 签卡可以重来,真正的消息还没发:超时就是超时,不是「结果未知」。
			return signFailure(thrownFailure(e, "idempotent"));
		}
		const data = arkToSegmentData(ark);
		if (data === null) return fail("invalid", "签小程序卡失败: 返回的不是 ark");
		miniAppCardSupport.set(connection.id, { state: "supported", checkedAt: Date.now() });
		const built = buildSendActionFromSegments(destination, [{ type: "json", data: { data } }]);
		if (!built.ok) return built;
		return dispatch(connection, destination, built, t0);
	}

	/** 签卡那一步的失败:码与 `upstreamCode` 照留,原话前面说明是哪一步。 */
	function signFailure(failure: Failure): Failure {
		return { ...failure, message: `签小程序卡失败: ${failure.message}` };
	}

	/**
	 * 把 `get_mini_app_ark` 交出来的东西整理成 `json` 段的 `data`(一个 ark 的 JSON 字符串)。
	 *
	 * NapCat 的 handler 返回 `{ data: ark }`,OneBot 帧再包一层 `data`,于是响应里是
	 * `data.data` 才是 ark —— 真机踩到过:把外面那层整个发出去,腾讯认不出、直接吞掉,NapCat
	 * 等不到上屏回调才报超时,日志里只有一句「NapCat 可能掉线」。别家实现可能不套这一层,
	 * 也可能交字符串:看到 `app` 字段就是 ark 本体,只有 `data` 就剥一层,怎么看都不像的
	 * 不发(发出去也是被吞)。
	 */
	function arkToSegmentData(raw: unknown): string | null {
		let value: unknown = raw;
		if (typeof value === "string") {
			try {
				value = JSON.parse(value);
			} catch {
				return null;
			}
		}
		for (let depth = 0; depth < 2; depth++) {
			if (typeof value !== "object" || value === null) return null;
			const obj = value as Record<string, unknown>;
			if (typeof obj.app === "string") return JSON.stringify(obj);
			if (!("data" in obj)) return null;
			value = obj.data;
		}
		return null;
	}

	/** 一条已经翻好的 action 走 transport 发出去(带各自的重试与超时规则)。 */
	async function dispatch(
		connection: OnebotConnection,
		destination: DestinationRef,
		built: OnebotAction,
		t0: number,
	): Promise<DeliveryResult> {
		const cfg = connection.settings;
		if (cfg.transport === "http") {
			try {
				const result = await postOnebot(
					httpOrThrow(),
					cfg,
					`/${built.action}`,
					built.params,
					fallbackTimeoutMs,
					{
						nonIdempotent: true,
						minTimeoutMs: minTimeoutFor(
							built.action,
							built.params,
							minTimeoutLimits(cfg, minTimeoutFallbacks),
						),
					},
				);
				const verdict = interpretResponse(result);
				if (!verdict.ok) {
					log.warn(
						`[onebot] target=${describeDestination(destination)} send failed: ${verdict.message}`,
					);
					return verdict;
				}
				return ok({ latencyMs: Date.now() - t0 });
			} catch (e) {
				const failure = thrownFailure(e, "sent");
				log.warn(
					`[onebot] target=${describeDestination(destination)} send threw: ${failure.message} (baseUrl=${cfg.baseUrl})`,
				);
				return failure;
			}
		}
		return sendOverWs(
			connection.id,
			cfg,
			built.action,
			built.params,
			describeDestination(destination),
			t0,
		);
	}

	/** WS / WS-reverse 共用的发送(echo 帧 + 重试)。 */
	async function sendOverWs(
		connectionId: string,
		cfg: OnebotWsConfig | OnebotWsReverseConfig,
		action: string,
		params: Record<string, unknown>,
		targetId: string,
		t0: number,
	): Promise<DeliveryResult> {
		const baseTimeoutMs = cfg.timeoutMs ?? fallbackTimeoutMs;
		const timeoutMs = Math.max(
			baseTimeoutMs,
			minTimeoutFor(action, params, minTimeoutLimits(cfg, minTimeoutFallbacks)),
		);
		const maxRetries = cfg.maxRetries ?? 0;
		const retryIntervalMs = cfg.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
		let last: Failure = fail("unavailable", "ws send failed");
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			const channel =
				cfg.transport === "ws"
					? (forwardConns.get(connectionId)?.getChannel() ?? null)
					: (reverseListeners.get(connectionId)?.getChannel() ?? null);
			if (!channel) {
				last = fail(
					"unavailable",
					cfg.transport === "ws" ? "正向 WS 未连接" : "无 bot 连入(反向 WS)",
				);
			} else {
				try {
					const verdict = interpretResponse(await channel.call(action, params, timeoutMs));
					if (verdict.ok) return ok({ latencyMs: Date.now() - t0 });
					last = verdict;
				} catch (e) {
					last = thrownFailure(e, "sent");
					// 结果未知(超时/连接中断):帧已发出,bot 可能已把消息发进群。send_*
					// 非幂等 —— 盲重试 = 群里收到 maxRetries+1 份(用户实测的图集重复
					// 推送)。立即放弃,如实报失败并注明可能已送达。
					if (last.code === "indeterminate") break;
				}
			}
			if (attempt < maxRetries && retryIntervalMs > 0) {
				await new Promise((r) => setTimeout(r, retryIntervalMs));
			}
		}
		log.warn(`[onebot] target=${targetId} ws send failed: ${last.message}`);
		return last;
	}

	function reconcile(
		connections: readonly Connection[],
		inboundHandlers: PlatformAdapterContext["inbound"],
	): void {
		if (disposed) return;
		const onebots = connections.filter((a): a is OnebotConnection => isMine(a) && a.enabled);

		// --- bot 身份缓存清理 ---
		// reconcile 触发频率低(dashboard 改 adapter / target 配置才触发),
		// 直接全清是最简单的"cfg 变更 stale 兜底" —— 用户改了 cfg.url /
		// cfg.baseUrl 指向另一个 bot 实例时,旧 bot 身份不会被错用。代价是
		// 每次 reconcile 后第一次 forward 多一次 get_login_info(15s 超时)。
		botIdentityCache.clear();

		// --- 能力缓存 ---
		// 只在连接的配置真变了(指向另一个实现)或连接没了时丢;配置没变就留着。**不能全清**:
		// 健康探测写回 probeState 也会触发一次 reconcile,全清的话刚探出的答案会被周期性冲掉。
		// 这里只管「适配器手上那一份」;什么时候重探、探不出来时沿用哪个答案,归宿主
		// (`push/target-dispatcher.ts` 的能力记忆),适配器不自己发起探测。
		for (const id of [...capabilityFingerprints.keys()]) {
			if (onebots.some((a) => a.id === id)) continue;
			miniAppCardSupport.delete(id);
			capabilityFingerprints.delete(id);
		}
		for (const a of onebots) {
			const fp = JSON.stringify(a.settings);
			const changed = capabilityFingerprints.get(a.id) !== fp;
			capabilityFingerprints.set(a.id, fp);
			if (changed) miniAppCardSupport.delete(a.id);
		}

		// --- 正向 ws ---
		const desiredFwd = new Map<string, OnebotWsConfig>();
		for (const a of onebots) {
			const cfg = a.settings;
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
			const client = httpOrThrow();
			forwardConns.set(
				id,
				new ForwardConn(
					id,
					fp,
					cfg.url,
					forwardHeaders(cfg),
					client,
					serviceCtx,
					log,
					inboundHandlers,
				),
			);
		}

		// --- 反向 ws ---
		const desiredRev = new Map<string, OnebotWsReverseConfig>();
		for (const a of onebots) {
			const cfg = a.settings;
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
			const kept = reverseListeners.get(id);
			if (kept) {
				// 端口没变:监听器留着,只把要验的 token 对上(没变是 no-op)。
				kept.replaceAccessToken(cfg.accessToken);
				continue;
			}
			// 端口冲突(含与另一 ws-reverse adapter 撞 port)由监听器的 EADDRINUSE
			// error 事件落到 bindError,经 probe 暴露给 dashboard。
			reverseListeners.set(
				id,
				new ReverseListener(id, cfg.port, cfg.accessToken, serviceCtx, log, inboundHandlers),
			);
		}
	}

	return {
		adapterKey: ADAPTER_KEY,
		settingsSchema: OnebotConnectionSettingsSchema,

		async listConnectionCandidates(): Promise<readonly ConnectionCandidate[]> {
			return builtinCandidatesFor("onebot");
		},

		isAvailable(connection: Connection, _destination: DestinationRef): boolean {
			// 连接 / 目标的启停与平台对不对,派发器查过了;这里只留收窄类型。
			if (!isMine(connection)) return false;
			const cfg = connection.settings;
			if (cfg.transport === "http") return cfg.baseUrl.length > 0;
			if (cfg.transport === "ws") return cfg.url.length > 0;
			return true; // ws-reverse:运行期可达性由 send/probe 判断
		},

		start(ctx: PlatformAdapterContext): void {
			http = ctx.http;
			// 登记即启动:先按当前名单对一次账(今天的开机对账),再订连接配置的变动。
			reconcile(ctx.connections(), ctx.inbound);
			ctx.onConnectionsChanged(() => reconcile(ctx.connections(), ctx.inbound));
		},

		stop(): void {
			http = undefined;
			disposeAll();
		},

		async probe(connection: Connection): Promise<ProbeResult> {
			if (!http) return fail("unavailable", t("connection.adapterNotStarted"));
			if (!isMine(connection)) {
				return fail("invalid", `wrong platform: ${connection.adapterKey}`);
			}
			const cfg = connection.settings;
			const t0 = Date.now();
			const timeoutMs = cfg.timeoutMs ?? fallbackTimeoutMs;
			/** 问一次 `get_status`。探测是幂等的:超时记 `timeout`,断连 / 连不上记 `unavailable`。 */
			const ask = async (call: () => Promise<OneBotResponse>): Promise<ProbeResult> => {
				try {
					const verdict = interpretResponse(await call());
					return verdict.ok ? ok({ latencyMs: Date.now() - t0 }) : verdict;
				} catch (e) {
					return thrownFailure(e, "idempotent");
				}
			};
			if (cfg.transport === "http") {
				return ask(() => postOnebotOnce(httpOrThrow(), cfg, "/get_status", {}, timeoutMs));
			}

			if (cfg.transport === "ws") {
				const conn = forwardConns.get(connection.id);
				const channel = conn?.getChannel() ?? null;
				if (!channel) return fail("unavailable", conn?.lastError ?? "正向 WS 未连接");
				return ask(() => channel.call("get_status", {}, timeoutMs));
			}

			// ws-reverse
			const lis = reverseListeners.get(connection.id);
			if (!lis) return fail("unavailable", "反向 WS 监听未启动");
			// 端口绑不上(多半被别的进程占着)等是等不好的,得主人去换端口。
			if (lis.bindError) {
				return fail("not_configured", `端口 ${lis.port} 绑定失败: ${lis.bindError}`);
			}
			const channel = lis.getChannel();
			if (!channel) return fail("unavailable", `端口 ${lis.port} 已监听,等待 bot 连入`);
			return ask(() => channel.call("get_status", {}, timeoutMs));
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
			if (payload.kind === "miniapp-card") return sendMiniAppCard(connection, destination, payload);
			// 先用 fallback botInfo 跑一遍 buildSendAction 做 target 校验 ——
			// session.groupId / userId 缺失等"配错"立即失败返回,不浪费 get_login_info
			// 往返(可能 15s 超时)在一条注定发不出去的消息上。非 forward 路径直接复用
			// 这次结果。
			let built = buildSendAction(destination, payload);
			if (!built.ok) return built;
			const t0 = Date.now();

			// forward 分支需要 bot 真身的 uin/name 才能显示成"机器人发的"。get_login_info
			// 往返计入 latencyMs(t0 已起表),让 history / UI 看到的延迟反映本条消息的
			// 完整端到端开销 —— 用户视角 latency = 这条消息真发出来花了多久,bot 身份
			// 探测是发它必经的一步。getBotIdentity 内部 lazy 缓存,大多数情况下命中走 O(1)。
			if (payload.kind === "image-group" && payload.mergeForward) {
				const botInfo = (await getBotIdentity(connection)) ?? undefined;
				const rebuilt = buildSendAction(destination, payload, botInfo);
				// rebuilt 与首次同 target/payload;target 校验已过,此处失败分支
				// 理论不会触达。守一手保类型收敛。
				if (!rebuilt.ok) return rebuilt;
				built = rebuilt;
			}

			return dispatch(connection, destination, built, t0);
		},

		capabilities(connection: Connection): ConnectionCapabilities {
			return {
				// 静态事实:OneBot 能在群里 @全体,私聊 / 群消息的入站也已经接了。
				atAll: { state: "supported", checkedAt: adapterStartedAt },
				inbound: { state: "supported", checkedAt: adapterStartedAt },
				miniAppCard: miniAppCardSupport.get(connection.id) ?? NOT_PROBED,
			};
		},

		async probeCapabilities(connection: Connection): Promise<ConnectionCapabilities> {
			// 这个方法是唯一**没有**自带那句「不是我的就退回去」的入口(契约上它不返回错,
			// 只返回能力)。矩阵按分发键派活,派到这儿的必是 onebot 直连 —— 那句保证在这里
			// 记一次,底下的 helper 就都收窄类型、不用一路 `as` 下去。
			return {
				atAll: { state: "supported", checkedAt: adapterStartedAt },
				inbound: { state: "supported", checkedAt: adapterStartedAt },
				miniAppCard: await probeMiniAppCard(connection as OnebotConnection),
			};
		},
	};
}
