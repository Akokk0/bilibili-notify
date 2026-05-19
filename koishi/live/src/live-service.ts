import type { CommentaryCallOverride } from "@bilibili-notify/ai";
import type {
	EffectiveSubscription,
	FeatureKey,
	GlobalDefaults,
	NotificationPayload,
	PayloadSegment,
	Subscription,
	SubscriptionOp,
} from "@bilibili-notify/internal";
import { BILIBILI_NOTIFY_TOKEN, resolve } from "@bilibili-notify/internal";
import { liveTypeToFeature } from "./live-type-map";

/**
 * Gate fn: features.X = source-side 订阅开关。routing 由推送层 BilibiliPush 在
 * broadcast 时按 routing 空 = 无 sink 兜底,这里不 AND routing——features=true /
 * routing=[] 的 UP 仍开监听 / build payload,加 routing 后下次事件立即生效。
 * 对齐 standalone `apps/server/src/runtime/engines.ts` 的 `feat(k)` helper。
 */
function gate(eff: EffectiveSubscription, k: FeatureKey): boolean {
	return eff.features[k];
}

/**
 * 把 resolve 后的 eff.ai 翻译成 LiveEngine 调 CommentaryGenerator 时的 per-call
 * override 形态。对齐 standalone `apps/server/src/runtime/engines.ts:buildAiOverride`。
 *
 * 复制一份(而非抽到共享位置)是因为:CommentaryCallOverride 类型在 @bilibili-notify/ai,
 * EffectiveSubscription 在 @bilibili-notify/internal——共享 helper 会让 internal 反过来
 * 依赖 ai,形成循环。
 */
function buildAiOverride(eff: EffectiveSubscription): CommentaryCallOverride {
	return {
		persona: {
			preset: "custom" as const,
			name: eff.ai.persona.name,
			addressUser: eff.ai.persona.addressUser,
			addressSelf: eff.ai.persona.addressSelf,
			traits: eff.ai.persona.traits,
			catchphrase: eff.ai.persona.catchphrase,
			customBase: eff.ai.persona.baseRole,
			extraPrompt: eff.ai.persona.extraSystemPrompt,
		},
		dynamicPrompt: eff.ai.dynamicPrompt,
		liveSummaryPrompt: eff.ai.liveSummaryPrompt,
		temperature: eff.ai.temperature,
	};
}

import { makeKoishiServiceContext } from "@bilibili-notify/koishi-runtime";
import {
	type LiveContentBuilder,
	LiveEngine,
	type LiveEngineConfig,
	type LiveSubscriptionOp,
	type PushLike,
	type SubItemView,
	type SubscriptionsView,
} from "@bilibili-notify/live";
import type { BilibiliPush } from "@bilibili-notify/push";
import { type Awaitable, type Context, type Element, h, Service } from "koishi";
import type {} from "koishi-plugin-bilibili-notify";
import { liveCommands } from "./commands";
import type { BilibiliNotifyLiveConfig } from "./config";

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
			await push.broadcastToFeature(uid, feature, payload);
		},
		sendPrivateMsg(content) {
			return push.sendPrivateMsg(content);
		},
	};
}

