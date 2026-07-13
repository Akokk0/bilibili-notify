import {
	type AIScene,
	CommentaryGenerator,
	type CommentaryGeneratorConfig,
	type SessionContext,
	type SubManagement,
	type Subscriptions,
} from "@bilibili-notify/ai";
import type { BilibiliAPI } from "@bilibili-notify/api";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import type { Context } from "koishi";
import type { AIConfig } from "../config/ai";
import type { TargetRegistry } from "../push/target-registry";
import { makeKoishiServiceContext } from "../runtime/service-context";
import { buildSubManagement } from "./sub-mgmt";

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
		enableThinking: config.enableThinking ?? false,
		enableSearch: config.enableSearch ?? false,
		enableVision: config.enableVision ?? false,
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
		const subMgmt: SubManagement = buildSubManagement({
			store: deps.store,
			registry: deps.registry,
		});
		this.engine.setSubManagement({
			getSubs: () => storeToAiSubs(deps.store),
			subMgmt,
		});
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

	chat(
		content: string,
		sessionId: string,
		imageUrls?: string[],
		sessionCtx?: SessionContext,
	): Promise<{ result: string; pendingActions: Array<() => Promise<void>> }> {
		return this.engine.chat(content, sessionId, imageUrls, sessionCtx);
	}

	clearSession(sessionId: string): void {
		this.engine.clearSession(sessionId);
	}

	flushPendingSubActions(pendingActions: Array<() => Promise<void>>): Promise<void> {
		return this.engine.flushPendingSubActions(pendingActions);
	}

	get sessionCount(): number {
		return this.engine.sessionCount;
	}
}
