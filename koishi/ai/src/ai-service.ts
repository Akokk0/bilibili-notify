import {
	type AIScene,
	CommentaryGenerator,
	type CommentaryGeneratorConfig,
	type SessionContext,
	type SubManagement,
	type Subscriptions,
} from "@bilibili-notify/ai";
import type { BilibiliAPI } from "@bilibili-notify/api";
import { BILIBILI_NOTIFY_TOKEN } from "@bilibili-notify/internal";
import { makeKoishiServiceContext } from "@bilibili-notify/koishi-runtime";
import { type Awaitable, type Context, Service } from "koishi";
import type {} from "koishi-plugin-bilibili-notify";
import { aiCommands } from "./commands";
import type { BilibiliNotifyAIConfig } from "./config";
import { buildSubManagement } from "./sub-mgmt";

export {
	buildSubManagement,
	type SubMgmtRegistryLike,
	type SubMgmtStoreLike,
} from "./sub-mgmt";

declare module "koishi" {
	interface Context {
		"bilibili-notify-ai": BilibiliNotifyAI;
	}
}

const SERVICE_NAME = "bilibili-notify-ai";

export type { AIScene };

function toEngineConfig(config: BilibiliNotifyAIConfig): CommentaryGeneratorConfig {
	return {
		apiKey: config.apiKey,
		baseURL: config.baseURL,
		model: config.model,
		persona: config.persona,
		dynamicPrompt: config.dynamicPrompt,
		liveSummaryPrompt: config.liveSummaryPrompt,
		enableConversation: config.enableConversation,
		maxHistory: config.maxHistory,
		enableThinking: config.enableThinking,
		enableSearch: config.enableSearch,
		enableVision: config.enableVision,
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

export class BilibiliNotifyAI extends Service<BilibiliNotifyAIConfig> {
	static readonly [Service.provide] = SERVICE_NAME;
	static readonly inject = ["bilibili-notify"];

	readonly engine: CommentaryGenerator;

	constructor(ctx: Context, config: BilibiliNotifyAIConfig) {
		super(ctx, SERVICE_NAME);
		this.config = config;
		const serviceCtx = makeKoishiServiceContext(ctx, SERVICE_NAME, config.logLevel);
		// Lazy api proxy: resolved in start()
		const apiHolder: { api: BilibiliAPI | null } = { api: null };
		const apiProxy = new Proxy({} as BilibiliAPI, {
			get(_, prop) {
				if (!apiHolder.api) {
					throw new Error("BilibiliAPI 尚未就绪，请确认 bilibili-notify 核心插件已启动");
				}
				const value = (apiHolder.api as unknown as Record<PropertyKey, unknown>)[prop];
				if (typeof value === "function") {
					return (value as (...args: unknown[]) => unknown).bind(apiHolder.api);
				}
				return value;
			},
		});
		this.engine = new CommentaryGenerator({
			serviceCtx,
			api: apiProxy,
			config: toEngineConfig(config),
		});
		(this as unknown as { _apiHolder: typeof apiHolder })._apiHolder = apiHolder;
	}

	protected start(): Awaitable<void> {
		const internals = this.ctx["bilibili-notify"].getInternals(BILIBILI_NOTIFY_TOKEN);
		if (!internals) throw new Error("无法获取 bilibili-notify 内部实例，请确认核心插件已启动");
		const holder = (this as unknown as { _apiHolder: { api: BilibiliAPI | null } })._apiHolder;
		holder.api = internals.api;

		const { store, registry } = internals;

		// Build SubManagement wrapping store for AI CRUD tools.
		// Resolves default targetIds from the registry (Fix 7).
		const subMgmt: SubManagement = buildSubManagement({ store, registry });

		this.engine.setSubManagement({
			getSubs: () => {
				const fresh = this.ctx["bilibili-notify"].getInternals(BILIBILI_NOTIFY_TOKEN);
				if (!fresh) return null;
				return storeToAiSubs(fresh.store);
			},
			subMgmt,
		});
		this.engine.start();
		// P2:指令注册移到 start()。在 constructor 注册 → koishi 插件重载时
		// constructor 重跑会重复注册同名指令。start/stop 成对,生命周期正确。
		aiCommands.call(this);
	}

	protected stop(): Awaitable<void> {
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
