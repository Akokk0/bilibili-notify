import {
	type AIScene,
	CommentaryGenerator,
	type CommentaryGeneratorConfig,
	type Subscriptions,
} from "@bilibili-notify/ai";
import type { BilibiliAPI } from "@bilibili-notify/api";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import type { Context } from "koishi";
import type { AIConfig } from "../config/ai";
import type { TargetRegistry } from "../push/target-registry";
import { makeKoishiServiceContext } from "../runtime/service-context";

const SERVICE_NAME = "bilibili-notify-ai";

export interface BilibiliNotifyAIDeps {
	api: BilibiliAPI;
	store: SubscriptionStore;
	registry: TargetRegistry;
}

export type { AIScene };

/**
 * 只在 `config.ai.enabled === true` 时才会构造(见 index.ts 的注册门控),这时
 * Schema.union 的 enabled 分支已经把以下字段全部校验并填好默认值,断言安全。
 */
function toEngineConfig(config: AIConfig): CommentaryGeneratorConfig {
	return {
		apiKey: config.apiKey ?? "",
		baseURL: config.baseURL ?? "",
		model: config.model ?? "",
		persona: config.persona as CommentaryGeneratorConfig["persona"],
		dynamicPrompt: config.dynamicPrompt ?? "",
		liveSummaryPrompt: config.liveSummaryPrompt ?? "",
		enableConversation: config.enableConversation ?? true,
		maxHistory: config.maxHistory ?? 10,
		// 服务商只认主人**明确选过**的那一个。不按 baseURL 猜 —— 猜错就是替主人
		// 往别家发方言参数(几乎必然 400),而落兜底档最坏只是思考开关不生效。
		provider: config.provider ?? "custom",
		enableThinking: config.enableThinking ?? false,
		thinkingLevel: config.thinkingLevel ?? "medium",
		extraParams: config.extraParams,
		enableVision: config.enableVision ?? false,
		vision: {
			baseURL: config.visionBaseURL,
			apiKey: config.visionApiKey,
			model: config.visionModel,
		},
	};
}

/** Convert a SubscriptionStore to the Subscriptions map the AI tools expect. */
// biome-ignore lint/suspicious/noExplicitAny: store type from InternalsShape
function storeToAiSubs(store: any): Subscriptions {
	const subs: Subscriptions = {};
	for (const sub of store.list()) {
		subs[sub.uid] = {
			uid: sub.uid,
			uname: sub.uid,
			dynamic: (sub.routing.dynamic?.length ?? 0) > 0,
			live: (sub.routing.live?.length ?? 0) > 0,
		};
	}
	return subs;
}

/**
 * AI 评论/对话引擎。普通类(非 koishi Service)——由 runtime/engines.ts 在 bringUp()
 * 内直接构造/析构,api/store/registry 通过构造函数一次性传入(与 core 运行时同生命
 * 周期,不再需要跨 Service 边界的探针协议或运行期"fresh"重取,见切片9)。
 */
export class BilibiliNotifyAI {
	readonly engine: CommentaryGenerator;

	constructor(ctx: Context, config: AIConfig, deps: BilibiliNotifyAIDeps) {
		const serviceCtx = makeKoishiServiceContext(ctx, SERVICE_NAME, config.logLevel ?? 1);
		this.engine = new CommentaryGenerator({
			serviceCtx,
			api: deps.api,
			config: toEngineConfig(config),
		});
		// 只接**查询**。写订阅的工具已整体下架 —— `bili.chat` 没有权限门,而它的
		// 上下文里塞满了群友消息、B 站动态正文这类外部可控内容,写能力配上这样的
		// 输入面等于任意一条群消息都可能改掉主人的订阅表。而且那个能力本来就撑不过
		// 下一次插件重载(订阅每次都从配置 replaceAll 重建,没有回写通道)。
		this.engine.setSubscriptionsSource(() => storeToAiSubs(deps.store));
	}

	start(): void {
		this.engine.start();
	}

	stop(): void {
		this.engine.stop();
	}

	// ── proxy to engine ────────────────────────────────────────────────

	getSystemPrompt(scene?: AIScene, summary?: string): string {
		return this.engine.getSystemPrompt(scene, summary);
	}

	comment(content: string, scene?: AIScene, imageUrls?: string[]): Promise<string> {
		return this.engine.comment(content, scene, imageUrls);
	}

	chat(content: string, sessionId: string, imageUrls?: string[]): Promise<string> {
		return this.engine.chat(content, sessionId, imageUrls);
	}

	clearSession(sessionId: string): void {
		this.engine.clearSession(sessionId);
	}

	get sessionCount(): number {
		return this.engine.sessionCount;
	}
}
