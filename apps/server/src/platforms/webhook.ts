import { createHmac } from "node:crypto";
import type { PlatformAdapter, ProbeResult } from "@bilibili-notify/internal";
import {
	type Connection,
	connectionDispatchKey,
	type DeliveryResult,
	type Failure,
	fail,
	isWebhookConnection,
	type Logger,
	type NotificationPayload,
	ok,
	type PayloadSegment,
	type PushTarget,
	WEBHOOK_PLATFORMS,
	type WebhookConnectionConfig,
	type WebhookPlatform,
} from "@bilibili-notify/internal";
import { imageGroupUrls } from "./image-group.js";

/**
 * Webhook adapter — POST payloads to either the legacy bilibili-notify JSON
 * endpoint or a supported chat-robot webhook provider.
 *
 * Generic keeps the self-contained JSON envelope (NotificationPayload + base64
 * conversion). DingTalk / Feishu / WeCom use their robot text protocols and downgrade
 * non-text payloads to a readable text summary.
 */
export interface WebhookAdapterOptions {
	logger: Logger;
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

interface WebhookHttpRequest {
	url: string;
	headers: Record<string, string>;
	body: string;
}

export function createWebhookAdapter(opts: WebhookAdapterOptions): PlatformAdapter {
	const log = opts.logger;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	return {
		platforms: [...WEBHOOK_PLATFORMS],
		isAvailable(connection: Connection, target: PushTarget): boolean {
			if (!isWebhookConnection(connection) || target.kind !== "endpoint") return false;
			if (!connection.enabled || !target.enabled) return false;
			const cfg = connection.config;
			return typeof cfg.url === "string" && cfg.url.length > 0;
		},
		async probe(_connection: Connection): Promise<ProbeResult> {
			// Webhook has no standard side-effect-free ping verb — most endpoints
			// reject everything except the exact POST shape they expect. `unsupported`
			// tells the UI to render "probe unsupported" and prompt the
			// user to verify with a real send-test.
			return fail("unsupported", "webhook does not support connection probe");
		},
		async send(
			connection: Connection,
			target: PushTarget,
			payload: NotificationPayload,
			pushOpts: { private?: boolean } = {},
		): Promise<DeliveryResult> {
			if (!isWebhookConnection(connection) || target.kind !== "endpoint") {
				return fail(
					"invalid",
					`wrong shape: connection=${connectionDispatchKey(connection)} ` +
						`target=${target.platform}/${target.kind}`,
				);
			}
			const cfg = connection.config;
			// 方言由**连接的平台**说了算 —— 原先它藏在 config.provider 里。
			const provider = connection.platform;
			// 请求拼不出来(配置的地址不合法,签名时 `new URL` 就抛)是输入的问题,一个字节都没发出去。
			let req: WebhookHttpRequest;
			try {
				req = buildWebhookRequest(provider, cfg, target, payload, pushOpts);
			} catch (e) {
				const message = sanitizeWebhookError(e instanceof Error ? e.message : String(e), cfg);
				log.warn(`[webhook] target=${target.id} send failed: ${message}`);
				return fail("invalid", message);
			}
			const t0 = Date.now();
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), timeoutMs);
			try {
				const res = await fetch(req.url, {
					method: "POST",
					headers: req.headers,
					body: req.body,
					signal: ctrl.signal,
				});
				const latencyMs = Date.now() - t0;
				if (!res.ok) {
					return sanitized(httpFailure(res.status, `HTTP ${res.status} ${res.statusText}`), cfg);
				}
				const rejected =
					provider === "generic" ? null : parseBusinessResponse(provider, await res.text());
				if (rejected) return sanitized(rejected, cfg);
				return ok({ latencyMs });
			} catch (e) {
				const message = sanitizeWebhookError(e instanceof Error ? e.message : String(e), cfg);
				log.warn(`[webhook] target=${target.id} send failed: ${message}`);
				// 我们自己的超时掐断:请求已经发出去了,对端可能照样处理完 —— 结果不明,不是「没通」。
				return ctrl.signal.aborted ? fail("indeterminate", message) : fail("unavailable", message);
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

/**
 * 一次 webhook 投递的 URL / 头 / 体。
 *
 * 这个 adapter 驮的四个平台共用一条 webhook 连法,差别只在**报文方言** —— 所以是这一个
 * 函数的四个分支,不是四个 adapter。
 */
function buildWebhookRequest(
	provider: WebhookPlatform,
	cfg: WebhookConnectionConfig,
	target: PushTarget,
	payload: NotificationPayload,
	pushOpts: { private?: boolean },
): WebhookHttpRequest {
	switch (provider) {
		case "dingtalk":
			return buildDingTalkWebhookRequest(cfg, payload);
		case "feishu":
			return buildFeishuWebhookRequest(cfg, payload);
		case "wecom":
			return buildWeComWebhookRequest(cfg, payload);
		case "generic":
			return buildGenericWebhookRequest(cfg, target, payload, pushOpts);
	}
}

function baseHeaders(cfg: WebhookConnectionConfig): Record<string, string> {
	return {
		"content-type": "application/json",
		...cfg.headers,
	};
}

function buildGenericWebhookRequest(
	cfg: WebhookConnectionConfig,
	target: PushTarget,
	payload: NotificationPayload,
	pushOpts: { private?: boolean },
): WebhookHttpRequest {
	const headers = baseHeaders(cfg);
	if (cfg.secret) headers["x-bilibili-notify-secret"] = cfg.secret;
	return {
		url: cfg.url,
		headers,
		body: JSON.stringify({
			targetId: target.id,
			targetName: target.name,
			scope: target.scope,
			private: !!pushOpts.private,
			payload: serializePayload(payload),
			ts: new Date().toISOString(),
		}),
	};
}

function buildDingTalkWebhookRequest(
	cfg: WebhookConnectionConfig,
	payload: NotificationPayload,
): WebhookHttpRequest {
	const url = cfg.secret ? signDingTalkUrl(cfg.url, cfg.secret) : cfg.url;
	return {
		url,
		headers: baseHeaders(cfg),
		body: JSON.stringify({
			msgtype: "text",
			text: { content: notificationPayloadToRobotText(payload) },
		}),
	};
}

function buildFeishuWebhookRequest(
	cfg: WebhookConnectionConfig,
	payload: NotificationPayload,
): WebhookHttpRequest {
	const body: Record<string, unknown> = {
		msg_type: "text",
		content: { text: notificationPayloadToRobotText(payload) },
	};
	if (cfg.secret) Object.assign(body, signFeishu(cfg.secret));
	return {
		url: cfg.url,
		headers: baseHeaders(cfg),
		body: JSON.stringify(body),
	};
}

function buildWeComWebhookRequest(
	cfg: WebhookConnectionConfig,
	payload: NotificationPayload,
): WebhookHttpRequest {
	return {
		url: cfg.url,
		headers: baseHeaders(cfg),
		body: JSON.stringify({
			msgtype: "text",
			text: { content: notificationPayloadToRobotText(payload) },
		}),
	};
}

function signDingTalkUrl(rawUrl: string, secret: string, nowMs = Date.now()): string {
	const timestamp = String(nowMs);
	const stringToSign = `${timestamp}\n${secret}`;
	const sign = createHmac("sha256", secret).update(stringToSign).digest("base64");
	const url = new URL(rawUrl);
	url.searchParams.set("timestamp", timestamp);
	url.searchParams.set("sign", sign);
	return url.toString();
}

function signFeishu(
	secret: string,
	nowSeconds = Math.floor(Date.now() / 1000),
): {
	timestamp: string;
	sign: string;
} {
	const timestamp = String(nowSeconds);
	const stringToSign = `${timestamp}\n${secret}`;
	return {
		timestamp,
		sign: createHmac("sha256", stringToSign).update("").digest("base64"),
	};
}

/** 对端回了非 2xx:状态码 → 标准码;状态码本身留在 `upstreamCode`(写成 `http:<status>`)。 */
function httpFailure(status: number, message: string): Failure {
	const upstreamCode = `http:${status}`;
	if (status === 401 || status === 403) return fail("unauthorized", message, { upstreamCode });
	if (status === 404 || status === 410) return fail("not_found", message, { upstreamCode });
	if (status === 429) return fail("rate_limited", message, { upstreamCode });
	if (status >= 400 && status < 500) return fail("invalid", message, { upstreamCode });
	return fail("unavailable", message, { upstreamCode });
}

/** 失败的原话过一遍脱敏(地址里的密钥、签名);码与 `upstreamCode` 不动。 */
function sanitized(failure: Failure, cfg: WebhookConnectionConfig): Failure {
	return { ...failure, message: sanitizeWebhookError(failure.message, cfg) };
}

/**
 * 三家机器人 2xx 回应里的业务结果:成功回 null。对端给了业务码的,这里没有对照 ——
 * 记 `unknown`,码放 `upstreamCode`;回应连约定的形状都不是的记 `invalid`。
 */
function parseBusinessResponse(
	provider: Exclude<WebhookPlatform, "generic">,
	text: string,
): Failure | null {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return fail("invalid", `${providerLabel(provider)} response is not JSON`);
	}
	if (!isRecord(body))
		return fail("invalid", `${providerLabel(provider)} response is not an object`);
	switch (provider) {
		case "dingtalk":
			return parseDingTalkBusinessResult(body);
		case "feishu":
			return parseFeishuBusinessResult(body);
		case "wecom":
			return parseWeComBusinessResult(body);
	}
}

function parseDingTalkBusinessResult(body: Record<string, unknown>): Failure | null {
	const errcode = body.errcode;
	if (isZeroCode(errcode)) return null;
	const errmsg = stringValue(body.errmsg);
	const code = businessCode(errcode);
	if (code !== null) {
		return rejectedByPeer(code, `DingTalk errcode=${code}${errmsg ? ` errmsg=${errmsg}` : ""}`);
	}
	return fail("invalid", `DingTalk response missing errcode${errmsg ? ` errmsg=${errmsg}` : ""}`);
}

function parseFeishuBusinessResult(body: Record<string, unknown>): Failure | null {
	const raw = firstPresent(body.code, body.StatusCode, body.status_code);
	if (isZeroCode(raw)) return null;
	const msg = firstString(body.msg, body.message, body.StatusMessage, body.errmsg);
	const code = businessCode(raw);
	if (code !== null) return rejectedByPeer(code, `Feishu code=${code}${msg ? ` msg=${msg}` : ""}`);
	return fail("invalid", `Feishu response missing code${msg ? ` msg=${msg}` : ""}`);
}

function parseWeComBusinessResult(body: Record<string, unknown>): Failure | null {
	const errcode = body.errcode;
	if (isZeroCode(errcode)) return null;
	const errmsg = stringValue(body.errmsg);
	const code = businessCode(errcode);
	if (code !== null) {
		return rejectedByPeer(code, `WeCom errcode=${code}${errmsg ? ` errmsg=${errmsg}` : ""}`);
	}
	return fail("invalid", `WeCom response missing errcode${errmsg ? ` errmsg=${errmsg}` : ""}`);
}

/** 对端明确回了失败、只给了我们没有对照的业务码。 */
function rejectedByPeer(upstreamCode: number | string, message: string): Failure {
	return fail("unknown", message, { upstreamCode });
}

function isZeroCode(value: unknown): boolean {
	return value === 0 || value === "0";
}

/** 对端的业务码:数字与非空字符串原样留着(进 `upstreamCode`),别的不算码。 */
function businessCode(value: unknown): number | string | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.length > 0) return value;
	return null;
}

