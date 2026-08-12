import type { CommentaryGenerator } from "@bilibili-notify/ai";
import type { BilibiliAPI } from "@bilibili-notify/api";
import type { ImageRenderer } from "@bilibili-notify/image";
import type {
	NotificationPayload,
	PayloadSegment,
	SubscriptionOp,
} from "@bilibili-notify/internal";
import { defaultMessageKindLayout } from "@bilibili-notify/internal";
import {
	type LiveContentBuilder,
	LiveEngine,
	type LiveEngineConfig,
	type LiveSubscriptionOp,
	type PushLike,
} from "@bilibili-notify/live";
import type { BilibiliPush } from "@bilibili-notify/push";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import { type Context, type Element, h } from "koishi";
import type { LiveConfig } from "../config/live";
import { makeKoishiServiceContext } from "../runtime/service-context";
import { liveTypeAllowsAtAll, liveTypeToFeature } from "./live-type-map";
import { resolveFeatures, storeToLiveView, storeToSubItemView } from "./sub-view";

declare module "koishi" {
	interface Events {
		"bilibili-notify/subscription-changed"(ops: SubscriptionOp[]): void;
		"bilibili-notify/engine-error"(source: string, message: string): void;
		"bilibili-notify/auth-lost"(): void;
		"bilibili-notify/auth-restored"(): void;
		"bilibili-notify/live-state-changed"(uid: string, status: "live" | "idle"): void;
		"bilibili-notify/live-viewers-changed"(uid: string, viewers: string): void;
	}
}

const SERVICE_NAME = "bilibili-notify-live";

export interface BilibiliNotifyLiveDeps {
	api: BilibiliAPI;
	push: BilibiliPush;
	store: SubscriptionStore;
	image?: ImageRenderer;
	ai?: CommentaryGenerator;
	/** 总结时允不允许联网搜索(AI 子配置的 webSearchLive)。缺省关。 */
	aiWebSearch?: boolean;
}

/**
 * Decode a koishi h.image / h.img element's `attrs.src` into either a Buffer + mime
 * (when stored as a `data:<mime>;base64,<data>` URL — which is what `h.image(buffer, mime)`
 * produces internally) or a plain URL string.
 *
 * Returns `{ kind: "buffer", buffer, mime }` for inlined assets,
 * `{ kind: "url", url }` for remote URLs, or `null` if `src` is missing/unrecognised.
 */
function decodeImageSrc(
	src: string | undefined,
): { kind: "buffer"; buffer: Buffer; mime: string } | { kind: "url"; url: string } | null {
	if (typeof src !== "string" || src.length === 0) return null;
	const dataMatch = /^data:([^;,]+);base64,(.*)$/i.exec(src);
	if (dataMatch) {
		const mime = dataMatch[1] || "image/jpeg";
		try {
			const buffer = Buffer.from(dataMatch[2], "base64");
			return { kind: "buffer", buffer, mime };
		} catch {
			return null;
		}
	}
	return { kind: "url", url: src };
}

/**
 * Flatten a single koishi h() element into one or more PayloadSegments.
 * Recurses through `message` / fragment containers; degrades structures that
 * can't be expressed in PayloadSegment (e.g. `at`) to text segments.
 */
function elementToSegments(el: Element | string | null | undefined): PayloadSegment[] {
	if (el == null) return [];
	if (typeof el === "string") {
		return el.length > 0 ? [{ type: "text", text: el }] : [];
	}
	const type = el.type;
	const attrs = el.attrs ?? {};

	switch (type) {
		case "text": {
			const text = String(attrs.content ?? "");
			return text.length > 0 ? [{ type: "text", text }] : [];
		}
		case "img":
		case "image": {
			const decoded = decodeImageSrc(attrs.src as string | undefined);
			if (!decoded) return [];
			if (decoded.kind === "buffer") {
				return [{ type: "image", buffer: decoded.buffer, mime: decoded.mime }];
			}
			// Remote URL: PayloadSegment image requires Buffer; degrade to a link segment
			// so downstream sinks at least surface the URL.
			return [{ type: "link", href: decoded.url }];
		}
		case "at": {
			const atType = attrs.type as string | undefined;
			const atId = attrs.id as string | undefined;
			const text = atType === "all" ? "@全体成员 " : atId ? `@${atId} ` : "";
			return text.length > 0 ? [{ type: "text", text }] : [];
		}
		case "message":
		case "template": // koishi Element.Fragment
		case undefined:
		case "": {
			// container: flatten children
			return el.children.flatMap((child) => elementToSegments(child));
		}
		default: {
			// Unknown koishi node — fall back to its serialised form so it isn't lost.
			const fallback = el.toString();
			return fallback.length > 0 ? [{ type: "text", text: fallback }] : [];
		}
	}
}

