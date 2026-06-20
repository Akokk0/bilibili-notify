import { createHmac } from "node:crypto";
import type {
	DeliveryResult,
	Logger,
	NotificationPayload,
	PayloadSegment,
	PushAdapter,
	PushTarget,
	WebhookAdapterConfig,
} from "@bilibili-notify/internal";
import type { PlatformAdapter, ProbeResult } from "./types.js";

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

type WebhookProvider = "generic" | "dingtalk" | "feishu" | "wecom";
type WebhookAdapterConfigWithProvider = WebhookAdapterConfig & { provider?: WebhookProvider };

interface WebhookHttpRequest {
	url: string;
	headers: Record<string, string>;
	body: string;
}

export function createWebhookAdapter(opts: WebhookAdapterOptions): PlatformAdapter {
	const log = opts.logger;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	return {
		platforms: ["webhook"],
		isAvailable(adapter: PushAdapter, target: PushTarget): boolean {
			if (adapter.platform !== "webhook" || target.platform !== "webhook") return false;
			if (!adapter.enabled || !target.enabled) return false;
			const cfg = adapter.config as WebhookAdapterConfigWithProvider;
			return typeof cfg.url === "string" && cfg.url.length > 0;
		},
		async probe(_adapter: PushAdapter): Promise<ProbeResult> {
			// Webhook has no standard side-effect-free ping verb — most endpoints
			// reject everything except the exact POST shape they expect. Returning
			// ok:null tells the UI to render "probe unsupported" and prompt the
			// user to verify with a real send-test.
			return { ok: null, latencyMs: 0, err: "webhook does not support connection probe" };
		},
		async send(
			adapter: PushAdapter,
			target: PushTarget,
			payload: NotificationPayload,
			pushOpts: { private?: boolean } = {},
		): Promise<DeliveryResult> {
			if (adapter.platform !== "webhook" || target.platform !== "webhook") {
				return {
					ok: false,
					latencyMs: 0,
					err: `wrong platform: adapter=${adapter.platform} target=${target.platform}`,
				};
			}
			const cfg = adapter.config as WebhookAdapterConfigWithProvider;
			const provider = webhookProviderOf(cfg);
			const t0 = Date.now();
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), timeoutMs);
			try {
				const req = buildWebhookRequest(provider, cfg, target, payload, pushOpts);
				const res = await fetch(req.url, {
					method: "POST",
					headers: req.headers,
					body: req.body,
					signal: ctrl.signal,
				});
				const latencyMs = Date.now() - t0;
				if (!res.ok) {
					return {
						ok: false,
						latencyMs,
						err: sanitizeWebhookError(`HTTP ${res.status} ${res.statusText}`, cfg),
					};
				}
				const businessErr =
					provider === "generic" ? null : parseBusinessResponse(provider, await res.text());
				if (businessErr)
					return { ok: false, latencyMs, err: sanitizeWebhookError(businessErr, cfg) };
				return { ok: true, latencyMs };
			} catch (e) {
				const latencyMs = Date.now() - t0;
				const err = sanitizeWebhookError(e instanceof Error ? e.message : String(e), cfg);
				log.warn(`[webhook] target=${target.id} send failed: ${err}`);
				return { ok: false, latencyMs, err };
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

function webhookProviderOf(cfg: WebhookAdapterConfigWithProvider): WebhookProvider {
	return cfg.provider ?? "generic";
}

function buildWebhookRequest(
	provider: WebhookProvider,
	cfg: WebhookAdapterConfigWithProvider,
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

function baseHeaders(cfg: WebhookAdapterConfigWithProvider): Record<string, string> {
	return {
		"content-type": "application/json",
		...cfg.headers,
	};
}

function buildGenericWebhookRequest(
	cfg: WebhookAdapterConfigWithProvider,
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
	cfg: WebhookAdapterConfigWithProvider,
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
	cfg: WebhookAdapterConfigWithProvider,
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
	cfg: WebhookAdapterConfigWithProvider,
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

function parseBusinessResponse(
	provider: Exclude<WebhookProvider, "generic">,
	text: string,
): string | null {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return `${providerLabel(provider)} response is not JSON`;
	}
	if (!isRecord(body)) return `${providerLabel(provider)} response is not an object`;
	switch (provider) {
		case "dingtalk":
			return parseDingTalkBusinessResult(body);
		case "feishu":
			return parseFeishuBusinessResult(body);
		case "wecom":
			return parseWeComBusinessResult(body);
	}
}

function parseDingTalkBusinessResult(body: Record<string, unknown>): string | null {
	const errcode = body.errcode;
	if (isZeroCode(errcode)) return null;
	const errmsg = stringValue(body.errmsg);
	const code = codeLabel(errcode);
	if (code) return `DingTalk errcode=${code}${errmsg ? ` errmsg=${errmsg}` : ""}`;
	return `DingTalk response missing errcode${errmsg ? ` errmsg=${errmsg}` : ""}`;
}

function parseFeishuBusinessResult(body: Record<string, unknown>): string | null {
	const code = firstPresent(body.code, body.StatusCode, body.status_code);
	if (isZeroCode(code)) return null;
	const msg = firstString(body.msg, body.message, body.StatusMessage, body.errmsg);
	const label = codeLabel(code);
	if (label) return `Feishu code=${label}${msg ? ` msg=${msg}` : ""}`;
	return `Feishu response missing code${msg ? ` msg=${msg}` : ""}`;
}

function parseWeComBusinessResult(body: Record<string, unknown>): string | null {
	const errcode = body.errcode;
	if (isZeroCode(errcode)) return null;
	const errmsg = stringValue(body.errmsg);
	const code = codeLabel(errcode);
	if (code) return `WeCom errcode=${code}${errmsg ? ` errmsg=${errmsg}` : ""}`;
	return `WeCom response missing errcode${errmsg ? ` errmsg=${errmsg}` : ""}`;
}

function isZeroCode(value: unknown): boolean {
	return value === 0 || value === "0";
}

function codeLabel(value: unknown): string | null {
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "string" && value.length > 0) return value;
	return null;
}

function providerLabel(provider: Exclude<WebhookProvider, "generic">): string {
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

function sanitizeWebhookError(message: string, cfg: WebhookAdapterConfigWithProvider): string {
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
		case "forward-images":
			return payload.images.length > 0
				? `图片:\n${payload.images.map((img) => img.url).join("\n")}`
				: "[图片]";
	}
}

function segmentToRobotText(segment: PayloadSegment): string {
	switch (segment.type) {
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
			return {
				kind: "composite",
				segments: payload.segments.map((s) =>
					s.type === "image"
						? { type: "image", mime: s.mime, data: s.buffer.toString("base64") }
						: s,
				),
			};
		case "forward-images":
			return { kind: "forward-images", images: payload.images, forward: payload.forward };
	}
}
