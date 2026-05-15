import {
	DynamicEngine,
	type DynamicEngineConfig,
	type PushKind,
	type PushLike,
	type PushSegment,
	type SubscriptionsView,
} from "@bilibili-notify/dynamic";
import type {
	EffectiveSubscription,
	GlobalDefaults,
	Subscription,
	SubscriptionOp,
} from "@bilibili-notify/internal";
import { BILIBILI_NOTIFY_TOKEN, resolve } from "@bilibili-notify/internal";

function hasDynamicGate(eff: EffectiveSubscription): boolean {
	// features.dynamic = source-side 订阅开关。routing 由推送层 BilibiliPush 在
	// broadcast 时按 routing 空 = 无 sink 兜底,这里不 AND routing——features=true /
	// routing.dynamic=[] 的 UP 仍纳入 cron,加 routing 后下个轮询周期立即生效。
	return eff.features.dynamic;
}

import { makeKoishiMessageBus, makeKoishiServiceContext } from "@bilibili-notify/koishi-runtime";
import type { BilibiliPush } from "@bilibili-notify/push";
import { type Awaitable, type Context, h, Service } from "koishi";
import type {} from "koishi-plugin-bilibili-notify";
import { dynamicCommands } from "./commands";
import type { BilibiliNotifyDynamicConfig } from "./config";

declare module "koishi" {
	interface Context {
		"bilibili-notify-dynamic": BilibiliNotifyDynamic;
	}
	interface Events {
		"bilibili-notify/subscription-changed"(ops: SubscriptionOp[]): void;
		"bilibili-notify/engine-error"(source: string, message: string): void;
		"bilibili-notify/auth-lost"(): void;
		"bilibili-notify/auth-restored"(): void;
	}
}

const SERVICE_NAME = "bilibili-notify-dynamic";

/**
 * Adapt the new BilibiliPush (platform-neutral) to the PushLike interface
 * that DynamicEngine expects. The engine sends PushSegment[] + PushKind;
 * this adapter translates to NotificationPayload and delegates to
 * push.broadcastToFeature.
 */
function adaptPush(push: BilibiliPush): PushLike {
	const segmentToKoishi = (seg: PushSegment) => {
		switch (seg.type) {
			case "text":
				return h.text(seg.text);
			case "image":
				return h.image(seg.buffer, seg.mime);
			case "image-group":
				return h(
					"message",
					{ forward: seg.forward },
					seg.urls.map((url) => h.img(url)),
				);
		}
	};

	return {
		async broadcastDynamic(uid, segments, kind: PushKind) {
			// Both "dynamic" and "dynamic-images" map to the "dynamic" feature key.
			void kind;
			const koishiSegments = segments.map(segmentToKoishi);
			const isOnlyImageGroup = segments.length === 1 && segments[0].type === "image-group";
			// Build a composite payload from koishi h() elements
			const _koishiContent = isOnlyImageGroup ? koishiSegments[0] : h("message", koishiSegments);
			// Wrap in NotificationPayload text (h() elements serialize to strings via toString)
			// For koishi, we leverage that the KoishiSink's payloadToKoishi converts "text" payloads
			// using h.text() — but for composite rich content we need a workaround.
			// Strategy: pass the koishi h() element as a "text" payload; the KoishiSink calls
			// h.text(payload.text) which would lose formatting. Instead, pass as composite with
			// the koishi element embedded as a text segment — but the sink only understands
			// the defined PayloadSegment types.
			//
			// The cleanest approach: use sendBatch directly with a composite payload
			// containing the text representation, and also handle image segments.
			// For rich koishi content, we need to bypass the generic sink and call
			// push.broadcastToFeature, but the sink still needs to handle the koishi
			// h() elements. Since KoishiSink uses payloadToKoishi which maps kinds,
			// we need to pick the right kind.
			//
			// Resolution: build a NotificationPayload from segments.
			let payload: import("@bilibili-notify/internal").NotificationPayload;
			if (segments.length === 1 && segments[0].type === "text") {
				payload = { kind: "text", text: segments[0].text };
			} else if (segments.length === 1 && segments[0].type === "image") {
				payload = {
					kind: "image",
					image: { buffer: segments[0].buffer, mime: segments[0].mime },
				};
			} else if (segments.length === 1 && segments[0].type === "image-group") {
				// image-group: format as text with URLs (fallback)
				payload = {
					kind: "text",
					text: segments[0].urls.join("\n"),
				};
			} else {
				// composite: map all segments
				type PS = import("@bilibili-notify/internal").PayloadSegment;
				const mapped: PS[] = [];
				for (const seg of segments) {
					if (seg.type === "text") {
						mapped.push({ type: "text" as const, text: seg.text });
					} else if (seg.type === "image") {
						mapped.push({ type: "image" as const, buffer: seg.buffer, mime: seg.mime });
					} else {
						// image-group → individual links
						for (const url of seg.urls) {
							mapped.push({ type: "link" as const, href: url });
						}
					}
				}
				payload = { kind: "composite", segments: mapped };
			}
			await push.broadcastToFeature(uid, "dynamic", payload);
		},
		sendPrivateMsg(content) {
			return push.sendPrivateMsg(content);
		},
		sendErrorMsg(reason) {
			return push.sendErrorMsg(reason);
		},
	};
}