/** Build SubscriptionsView from SubscriptionStore for LiveEngine. */
// biome-ignore lint/suspicious/noExplicitAny: store type from InternalsShape
function storeToLiveView(store: any, defaults: GlobalDefaults): SubscriptionsView {
	const view: SubscriptionsView = {};
	for (const sub of store.list() as Subscription[]) {
		if (!sub.enabled) continue;
		const eff = resolve(sub, defaults);

		const liveView: SubItemView = {
			uid: sub.uid,
			uname: sub.uid,
			roomId: "", // live engine resolves roomId via API
			dynamic: gate(eff, "dynamic"),
			live: gate(eff, "live"),
			liveEnd: gate(eff, "liveEnd"),
			liveGuardBuy: gate(eff, "liveGuardBuy"),
			superchat: gate(eff, "superchat"),
			wordcloud: gate(eff, "wordcloud"),
			liveSummary: gate(eff, "liveSummary"),
			target: sub.routing, // routing is structurally compatible as Partial<Record<LivePushFeature, unknown[]>>
			customCardStyle: sub.overrides.cardStyle
				? {
						enable: true,
						cardColorStart: sub.overrides.cardStyle.cardColorStart,
						cardColorEnd: sub.overrides.cardStyle.cardColorEnd,
					}
				: { enable: false },
			customLiveMsg: sub.overrides.templates?.liveStart
				? {
						enable: true,
						customLiveStart: sub.overrides.templates.liveStart,
						customLive: sub.overrides.templates.liveOngoing,
						customLiveEnd: sub.overrides.templates.liveEnd,
					}
				: { enable: false },
			customGuardBuy: sub.overrides.templates?.guardBuy
				? {
						enable: true,
						captainImgUrl: sub.overrides.templates.guardBuy.captain.imageUrl,
						supervisorImgUrl: sub.overrides.templates.guardBuy.commander.imageUrl,
						governorImgUrl: sub.overrides.templates.guardBuy.governor.imageUrl,
					}
				: { enable: false },
			customLiveSummary: sub.overrides.templates?.liveSummary
				? { enable: true, liveSummary: sub.overrides.templates.liveSummary }
				: { enable: false },
			customSpecialDanmakuUsers: (sub.specialUsers as { uid: string; kinds: string[] }[]).some(
				(u) => u.kinds.includes("danmaku"),
			)
				? {
						enable: true,
						specialDanmakuUsers: (sub.specialUsers as { uid: string; kinds: string[] }[])
							.filter((u) => u.kinds.includes("danmaku"))
							.map((u) => u.uid),
						msgTemplate: sub.overrides.templates?.specialDanmaku ?? "",
					}
				: { enable: false, msgTemplate: "" },
			customSpecialUsersEnterTheRoom: (sub.specialUsers as { uid: string; kinds: string[] }[]).some(
				(u) => u.kinds.includes("enter"),
			)
				? {
						enable: true,
						specialUsersEnterTheRoom: (sub.specialUsers as { uid: string; kinds: string[] }[])
							.filter((u) => u.kinds.includes("enter"))
							.map((u) => u.uid),
						msgTemplate: sub.overrides.templates?.specialUserEnter ?? "",
					}
				: { enable: false, msgTemplate: "" },
			// per-UP filters / schedule(对齐 standalone `apps/server/src/runtime/engines.ts`
			// buildLiveSubViewSingle:846-849)。LiveEngine 在 SC / 上舰 / restartPush /
			// 复推 timer 调用点会优先用这些 per-UP 值,缺失时回退到 adapter 全局。
			minScPrice: eff.filters.minScPrice,
			minGuardLevel: eff.filters.minGuardLevel,
			pushTime: eff.schedule.pushTime,
			restartPush: eff.schedule.restartPush,
			aiOverride: buildAiOverride(eff),
		};
		view[sub.uid] = liveView;
	}
	return view;
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

	private toEngineConfig(
		config: BilibiliNotifyLiveConfig,
		defaults: GlobalDefaults,
	): LiveEngineConfig {
		return {
			wordcloudStopWords: config.wordcloudStopWords,
			pushTime: config.pushTime,
			restartPush: config.restartPush,
			minScPrice: config.minScPrice,
			minGuardLevel: config.minGuardLevel,
			liveSummaryDefault: config.liveSummary.join("\n"),
			customGuardBuy: config.customGuardBuy,
			customLiveMsg: config.customLiveMsg,
			// KL1:此前漏映射 → 引擎缺省视 imageEnabled/aiEnabled 为 true,koishi
			// 用户全局关卡片/AI 后开播卡 / 词云 / AI 总结仍生成,与 standalone
			// (engines.ts 用 defaults 填这两字段)行为分歧,违背双端功能等价。
			imageEnabled: defaults.cardStyle.enabled,
			aiEnabled: defaults.ai.enabled,
		};
	}

	protected start(): Awaitable<void> {
		const internals = this.ctx["bilibili-notify"].getInternals(BILIBILI_NOTIFY_TOKEN);
		if (!internals) throw new Error("无法获取 bilibili-notify 内部实例，请确认核心插件已启动");

		const serviceCtx = makeKoishiServiceContext(this.ctx, SERVICE_NAME, this.config.logLevel);
		const pushLike = adaptPush(internals.push);
		const { store } = internals;

		this.engine = new LiveEngine({
			serviceCtx,
			api: internals.api,
			push: pushLike,
			contentBuilder: koishiContentBuilder,
			imageRenderer: this.ctx.get("bilibili-notify-image")?.engine ?? null,
			commentary: this.ctx.get("bilibili-notify-ai")?.engine ?? null,
			config: this.toEngineConfig(this.config, internals.defaults),
			emitEngineError: (message) =>
				this.ctx.emit("bilibili-notify/engine-error", SERVICE_NAME, message),
			emitLiveState: (uid, status) =>
				this.ctx.emit("bilibili-notify/live-state-changed", uid, status),
			emitViewers: (uid, viewers) =>
				this.ctx.emit("bilibili-notify/live-viewers-changed", uid, viewers),
		});

		// Initialize with current subs
		const initialView = storeToLiveView(store, internals.defaults);
		if (Object.keys(initialView).length > 0) {
			this.engine.start(initialView);
		}

		// Subscription changes → engine.applyOps
		this.ctx.on("bilibili-notify/subscription-changed", (ops: SubscriptionOp[]) => {
			const defaults = internals.defaults;
			const liveOps: LiveSubscriptionOp[] = ops.map((op) => {
				if (op.type === "add") {
					return { type: "add" as const, sub: storeToSubItemView(op.sub, defaults) };
				}
				if (op.type === "remove") {
					return { type: "delete" as const, uid: op.uid };
				}
				// update
				const eff = resolve(op.sub, defaults);
				return {
					type: "update" as const,
					uid: op.sub.uid,
					changes: [
						{
							scope: "live" as const,
							live: gate(eff, "live"),
							liveEnd: gate(eff, "liveEnd"),
							liveGuardBuy: gate(eff, "liveGuardBuy"),
							superchat: gate(eff, "superchat"),
							wordcloud: gate(eff, "wordcloud"),
							liveSummary: gate(eff, "liveSummary"),
						},
					],
				};
			});
			this.engine?.applyOps(liveOps, (uid) => {
				const fresh = this.ctx["bilibili-notify"].getInternals(BILIBILI_NOTIFY_TOKEN);
				if (!fresh) return undefined;
				const sub = fresh.store.findByUid(uid);
				if (!sub) return undefined;
				return storeToSubItemView(sub, fresh.defaults);
			});
		});

		// auth-lost → engine.teardown; auth-restored → engine.rebuildFromSubs
		this.ctx.on("bilibili-notify/auth-lost", () => this.engine?.teardown());
		this.ctx.on("bilibili-notify/auth-restored", () => {
			const fresh = this.ctx["bilibili-notify"].getInternals(BILIBILI_NOTIFY_TOKEN);
			if (fresh) this.engine?.rebuildFromSubs(storeToLiveView(fresh.store, fresh.defaults));
		});

		liveCommands.call(this);
	}

	protected stop(): Awaitable<void> {
		this.engine?.stop();
		this.engine = undefined;
	}
}

