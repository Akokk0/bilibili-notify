import {
	DynamicEngine,
	type DynamicEngineConfig,
	type PushKind,
	type PushLike,
} from "@bilibili-notify/dynamic";
import type { SubscriptionOp } from "@bilibili-notify/internal";
import { BILIBILI_NOTIFY_TOKEN } from "@bilibili-notify/internal";
import { makeKoishiMessageBus, makeKoishiServiceContext } from "@bilibili-notify/koishi-runtime";
import type { BilibiliPush } from "@bilibili-notify/push";
import { type Awaitable, type Context, Service } from "koishi";
import type {} from "koishi-plugin-bilibili-notify";
import { dynamicCommands } from "./commands";
import type { BilibiliNotifyDynamicConfig } from "./config";
import { resolveDynamicFeature, storeToDynamicView, subToDynamicView } from "./sub-view";

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
	return {
		async broadcastDynamic(uid, segments, kind: PushKind) {
			// Both "dynamic" and "dynamic-images" map to the "dynamic" feature key.
			void kind;
			let payload: import("@bilibili-notify/internal").NotificationPayload;
			if (segments.length === 1 && segments[0].type === "text") {
				payload = { kind: "text", text: segments[0].text };
			} else if (segments.length === 1 && segments[0].type === "image") {
				payload = {
					kind: "image",
					image: { buffer: segments[0].buffer, mime: segments[0].mime },
				};
			} else if (segments.length === 1 && segments[0].type === "image-group") {
				// 走 NotificationSink 的 forward-images 路径 —— sink 内部按 payload.forward
				// 决定走 koishi 合并转发(h("message", {forward:true}, nodes))还是普通
				// 多图(h("message", urls.map(h.image)))。forward 由 dynamic engine config
				// imageGroup.forward 控制(可 per-UP override sub.overrides.imageGroup.forward)。
				payload = {
					kind: "forward-images",
					urls: segments[0].urls,
					forward: segments[0].forward,
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
			imageGroup: config.imageGroup,
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
				return storeToDynamicView(fresh.store);
			},
		});

		this.engine.start();

		// koishi 端订阅事件 → engine.applyOps
		this.ctx.on("bilibili-notify/subscription-changed", (ops: SubscriptionOp[]) => {
			// Translate new SubscriptionOp[] to the SubscriptionOpView format DynamicEngine expects
			const opViews = ops.map((op) => {
				if (op.type === "add") {
					return { type: "add" as const, sub: subToDynamicView(op.sub) };
				}
				if (op.type === "remove") {
					return { type: "delete" as const, uid: op.uid };
				}
				// update —— 仅推 features.dynamic 一字段(per-UP override ?? 静态默认)
				return {
					type: "update" as const,
					uid: op.sub.uid,
					changes: [{ scope: "dynamic" as const, dynamic: resolveDynamicFeature(op.sub) }],
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
