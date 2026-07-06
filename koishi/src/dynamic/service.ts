import type { CommentaryGenerator } from "@bilibili-notify/ai";
import type { BilibiliAPI } from "@bilibili-notify/api";
import { DynamicEngine, type DynamicEngineConfig } from "@bilibili-notify/dynamic";
import type { ImageRenderer } from "@bilibili-notify/image";
import type { SubscriptionOp } from "@bilibili-notify/internal";
import { defaultMessageKindLayout } from "@bilibili-notify/internal";
import type { BilibiliPush } from "@bilibili-notify/push";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import type { Context } from "koishi";
import type { DynamicConfig } from "../config/dynamic";
import { makeKoishiMessageBus, makeKoishiServiceContext } from "../runtime/service-context";
import { adaptPush } from "./push-adapter";
import { resolveDynamicFeature, storeToDynamicView, subToDynamicView } from "./sub-view";

declare module "koishi" {
	interface Events {
		"bilibili-notify/subscription-changed"(ops: SubscriptionOp[]): void;
		"bilibili-notify/engine-error"(source: string, message: string): void;
		"bilibili-notify/auth-lost"(): void;
		"bilibili-notify/auth-restored"(): void;
	}
}

const SERVICE_NAME = "bilibili-notify-dynamic";

export interface BilibiliNotifyDynamicDeps {
	api: BilibiliAPI;
	push: BilibiliPush;
	store: SubscriptionStore;
	image?: ImageRenderer;
	ai?: CommentaryGenerator;
}

/**
 * 动态推送引擎。普通类(非 koishi Service)——由 runtime/engines.ts 在 bringUp() 内
 * 直接构造/析构,依赖(api/push/store/image?/ai?)通过 start() 参数一次性传入。
 * render/ai 在同一轮 bringUp() 里先于 dynamic 构造完成,故直接持有引用即可,不再需要
 * ctx.inject 的后置晚注入(见切片9)。
 */
export class BilibiliNotifyDynamic {
	private readonly ctx: Context;
	private readonly config: DynamicConfig;
	private engine?: DynamicEngine;
	private releaseSubChanged?: () => void;

	constructor(ctx: Context, config: DynamicConfig) {
		this.ctx = ctx;
		this.config = config;
	}

	private toEngineConfig(config: DynamicConfig): DynamicEngineConfig {
		return {
			dynamicCron: config.dynamicCron,
			dynamicVideoUrlToBV: config.dynamicVideoUrlToBV,
			imageGroup: config.imageGroup,
			filter: config.filter,
			// 全局动态/视频模板由 koishi/dynamic 配置暴露(Schema 带 DEFAULT_TEMPLATES 默认值);
			// per-UP 自定义经 advanced-subscription → overrides.templates.dynamic 折进视图覆盖。
			dynamicTemplate: config.dynamicTemplate,
			videoTemplate: config.videoTemplate,
			// koishi 端无版式编辑 UI:恒用默认消息版式(卡片+文本+链接合并一条),
			// 仅由 dynamicUrl 开关决定链接部件显隐。链接不再内嵌模板 {url}。
			messageLayout: defaultMessageKindLayout("dynamic", { link: config.dynamicUrl }),
		};
	}

	start(deps: BilibiliNotifyDynamicDeps): void {
		const serviceCtx = makeKoishiServiceContext(this.ctx, SERVICE_NAME, this.config.logLevel);
		const bus = makeKoishiMessageBus(this.ctx);
		const pushLike = adaptPush(deps.push);

		this.engine = new DynamicEngine({
			serviceCtx,
			bus,
			api: deps.api,
			push: pushLike,
			image: deps.image,
			ai: deps.ai,
			config: this.toEngineConfig(this.config),
			getSubs: () => storeToDynamicView(deps.store),
		});

		this.engine.start();

		// koishi 端订阅事件 → engine.applyOps
		this.releaseSubChanged = this.ctx.on(
			"bilibili-notify/subscription-changed",
			(ops: SubscriptionOp[]) => {
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
			},
		);
	}

	stop(): void {
		this.releaseSubChanged?.();
		this.releaseSubChanged = undefined;
		this.engine?.stop();
		this.engine = undefined;
	}

	get isActive(): boolean {
		return this.engine?.isActive ?? false;
	}
}
