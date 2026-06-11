import type {
	NotificationPayload,
	PayloadSegment,
	SubscriptionOp,
} from "@bilibili-notify/internal";
import {
	makeKoishiServiceContext,
	resolveBilibiliNotifyCoreInternals,
	tryResolveBilibiliNotifyCoreInternals,
} from "@bilibili-notify/koishi-runtime";
import {
	type LiveContentBuilder,
	LiveEngine,
	type LiveEngineConfig,
	type LiveSubscriptionOp,
	type PushLike,
} from "@bilibili-notify/live";
import type { BilibiliPush } from "@bilibili-notify/push";
import { type Awaitable, type Context, type Element, h, Service } from "koishi";
import type {} from "koishi-plugin-bilibili-notify";
import { liveCommands } from "./commands";
import type { BilibiliNotifyLiveConfig } from "./config";
import { liveTypeAllowsAtAll, liveTypeToFeature } from "./live-type-map";
import { resolveFeatures, storeToLiveView, storeToSubItemView } from "./sub-view";

declare module "koishi" {
	interface Context {
		"bilibili-notify-live": BilibiliNotifyLive;
	}
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

export class BilibiliNotifyLive extends Service<BilibiliNotifyLiveConfig> {
	static readonly [Service.provide] = SERVICE_NAME;
	static readonly inject = ["bilibili-notify"];

	private engine?: LiveEngine;

	constructor(ctx: Context, config: BilibiliNotifyLiveConfig) {
		super(ctx, SERVICE_NAME);
		this.config = config;
	}

	private toEngineConfig(config: BilibiliNotifyLiveConfig): LiveEngineConfig {
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
		};
	}

	protected start(): Awaitable<void> {
		const core = this.ctx.get("bilibili-notify");
		if (!core) {
			throw new Error(
				`${SERVICE_NAME} 无法获取 bilibili-notify 核心服务：请确认 koishi-plugin-bilibili-notify 已安装、启用并先于本插件启动。`,
			);
		}
		const internals = resolveBilibiliNotifyCoreInternals(SERVICE_NAME, core);

		const serviceCtx = makeKoishiServiceContext(this.ctx, SERVICE_NAME, this.config.logLevel);
		const pushLike = adaptPush(internals.push);
		const { store } = internals;
		// koishi 不做运行时配置热更 —— 配置变更走插件 reload(重跑 start)。所以
		// 这里把 config 一次性捕获,resolve「config + per-UP」即两层折叠。
		const config = this.config;

		// imageRenderer / commentary 不在 constructor 一次性塞 —— 由下方 ctx.inject
		// 在依赖服务 ready 时通过 setImageRenderer / setCommentary 后置注入,避免
		// koishi-plugin-bilibili-notify-ai / -image 晚于 -live 启动时 engine 内
		// 引用永远空,推送 silent skip(类级 inject 只列必需的 "bilibili-notify",
		// ai / image 是 optional 不等待)。
		this.engine = new LiveEngine({
			serviceCtx,
			api: internals.api,
			push: pushLike,
			contentBuilder: koishiContentBuilder,
			imageRenderer: null,
			commentary: null,
			config: this.toEngineConfig(config),
			emitEngineError: (message) =>
				this.ctx.emit("bilibili-notify/engine-error", SERVICE_NAME, message),
			emitLiveState: (uid, status) =>
				this.ctx.emit("bilibili-notify/live-state-changed", uid, status),
			emitViewers: (uid, viewers) =>
				this.ctx.emit("bilibili-notify/live-viewers-changed", uid, viewers),
		});

		// 后置注入:ctx.inject 在 ai / image 服务 ready 时跑 callback、脱离时 dispose
		// fork、再次 ready 时再次执行;fork 跟随 this.ctx 销毁(service stop 时整体
		// 回收),无需手动 dispose。
		this.ctx.inject(["bilibili-notify-ai"], (subCtx) => {
			this.engine?.setCommentary(subCtx.get("bilibili-notify-ai")?.engine ?? null);
			subCtx.on("dispose", () => this.engine?.setCommentary(null));
		});
		this.ctx.inject(["bilibili-notify-image"], (subCtx) => {
			this.engine?.setImageRenderer(subCtx.get("bilibili-notify-image")?.engine ?? null);
			subCtx.on("dispose", () => this.engine?.setImageRenderer(null));
		});

		// Initialize with current subs
		const initialView = storeToLiveView(store, config);
		if (Object.keys(initialView).length > 0) {
			this.engine.start(initialView);
		}

		// Subscription changes → engine.applyOps
		this.ctx.on("bilibili-notify/subscription-changed", (ops: SubscriptionOp[]) => {
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
				const fresh = tryResolveBilibiliNotifyCoreInternals(
					SERVICE_NAME,
					this.ctx.get("bilibili-notify"),
					(msg) =>
						this.ctx.logger(SERVICE_NAME).debug(`[internals] 运行期获取核心实例失败：${msg}`),
				);
				if (!fresh) return undefined;
				const sub = fresh.store.findByUid(uid);
				if (!sub) return undefined;
				return storeToSubItemView(sub, config);
			});
		});

		// auth-lost → engine.teardown; auth-restored → engine.rebuildFromSubs
		this.ctx.on("bilibili-notify/auth-lost", () => this.engine?.teardown());
		this.ctx.on("bilibili-notify/auth-restored", () => {
			const fresh = tryResolveBilibiliNotifyCoreInternals(
				SERVICE_NAME,
				this.ctx.get("bilibili-notify"),
				(msg) => this.ctx.logger(SERVICE_NAME).debug(`[internals] 运行期获取核心实例失败：${msg}`),
			);
			if (fresh) this.engine?.rebuildFromSubs(storeToLiveView(fresh.store, config));
		});

		liveCommands.call(this);
	}

	protected stop(): Awaitable<void> {
		this.engine?.stop();
		this.engine = undefined;
	}
}
