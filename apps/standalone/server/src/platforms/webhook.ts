import type {
	DeliveryResult,
	Logger,
	NotificationPayload,
	PushTarget,
	WebhookConfig,
} from "@bilibili-notify/internal";
import type { PlatformAdapter } from "./types.js";

/**
 * Webhook adapter — POST the payload as JSON to an arbitrary HTTP endpoint.
 *
 * Image buffers are serialized as base64 strings under `payload.image.data`
 * to keep the JSON envelope self-contained. The receiver is expected to
 * understand this shape (NotificationPayload + base64 conversion).
 */
export interface WebhookAdapterOptions {
	logger: Logger;
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export function createWebhookAdapter(opts: WebhookAdapterOptions): PlatformAdapter {
	const log = opts.logger;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	return {
		platforms: ["webhook"],
		isAvailable(target: PushTarget): boolean {
			if (target.platform !== "webhook") return false;
			if (!target.enabled) return false;
			const cfg = target.config as WebhookConfig;
			return typeof cfg.url === "string" && cfg.url.length > 0;
		},
		async send(
			target: PushTarget,
			payload: NotificationPayload,
			pushOpts: { private?: boolean } = {},
		): Promise<DeliveryResult> {
			if (target.platform !== "webhook") {
				return { ok: false, latencyMs: 0, err: `wrong platform: ${target.platform}` };
			}
			const cfg = target.config as WebhookConfig;
			const t0 = Date.now();
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), timeoutMs);
			try {
				const headers: Record<string, string> = {
					"content-type": "application/json",
					...cfg.headers,
				};
				if (cfg.secret) headers["x-bilibili-notify-secret"] = cfg.secret;
				const body = JSON.stringify({
					targetId: target.id,
					targetName: target.name,
					scope: target.scope,
					private: !!pushOpts.private,
					payload: serializePayload(payload),
					ts: new Date().toISOString(),
				});
				const res = await fetch(cfg.url, {
					method: "POST",
					headers,
					body,
					signal: ctrl.signal,
				});
				const latencyMs = Date.now() - t0;
				if (!res.ok) {
					return {
						ok: false,
						latencyMs,
						err: `HTTP ${res.status} ${res.statusText}`,
					};
				}
				return { ok: true, latencyMs };
			} catch (e) {
				const latencyMs = Date.now() - t0;
				const err = e instanceof Error ? e.message : String(e);
				log.warn(`[webhook] target=${target.id} send failed: ${err}`);
				return { ok: false, latencyMs, err };
			} finally {
				clearTimeout(timer);
			}
		},
	};
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
	}
}
