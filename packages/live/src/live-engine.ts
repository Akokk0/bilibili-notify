import type { CommentaryGenerator } from "@bilibili-notify/ai";
import type { BilibiliAPI } from "@bilibili-notify/api";
import type { ImageRenderer } from "@bilibili-notify/image";
import type { Logger, ServiceContext } from "@bilibili-notify/internal";
import type { LiveContentBuilder } from "./content-builder";
import { DanmakuCollector } from "./danmaku-collector";
import { ListenerManager, type ListenerManagerConfig } from "./listener-manager";
import { LiveSummaryRequester } from "./live-summary-requester";
import type { LiveSubscriptionOp, PushLike, SubItemView, SubscriptionsView } from "./push-like";
import definedStopWords from "./stop-words";
import { LiveTemplateRenderer } from "./template-renderer";
import { WordcloudGenerator } from "./wordcloud-generator";

/**
 * Top-level platform-neutral configuration for {@link LiveEngine}.
 *
 * Mirrors the runtime-relevant subset of `BilibiliNotifyLiveConfig` (the koishi
 * Schema). Adapters translate their native config into this struct.
 *
 * The engine intentionally drops `logLevel` (the adapter sets it on the
 * provided logger before construction) and folds `liveSummary` (originally a
 * `string[]` joined by `\n`) into a single `liveSummaryDefault` string per the
 * plan's §七 "customLiveSummary string vs string[]" cleanup.
 */
export interface LiveEngineConfig {
	/**
	 * Comma-separated additional stop-words appended to the bundled
	 * Chinese-stop-word list before tokenisation.
	 */
	wordcloudStopWords?: string;
	/** Hours between periodic "正在直播" pushes; `0` disables. */
	pushTime: number;
	/** Whether to push a "正在直播" card immediately on engine start when a sub is live. */
	restartPush: boolean;
	/** SC minimum-price gate (yuan); SC under this value is dropped. */
	minScPrice: number;
	/**
	 * Lowest allowed guard tier to push (1 = governor, 2 = supervisor,
	 * 3 = captain — preserves Bilibili semantics).
	 */
	minGuardLevel: 1 | 2 | 3;
	/** Default global "弹幕总结" template (single string; adapter joins lines if needed). */
	liveSummaryDefault: string;
	customGuardBuy: ListenerManagerConfig["customGuardBuy"];
	customLiveMsg: ListenerManagerConfig["customLiveMsg"];
	/**
	 * 是否启用图片卡片渲染。`false` 时直播开播 / SC / 上舰 / 弹幕词云全部走文字回退。
	 * 缺省视为 true。Adapter 通常用 `globals.defaults.cardStyle.enabled` 填充。
	 */
	imageEnabled?: boolean;
	/**
	 * 是否启用 AI 直播总结。`false` 时跳过 commentary 调用,直接走模板回退。
	 * 缺省视为 true。Adapter 通常用 `globals.defaults.ai.enabled` 填充。
	 */
	aiEnabled?: boolean;
}

export interface LiveEngineOptions {
	serviceCtx: ServiceContext;
	api: BilibiliAPI;
	push: PushLike;
	contentBuilder: LiveContentBuilder;
	/** Optional — if absent, image-based pushes are skipped / fall back to text. */
	imageRenderer?: ImageRenderer | null;
	/** Optional — if absent, live summaries fall back to the configured template. */
	commentary?: CommentaryGenerator | null;
	config: LiveEngineConfig;
	/**
	 * Called by the engine to surface a `plugin-error` to the host. Adapters
	 * forward this to their MessageBus / koishi `ctx.emit('bilibili-notify/plugin-error')`.
	 */
	emitPluginError: (message: string) => void;
}

/**
 * Platform-neutral live-monitoring engine. Wires the five helpers
 * (listener-manager / danmaku-collector / wordcloud-generator /
 * template-renderer / live-summary-requester) together and exposes the public
 * surface previously offered by the koishi `BilibiliNotifyLive` service.
 *
 * Lifecycle:
 *
 * - {@link start}: register subscription set, open listeners for those that need them.
 * - {@link applyOps}: incremental subscription delta (add / delete / update);
 *   adapter forwards `bilibili-notify/subscription-changed` events here.
 * - {@link rebuildFromSubs}: full rebootstrap (used after `auth-restored`).
 * - {@link teardown}: tear down all listeners + records (used on `auth-lost`).
 * - {@link stop}: dispose; called by the adapter on plugin disposal.
 */
export class LiveEngine {
	private readonly logger: Logger;
	private readonly listener: ListenerManager;
	private readonly danmakuCollector: DanmakuCollector;
	private config: LiveEngineConfig;

