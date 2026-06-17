import {
	DynamicEngine,
	type DynamicEngineConfig,
	type PushKind,
	type PushLike,
} from "@bilibili-notify/dynamic";
import type { SubscriptionOp } from "@bilibili-notify/internal";
import {
	makeKoishiMessageBus,
	makeKoishiServiceContext,
	resolveBilibiliNotifyCoreInternals,
	tryResolveBilibiliNotifyCoreInternals,
} from "@bilibili-notify/koishi-runtime";
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
					images: segments[0].images,
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
						for (const img of seg.images) {
							mapped.push({ type: "link" as const, href: img.url });
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
			dynamicCron: config.dynamicCron,
			dynamicVideoUrlToBV: config.dynamicVideoUrlToBV,
			imageGroup: config.imageGroup,
			filter: config.filter,
			// 全局动态/视频模板由 koishi/dynamic 配置暴露(Schema 带 DEFAULT_TEMPLATES 默认值);
			// per-UP 自定义经 advanced-subscription → overrides.templates.dynamic 折进视图覆盖。
			dynamicTemplate: config.dynamicTemplate,
			videoTemplate: config.videoTemplate,
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
		const bus = makeKoishiMessageBus(this.ctx);
		const pushLike = adaptPush(internals.push);

		// image / ai 不在 constructor 传入 —— 由下方 ctx.inject 在依赖服务 ready 时
		// 后置注入。Service 类级 inject 仅含 "bilibili-notify",bilibili-notify-ai /
		// -image 是 optional,启动时不等待。若在 constructor 一次性赋值,ai 服务比
		// dynamic 晚 ready 的情况下 engine.ai 永远 undefined,推送时 silent skip。
		this.engine = new DynamicEngine({
			serviceCtx,
			bus,
			api: internals.api,
			push: pushLike,
			image: undefined,
			ai: undefined,
			config: this.toEngineConfig(this.config),
			getSubs: () => {
				const fresh = tryResolveBilibiliNotifyCoreInternals(
					SERVICE_NAME,
					this.ctx.get("bilibili-notify"),
					(msg) =>
						this.ctx.logger(SERVICE_NAME).debug(`[internals] 运行期获取核心实例失败：${msg}`),
				);
				if (!fresh) return null;
				return storeToDynamicView(fresh.store);
			},
		});

		this.engine.start();

		// 后置注入:ctx.inject 在 deps ready 时跑 callback、deps 任一脱离时 dispose
		// fork,deps 再次都齐时再次跑 callback。fork 跟随 this.ctx 销毁(service stop
		// 时整体回收),无需手动 dispose。
		this.ctx.inject(["bilibili-notify-ai"], (subCtx) => {
			this.engine?.setAi(subCtx.get("bilibili-notify-ai")?.engine);
			subCtx.on("dispose", () => this.engine?.setAi(undefined));
		});
		this.ctx.inject(["bilibili-notify-image"], (subCtx) => {
			this.engine?.setImage(subCtx.get("bilibili-notify-image")?.engine);
			subCtx.on("dispose", () => this.engine?.setImage(undefined));
		});

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