/** Build a SubscriptionsView from the store for the engine's getSubs callback. */
// biome-ignore lint/suspicious/noExplicitAny: store type from InternalsShape
function storeToSubscriptionsView(store: any, defaults: GlobalDefaults): SubscriptionsView {
	const view: SubscriptionsView = {};
	for (const sub of store.list() as Subscription[]) {
		if (!sub.enabled) continue;
		const eff = resolve(sub, defaults);
		view[sub.uid] = {
			uid: sub.uid,
			uname: sub.cachedProfile?.name ?? sub.uid,
			dynamic: hasDynamicGate(eff),
			customCardStyle: sub.overrides.cardStyle
				? {
						enable: true,
						cardColorStart: sub.overrides.cardStyle.cardColorStart,
						cardColorEnd: sub.overrides.cardStyle.cardColorEnd,
					}
				: { enable: false },
		};
	}
	return view;
}

export class BilibiliNotifyDynamic extends Service<BilibiliNotifyDynamicConfig> {
	static readonly [Service.provide] = SERVICE_NAME;
	static readonly inject = ["bilibili-notify"];

	private engine?: DynamicEngine;

	constructor(ctx: Context, config: BilibiliNotifyDynamicConfig) {
		super(ctx, SERVICE_NAME);
		this.config = config;
	}

	private toEngineConfig(config: BilibiliNotifyDynamicConfig): DynamicEngineConfig {
		return {
			dynamicUrl: config.dynamicUrl,
			dynamicCron: config.dynamicCron,
			dynamicVideoUrlToBV: config.dynamicVideoUrlToBV,
			pushImgsInDynamic: config.pushImgsInDynamic,
			filter: config.filter,
		};
	}

	protected start(): Awaitable<void> {
		const internals = this.ctx["bilibili-notify"].getInternals(BILIBILI_NOTIFY_TOKEN);
		if (!internals) throw new Error("无法获取 bilibili-notify 内部实例，请确认核心插件已启动");

		const serviceCtx = makeKoishiServiceContext(this.ctx, SERVICE_NAME, this.config.logLevel);
		const bus = makeKoishiMessageBus(this.ctx);
		const pushLike = adaptPush(internals.push);

		this.engine = new DynamicEngine({
			serviceCtx,
			bus,
			api: internals.api,
			push: pushLike,
			image: this.ctx.get("bilibili-notify-image")?.engine,
			ai: this.ctx.get("bilibili-notify-ai")?.engine,
			config: this.toEngineConfig(this.config),
			getSubs: () => {
				const fresh = this.ctx["bilibili-notify"].getInternals(BILIBILI_NOTIFY_TOKEN);
				if (!fresh) return null;
				return storeToSubscriptionsView(fresh.store, fresh.defaults);
			},
		});

		this.engine.start();

		// koishi 端订阅事件 → engine.applyOps
		this.ctx.on("bilibili-notify/subscription-changed", (ops: SubscriptionOp[]) => {
			const defaults = internals.defaults;
			// Translate new SubscriptionOp[] to the SubscriptionOpView format DynamicEngine expects
			const opViews = ops.map((op) => {
				if (op.type === "add") {
					const eff = resolve(op.sub, defaults);
					return {
						type: "add" as const,
						sub: {
							uid: op.sub.uid,
							uname: op.sub.cachedProfile?.name ?? op.sub.uid,
							dynamic: hasDynamicGate(eff),
							customCardStyle: op.sub.overrides.cardStyle
								? {
										enable: true,
										...op.sub.overrides.cardStyle,
									}
								: { enable: false },
						},
					};
				}
				if (op.type === "remove") {
					return { type: "delete" as const, uid: op.uid };
				}
				// update
				const eff = resolve(op.sub, defaults);
				return {
					type: "update" as const,
					uid: op.sub.uid,
					changes: [{ scope: "dynamic", dynamic: hasDynamicGate(eff) }],
				};
			});
			this.engine?.applyOps(opViews);
		});

		dynamicCommands.call(this);
	}

	protected stop(): Awaitable<void> {
		this.engine?.stop();
		this.engine = undefined;
	}

	get isActive(): boolean {
		return this.engine?.isActive ?? false;
	}
}