	constructor(opts: LiveEngineOptions) {
		this.logger = opts.serviceCtx.logger;
		this.config = opts.config;

		const stopwords = mergeStopWords(opts.config.wordcloudStopWords);
		this.danmakuCollector = new DanmakuCollector(stopwords);
		const templateRenderer = new LiveTemplateRenderer();
		const wordcloudGenerator = new WordcloudGenerator({
			imageRenderer: opts.imageRenderer ?? null,
			isImageEnabled: () => this.config.imageEnabled !== false,
			logger: this.logger,
		});
		const liveSummaryRequester = new LiveSummaryRequester({
			commentary: opts.commentary ?? null,
			isAiEnabled: () => this.config.aiEnabled !== false,
			templateRenderer,
			logger: this.logger,
		});

		this.listener = new ListenerManager({
			serviceCtx: opts.serviceCtx,
			api: opts.api,
			push: opts.push,
			contentBuilder: opts.contentBuilder,
			templateRenderer,
			wordcloudGenerator,
			liveSummaryRequester,
			danmakuCollector: this.danmakuCollector,
			imageRenderer: opts.imageRenderer ?? null,
			config: toListenerConfig(opts.config),
			emitPluginError: opts.emitPluginError,
		});
	}

	/**
	 * Bootstrap the engine with the initial subscription set. Idempotent —
	 * calling it again replaces the active set (used by `auth-restored`).
	 */
	start(subs: SubscriptionsView): void {
		this.logger.debug("[start] 直播引擎启动，正在初始化直播监听...");
		this.listener.startAll(subs);
	}

	/** Tear down all listeners + per-room state, leaving the engine instance reusable. */
	teardown(): void {
		this.logger.info("[live] 关闭所有直播间监听");
		this.listener.clearPushTimers();
		this.listener.clearListeners();
		// keep danmakuCollector data drained so a fresh start has no stale buffers.
		this.danmakuCollector.clearAll();
	}

	/** Full rebootstrap. Used after auth-restored. */
	rebuildFromSubs(subs: SubscriptionsView): void {
		this.logger.info("[live] 重建直播间监听");
		this.listener.startAll(subs);
	}

	/**
	 * Apply incremental subscription ops (the adapter receives these as a
	 * `bilibili-notify/subscription-changed` event payload). Handles the same
	 * three cases as the original live-service: add / delete / update.
	 */
	applyOps(
		ops: LiveSubscriptionOp[],
		lookupFullSub: (uid: string) => SubItemView | undefined,
	): void {
		for (const op of ops) {
			switch (op.type) {
				case "add": {
					if (!this.listener.needsLiveMonitor(op.sub)) break;
					this.listener.startForUid(op.sub);
					break;
				}
				case "delete": {
					this.listener.stopForUid(op.uid);
					break;
				}
				case "update": {
					const liveChanges = op.changes.filter((c) => c.scope === "live");
					const targetChanges = op.changes.filter((c) => c.scope === "target");
					if (liveChanges.length === 0 && targetChanges.length === 0) break;

					const existing = this.listener.getActiveSub(op.uid);
					if (existing) {
						for (const change of liveChanges) {
							const { scope: _scope, ...fields } = change;
							Object.assign(existing, fields);
						}
						for (const change of targetChanges) {
							existing.target = change.target;
						}
						if (!this.listener.needsLiveMonitor(existing)) {
							this.listener.stopForUid(op.uid);
						}
					} else {
						const fullSub = lookupFullSub(op.uid);
						if (fullSub && this.listener.needsLiveMonitor(fullSub)) {
							this.listener.startForUid(fullSub);
						}
					}
					break;
				}
			}
		}
	}

	/** Replace runtime config (called when the adapter receives a config-changed event). */
	updateConfig(config: LiveEngineConfig): void {
		this.config = config;
		this.danmakuCollector.setStopwords(mergeStopWords(config.wordcloudStopWords));
		this.listener.updateConfig(toListenerConfig(config));
	}

	/** Final dispose; the engine instance must not be reused after this. */
	stop(): void {
		this.listener.disposeAll();
	}

	/** Diagnostic accessor, used by the koishi shell for `[conn] state` logging. */
	get listenerCount(): number {
		return this.listener.getListenerCount();
	}

	/** Read-only view of the engine config (for the koishi shell to pass through). */
	getConfig(): LiveEngineConfig {
		return this.config;
	}
}

function toListenerConfig(c: LiveEngineConfig): ListenerManagerConfig {
	return {
		pushTime: c.pushTime,
		restartPush: c.restartPush,
		minScPrice: c.minScPrice,
		minGuardLevel: c.minGuardLevel,
		customGuardBuy: c.customGuardBuy,
		customLiveMsg: c.customLiveMsg,
		liveSummaryDefault: c.liveSummaryDefault,
		imageEnabled: c.imageEnabled,
	};
}

/** Combine the bundled stop-words with the user's comma-separated additions. */
function mergeStopWords(extra?: string): Set<string> {
	if (!extra || extra.trim() === "") return new Set(definedStopWords);
	const additions = extra
		.split(",")
		.map((w) => w.trim())
		.filter((w) => w !== "");
	return new Set([...definedStopWords, ...additions]);
}
