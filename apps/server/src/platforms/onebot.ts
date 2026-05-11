import type {
	DeliveryResult,
	Logger,
	NotificationPayload,
	OnebotAdapterConfig,
	OnebotSession,
	PayloadSegment,
	PushAdapter,
	PushTarget,
} from "@bilibili-notify/internal";
import type { PlatformAdapter } from "./types.js";

/**
 * OneBot v11 HTTP adapter.
 *
 * Translates {@link NotificationPayload} into the OneBot message-segment array
 * format and posts to either `/send_group_msg` or `/send_private_msg` depending
 * on the target's `scope` (and the `private` flag for master-error reports).
 *
 * Compatible with NapCat (primary test target) and any other v11-compliant
 * implementation that accepts the standard payload + base64 image segment.
 *
 * Token auth: `accessToken` from the adapter config is appended via
 * `Authorization: Bearer <token>` (NapCat default). The adapter is the unit
 * of HTTP connection; multiple PushTargets can share one adapter to push to
 * different groups/users without duplicating endpoint config.
 */
export interface OnebotPlatformAdapterOptions {
	logger: Logger;
	/** Per-request timeout (ms). Defaults to 15s. */
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

interface OneBotMessageSegment {
	type: "text" | "image" | "at";
	data: Record<string, string>;
}

interface OneBotResponse {
	status: "ok" | "failed";
	retcode: number;
	message?: string;
	wording?: string;
	data?: unknown;
}

export function createOnebotAdapter(opts: OnebotPlatformAdapterOptions): PlatformAdapter {
	const log = opts.logger;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	function buildSegments(payload: NotificationPayload): OneBotMessageSegment[] {
		switch (payload.kind) {
			case "text":
				return [{ type: "text", data: { text: payload.text } }];
			case "image": {
				const out: OneBotMessageSegment[] = [
					{
						type: "image",
						data: { file: bufferToBase64Uri(payload.image.buffer, payload.image.mime) },
					},
				];
				if (payload.caption) out.push({ type: "text", data: { text: payload.caption } });
				return out;
			}
			case "composite":
				return payload.segments.map(segmentToOnebot);
		}
	}

	function segmentToOnebot(seg: PayloadSegment): OneBotMessageSegment {
		switch (seg.type) {
			case "text":
				return { type: "text", data: { text: seg.text } };
			case "image":
				return {
					type: "image",
					data: { file: bufferToBase64Uri(seg.buffer, seg.mime) },
				};
			case "link":
				return { type: "text", data: { text: seg.title ? `${seg.title} ${seg.href}` : seg.href } };
		}
	}

	async function postOnebot(
		baseUrl: string,
		accessToken: string | undefined,
		endpoint: string,
		body: Record<string, unknown>,
	): Promise<OneBotResponse> {
		const url = `${trimTrailingSlash(baseUrl)}${endpoint}`;
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (accessToken) headers.authorization = `Bearer ${accessToken}`;

		const ctrl = new AbortController();
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

	return {
		platforms: ["onebot"],

		isAvailable(adapter: PushAdapter, target: PushTarget): boolean {
			if (adapter.platform !== "onebot" || target.platform !== "onebot") return false;
			if (!adapter.enabled || !target.enabled) return false;
			const cfg = adapter.config as OnebotAdapterConfig;
			return typeof cfg.baseUrl === "string" && cfg.baseUrl.length > 0;
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
			const session = target.session as OnebotSession;
			const t0 = Date.now();
			try {
				const segments = buildSegments(payload);
				if (segments.length === 0) {
					return { ok: false, latencyMs: 0, err: "empty payload" };
				}

				const isPrivate = opts.private ?? target.scope === "private";
				const endpoint = isPrivate ? "/send_private_msg" : "/send_group_msg";
				const body: Record<string, unknown> = { message: segments };
				if (isPrivate) {
					if (!session.userId) return { ok: false, latencyMs: 0, err: "private: userId missing" };
					body.user_id = Number(session.userId);
				} else {
					if (!session.groupId) return { ok: false, latencyMs: 0, err: "group: groupId missing" };
					body.group_id = Number(session.groupId);
				}

				const result = await postOnebot(cfg.baseUrl, cfg.accessToken, endpoint, body);
				const latencyMs = Date.now() - t0;
				if (result.status !== "ok" || result.retcode !== 0) {
					const err = result.wording ?? result.message ?? `retcode=${result.retcode}`;
					log.warn(`[onebot] target=${target.id} send failed: ${err}`);
					return { ok: false, latencyMs, err };
				}
				return { ok: true, latencyMs };
			} catch (e) {
				const latencyMs = Date.now() - t0;
				const err = e instanceof Error ? e.message : String(e);
				log.warn(`[onebot] target=${target.id} send threw: ${err}`);
				return { ok: false, latencyMs, err };
			}
		},
	};
}

function bufferToBase64Uri(buffer: Buffer, _mime: string): string {
	// OneBot v11's image segment accepts the `base64://` URL form. NapCat,
	// go-cqhttp, and Lagrange all support it; mime is implicit (image type
	// inferred by the runtime).
	return `base64://${buffer.toString("base64")}`;
}

function trimTrailingSlash(s: string): string {
	return s.endsWith("/") ? s.slice(0, -1) : s;
}