/**
 * Convert an arbitrary koishi h() element / fragment into a NotificationPayload.
 * Single-segment payloads collapse to `kind: "text"` / `kind: "image"`; otherwise
 * a `kind: "composite"` payload is returned.
 */
function koishiElementToPayload(content: unknown): NotificationPayload {
	let segments: PayloadSegment[];
	if (typeof content === "string") {
		segments = content.length > 0 ? [{ type: "text", text: content }] : [];
	} else if (Array.isArray(content)) {
		segments = (content as Element[]).flatMap((el) => elementToSegments(el));
	} else if (content && typeof content === "object" && "type" in content) {
		segments = elementToSegments(content as Element);
	} else {
		segments = [{ type: "text", text: String(content ?? "") }];
	}
	if (segments.length === 0) {
		return { kind: "text", text: "" };
	}
	if (segments.length === 1) {
		const only = segments[0];
		if (only.type === "text") return { kind: "text", text: only.text };
		if (only.type === "image") {
			return { kind: "image", image: { buffer: only.buffer, mime: only.mime } };
		}
		// link: keep as composite so the link segment is preserved
	}
	return { kind: "composite", segments };
}

/**
 * Adapt the new BilibiliPush to the PushLike interface that LiveEngine expects.
 * LiveEngine calls broadcastToTargets(uid, content, LivePushType) where content is
 * a koishi h() element. We translate LivePushType → FeatureKey and content → NotificationPayload.
 */
function adaptPush(push: BilibiliPush): PushLike {
	return {
		async broadcastToTargets(uid, content, type) {
			const feature = liveTypeToFeature(type as number);

			// content is a koishi h() element (or fragment / string). Translate to a
			// platform-neutral NotificationPayload so the sink can re-render image
			// buffers, @-mentions, and composite messages on the destination platform
			// instead of receiving a flattened XML string.
			const payload = koishiElementToPayload(content);
			// 仅开播(StartBroadcasting)可 @全体;周期「正在直播」等也走 feature
			// "live",必须显式抑制,否则每条直播推送都 @全体。
			await push.broadcastToFeature(uid, feature, payload, {
				allowAtAll: liveTypeAllowsAtAll(type as number),
			});
		},
		sendPrivateMsg(content) {
			return push.sendPrivateMsg(content);
		},
	};
}

/** koishi 端 LiveContentBuilder：直接桥接到 koishi 的 h(...) 工厂。 */
const koishiContentBuilder: LiveContentBuilder = {
	text(t) {
		return h.text(t);
	},
	image(source, mime) {
		if (typeof source === "string") return h.image(source);
		return h.image(source, mime ?? "image/jpeg");
	},
	atAll() {
		return h("at", { type: "all" });
	},
	message(segments) {
		return h("message", segments as Parameters<typeof h>[1]);
	},
};

/**
 * 直播推送引擎。普通类(非 koishi Service)——由 runtime/engines.ts 在 bringUp() 内
 * 直接构造/析构,依赖(api/push/store/image?/ai?)通过 start() 参数一次性传入,不再
 * 需要 ctx.inject 后置晚注入或跨 Service 边界的"fresh"重取(见切片9)。
 */
export class BilibiliNotifyLive {
	private readonly ctx: Context;
	private readonly config: LiveConfig;
	private engine?: LiveEngine;
	private releaseSubChanged?: () => void;
	private releaseAuthLost?: () => void;
	private releaseAuthRestored?: () => void;

	constructor(ctx: Context, config: LiveConfig) {
		this.ctx = ctx;
		this.config = config;
	}

