import { DynamicEngine, type DynamicEngineConfig } from "@bilibili-notify/dynamic";
import type { SubscriptionOp } from "@bilibili-notify/internal";
import { defaultMessageKindLayout } from "@bilibili-notify/internal";
import {
	makeKoishiMessageBus,
	makeKoishiServiceContext,
	resolveBilibiliNotifyCoreInternals,
	tryResolveBilibiliNotifyCoreInternals,
} from "@bilibili-notify/koishi-runtime";
import { type Awaitable, type Context, Service } from "koishi";
import type {} from "koishi-plugin-bilibili-notify";
import { dynamicCommands } from "./commands";
import type { BilibiliNotifyDynamicConfig } from "./config";
import { adaptPush } from "./push-adapter";
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
			// koishi 端无版式编辑 UI:恒用默认消息版式(卡片+文本+链接合并一条),
			// 仅由 dynamicUrl 开关决定链接部件显隐。链接不再内嵌模板 {url}。
			messageLayout: defaultMessageKindLayout("dynamic", { link: config.dynamicUrl }),
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