/** Convert a single Subscription to SubItemView. */
function storeToSubItemView(sub: Subscription, defaults: GlobalDefaults): SubItemView {
	const eff = resolve(sub, defaults);
	return {
		uid: sub.uid,
		uname: sub.uid,
		roomId: "",
		dynamic: gate(eff, "dynamic"),
		live: gate(eff, "live"),
		liveEnd: gate(eff, "liveEnd"),
		liveGuardBuy: gate(eff, "liveGuardBuy"),
		superchat: gate(eff, "superchat"),
		wordcloud: gate(eff, "wordcloud"),
		liveSummary: gate(eff, "liveSummary"),
		target: sub.routing,
		customCardStyle: sub.overrides.cardStyle
			? {
					enable: true,
					cardColorStart: sub.overrides.cardStyle.cardColorStart,
					cardColorEnd: sub.overrides.cardStyle.cardColorEnd,
				}
			: { enable: false },
		customLiveMsg: sub.overrides.templates?.liveStart
			? {
					enable: true,
					customLiveStart: sub.overrides.templates.liveStart,
					customLive: sub.overrides.templates.liveOngoing,
					customLiveEnd: sub.overrides.templates.liveEnd,
				}
			: { enable: false },
		customGuardBuy: sub.overrides.templates?.guardBuy
			? {
					enable: true,
					captainImgUrl: sub.overrides.templates.guardBuy.captain.imageUrl,
					supervisorImgUrl: sub.overrides.templates.guardBuy.commander.imageUrl,
					governorImgUrl: sub.overrides.templates.guardBuy.governor.imageUrl,
				}
			: { enable: false },
		customLiveSummary: sub.overrides.templates?.liveSummary
			? { enable: true, liveSummary: sub.overrides.templates.liveSummary }
			: { enable: false },
		customSpecialDanmakuUsers: sub.specialUsers.some((u) => u.kinds.includes("danmaku"))
			? {
					enable: true,
					specialDanmakuUsers: sub.specialUsers
						.filter((u) => u.kinds.includes("danmaku"))
						.map((u) => u.uid),
					msgTemplate: sub.overrides.templates?.specialDanmaku ?? "",
				}
			: { enable: false, msgTemplate: "" },
		customSpecialUsersEnterTheRoom: sub.specialUsers.some((u) => u.kinds.includes("enter"))
			? {
					enable: true,
					specialUsersEnterTheRoom: sub.specialUsers
						.filter((u) => u.kinds.includes("enter"))
						.map((u) => u.uid),
					msgTemplate: sub.overrides.templates?.specialUserEnter ?? "",
				}
			: { enable: false, msgTemplate: "" },
		// per-UP filters / schedule(对齐 standalone)
		minScPrice: eff.filters.minScPrice,
		minGuardLevel: eff.filters.minGuardLevel,
		pushTime: eff.schedule.pushTime,
		restartPush: eff.schedule.restartPush,
		aiOverride: buildAiOverride(eff),
	};
}