	private toEngineConfig(config: LiveConfig): LiveEngineConfig {
		return {
			wordcloudStopWords: config.wordcloudStopWords,
			pushTime: config.pushTime,
			liveSummaryDefault: config.liveSummary.join("\n"),
			customGuardBuy: config.customGuardBuy,
			customLiveMsg: config.customLiveMsg,
			// koishi 端没有独立的「用户开关 imageEnabled/aiEnabled」—— 是否启用完全
			// 由 image / ai 子插件装没装决定,运行时上下线通过下方 ctx.inject 调用
			// setImageRenderer / setCommentary 控制。这里固定 true(= 用户未禁用),
			// 把启停决策权下沉给 ctx.inject。
			imageEnabled: true,
			aiEnabled: true,
			// koishi 端无版式编辑 UI:恒用默认消息版式(卡片+文本+链接合并一条),覆盖
			// 开播/直播中/下播,仅由 liveUrl 开关决定链接部件显隐。链接不再内嵌各自模板 {link}。
			messageLayout: defaultMessageKindLayout("live", { link: config.liveUrl }),
		};
	}

	start(deps: BilibiliNotifyLiveDeps): void {
		const serviceCtx = makeKoishiServiceContext(this.ctx, SERVICE_NAME, this.config.logLevel);
		const pushLike = adaptPush(deps.push);
		const { store } = deps;
		const config = this.config;

		this.engine = new LiveEngine({
			serviceCtx,
			api: deps.api,
			push: pushLike,
			contentBuilder: koishiContentBuilder,
			imageRenderer: deps.image ?? null,
			commentary: deps.ai ?? null,
			// aiWebSearch 来自 AI 子配置而不是本插件的 —— 搜索的 key / 后端都住在
			// 那边,开关跟着钱包走。
			config: { ...this.toEngineConfig(config), aiWebSearch: deps.aiWebSearch ?? false },
			emitEngineError: (message) =>
				this.ctx.emit("bilibili-notify/engine-error", SERVICE_NAME, message),
			emitLiveState: (uid, status) =>
				this.ctx.emit("bilibili-notify/live-state-changed", uid, status),
			emitViewers: (uid, viewers) =>
				this.ctx.emit("bilibili-notify/live-viewers-changed", uid, viewers),
		});

		// Initialize with current subs
		const initialView = storeToLiveView(store, config);
		if (Object.keys(initialView).length > 0) {
			this.engine.start(initialView);
		}

		// Subscription changes → engine.applyOps
		this.releaseSubChanged = this.ctx.on(
			"bilibili-notify/subscription-changed",
			(ops: SubscriptionOp[]) => {
				const liveOps: LiveSubscriptionOp[] = ops.map((op) => {
					if (op.type === "add") {
						return { type: "add" as const, sub: storeToSubItemView(op.sub, config) };
					}
					if (op.type === "remove") {
						return { type: "delete" as const, uid: op.uid };
					}
					// update —— 只增量推 feature 开关(features 静态默认 ?? per-UP)。
					const features = resolveFeatures(op.sub);
					return {
						type: "update" as const,
						uid: op.sub.uid,
						changes: [
							{
								scope: "live" as const,
								live: features.live,
								liveEnd: features.liveEnd,
								liveGuardBuy: features.liveGuardBuy,
								superchat: features.superchat,
								wordcloud: features.wordcloud,
								liveSummary: features.liveSummary,
							},
						],
					};
				});
				this.engine?.applyOps(liveOps, (uid) => {
					const sub = store.findByUid(uid);
					if (!sub) return undefined;
					return storeToSubItemView(sub, config);
				});
			},
		);

		// auth-lost → engine.teardown; auth-restored → engine.rebuildFromSubs
		this.releaseAuthLost = this.ctx.on("bilibili-notify/auth-lost", () => this.engine?.teardown());
		this.releaseAuthRestored = this.ctx.on("bilibili-notify/auth-restored", () => {
			this.engine?.rebuildFromSubs(storeToLiveView(store, config));
		});
	}

	stop(): void {
		this.releaseSubChanged?.();
		this.releaseAuthLost?.();
		this.releaseAuthRestored?.();
		this.releaseSubChanged = undefined;
		this.releaseAuthLost = undefined;
		this.releaseAuthRestored = undefined;
		this.engine?.stop();
		this.engine = undefined;
	}
}