function providerLabel(provider: Exclude<WebhookPlatform, "generic">): string {
	switch (provider) {
		case "dingtalk":
			return "DingTalk";
		case "feishu":
			return "Feishu";
		case "wecom":
			return "WeCom";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstPresent(...values: unknown[]): unknown {
	return values.find((value) => value !== undefined && value !== null);
}

function firstString(...values: unknown[]): string | null {
	for (const value of values) {
		const s = stringValue(value);
		if (s) return s;
	}
	return null;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function sanitizeWebhookError(message: string, cfg: WebhookConnectionConfig): string {
	let out = message
		.replace(/((?:[?&]|\b)(?:access_token|sign|token|secret|key)=)[^&\s"']+/gi, "$1***")
		.replace(/\b(Authorization)\b(\s*[:=]\s*Bearer\s+)[^\s",;}]+/gi, "$1$2***")
		.replace(/\b(x-bilibili-notify-secret)\b(\s*[:=]\s*)[^\s",;}]+/gi, "$1$2***")
		.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***");
	out = maskConfiguredWebhookUrl(out, cfg.url);
	if (cfg.secret && cfg.secret.length >= 4) out = out.split(cfg.secret).join("***");
	return out;
}

function maskConfiguredWebhookUrl(message: string, rawUrl: string): string {
	const safeUrl = maskWebhookUrlForError(rawUrl);
	const variants = new Set<string>([rawUrl]);
	try {
		const parsed = new URL(rawUrl);
		variants.add(parsed.toString());
		if (parsed.search) {
			const withoutSearch = new URL(parsed);
			withoutSearch.search = "";
			variants.add(withoutSearch.toString());
		}
	} catch {
		// rawUrl already covers invalid legacy values; schema validation prevents new ones.
	}
	let out = message;
	for (const variant of variants) {
		if (variant.length >= 8) out = out.split(variant).join(safeUrl);
	}
	return out;
}

function maskWebhookUrlForError(rawUrl: string): string {
	try {
		const parsed = new URL(rawUrl);
		return `${parsed.origin}${parsed.pathname ? "/***" : ""}${parsed.search ? "?***" : ""}`;
	} catch {
		return "[webhook URL redacted]";
	}
}

function notificationPayloadToRobotText(payload: NotificationPayload): string {
	switch (payload.kind) {
		case "text":
			return payload.text;
		case "image":
			return payload.caption?.trim() || "[图片]";
		case "composite": {
			const text = payload.segments.map(segmentToRobotText).filter(Boolean).join("\n").trim();
			return text || "[通知]";
		}
		case "image-group": {
			const urls = imageGroupUrls(payload.images).map((img) => img.url);
			return urls.length > 0 ? `图片:\n${urls.join("\n")}` : "[图片]";
		}
		case "miniapp-card":
			return `${payload.title}\n${payload.jumpUrl}`;
	}
}

function segmentToRobotText(segment: PayloadSegment): string {
	switch (segment.kind) {
		case "text":
			return segment.text;
		case "image":
			return "[图片]";
		case "link":
			return segment.title ? `${segment.title} ${segment.href}` : segment.href;
		case "at-all":
			return "@全体成员";
	}
}

/**
 * 通用 JSON 里的一段。线上的判别键叫 `type`(内部叫 `kind`),逐种写出来 —— 不许把内部对象原样交出去,
 * 内部再改名线上也不动(`webhook-wire.test.ts` 钉着)。
 */
function serializeSegment(segment: PayloadSegment): unknown {
	switch (segment.kind) {
		case "text":
			return { type: "text", text: segment.text };
		case "image":
			return { type: "image", mime: segment.mime, data: segment.buffer.toString("base64") };
		case "link":
			return { type: "link", href: segment.href, title: segment.title };
		case "at-all":
			return { type: "at-all" };
	}
}

/** 通用 JSON 的 `payload`。字段名是线上的名字:图集叫 `forward-images`、开关叫 `forward`,不随内部改。 */
function serializePayload(payload: NotificationPayload): unknown {
	switch (payload.kind) {
		case "text":
			return { kind: "text", text: payload.text };
		case "image":
			return {
				kind: "image",
				image: {
					mime: payload.image.mime,
					data: payload.image.buffer.toString("base64"),
				},
				caption: payload.caption,
			};
		case "composite":
			return { kind: "composite", segments: payload.segments.map(serializeSegment) };
		case "image-group":
			return {
				kind: "forward-images",
				images: imageGroupUrls(payload.images),
				forward: payload.mergeForward,
			};
		case "miniapp-card":
			return payload;
	}
}
