import type { BilibiliAPI } from "@bilibili-notify/api";
import type { ImageRenderer } from "@bilibili-notify/image";
import type { Logger, ServiceContext } from "@bilibili-notify/internal";
import type { LiveContentBuilder } from "./content-builder";
import { DanmakuCollector } from "./danmaku-collector";
import { ListenerManager, type ListenerManagerConfig } from "./listener-manager";
import type { CommentaryClient } from "./live-summary-requester";
import { LiveSummaryRequester } from "./live-summary-requester";
import type { LiveSubscriptionOp, PushLike, SubItemView, SubscriptionsView } from "./push-like";
import definedStopWords, { parseStopWords } from "./stop-words";
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
	/**
	 * 引擎级全局 `pushTime`(小时;`0` 关闭)。仅用于 `updateConfig` 检测全局
	 * pushTime 变更后重排所有定时器;每个 UP 的实际复推间隔在
	 * `SubItemView.pushTime` 上(adapter 已折算 `per-UP ?? 全局`)。
	 */
	pushTime: number;
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
	commentary?: CommentaryClient | null;
	config: LiveEngineConfig;
	/**
	 * Called by the engine to surface an `engine-error` to the host. Adapters
	 * forward this to their MessageBus / koishi `ctx.emit('bilibili-notify/engine-error')`.
	 */
	emitEngineError: (message: string) => void;
	/**
	 * Optional — adapter pipe for per-UID live-state transitions. Adapter forwards
	 * to `bus.emit("live-state-changed", uid, status)`. When absent the engine
	 * runs without state broadcasts (koishi shell may opt out if it has nothing
	 * subscribing).
	 */
	emitLiveState?: (uid: string, status: "live" | "idle") => void;
	/**
	 * Optional — adapter pipe for per-UID watched-count updates. Adapter forwards
	 * to `bus.emit("live-viewers-changed", uid, viewers)`. Throttled per-UID to
	 * 2s at the room-session boundary.
	 */
	emitViewers?: (uid: string, viewers: string) => void;
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
	private readonly liveSummaryRequester: LiveSummaryRequester;
	private config: LiveEngineConfig;
	/**
	 * Image 渲染器的当前引用 —— 单一可变 state,setImageRenderer 在此更新;
	 * 所有子组件(wordcloud / listener / room-context)通过 provider 函数现取,
	 * 无需逐组件 setter 推送。
	 */
	private currentImageRenderer: ImageRenderer | null;

	constructor(opts: LiveEngineOptions) {
		this.logger = opts.serviceCtx.logger;
		this.config = opts.config;
		this.currentImageRenderer = opts.imageRenderer ?? null;

		const getImageRenderer = (): ImageRenderer | null => this.currentImageRenderer;

		const stopwords = mergeStopWords(opts.config.wordcloudStopWords);
		this.danmakuCollector = new DanmakuCollector(stopwords);
		const templateRenderer = new LiveTemplateRenderer();
		const wordcloudGenerator = new WordcloudGenerator({
			getImageRenderer,
			isImageEnabled: () => this.config.imageEnabled !== false,
			logger: this.logger,
		});
		this.liveSummaryRequester = new LiveSummaryRequester({
			commentary: opts.commentary ?? null,
			isAiEnabled: () => this.config.aiEnabled !== false,
			templateRenderer,
			logger: this.logger,
		});
		const liveSummaryRequester = this.liveSummaryRequester;

		this.listener = new ListenerManager({
			serviceCtx: opts.serviceCtx,
			api: opts.api,
			push: opts.push,
			contentBuilder: opts.contentBuilder,
			templateRenderer,
			wordcloudGenerator,
			liveSummaryRequester,
			danmakuCollector: this.danmakuCollector,
			getImageRenderer,
			config: toListenerConfig(opts.config),
			emitEngineError: opts.emitEngineError,
			emitLiveState: opts.emitLiveState,
			emitViewers: opts.emitViewers,
		});
	}

	/**
	 * Bootstrap the engine with the initial subscription set. Idempotent —
	 * calling it again replaces the active set (used by `auth-restored`).
	 */
	start(subs: SubscriptionsView): void {
		this.logger.info("[start] 直播引擎启动，正在初始化直播监听...");
		this.listener.startAll(subs);
	}

	/** Tear down all listeners + per-room state, leaving the engine instance reusable. */
	teardown(): void {
		this.logger.info("[live] 关闭所有直播间监听");
		this.listener.disposeAll();
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
						// pushTime 是 setInterval 句柄,ms 参数 immutable,需要 dispose+rearm。
						// 先记下旧值,assign 完成后比对决定是否走 rearm 分支。
						const prevPushTime = existing.pushTime;
						let nextPushTime = prevPushTime;
						for (const change of liveChanges) {
							const { scope: _scope, ...fields } = change;
							if (fields.pushTime !== undefined) nextPushTime = fields.pushTime;
							Object.assign(existing, fields);
						}
						for (const change of targetChanges) {
							existing.target = change.target;
						}
						if (!this.listener.needsLiveMonitor(existing)) {
							this.listener.stopForUid(op.uid);
						} else if (nextPushTime !== prevPushTime) {
							this.listener.rearmPeriodicTimerForUid(op.uid);
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
		const pushTimeChanged = this.config.pushTime !== config.pushTime;
		this.config = config;
		this.danmakuCollector.setStopwords(mergeStopWords(config.wordcloudStopWords));
		this.listener.updateConfig(toListenerConfig(config));
		// pushTime 变化需要 dispose+rearm 已 arm 的 setInterval(node API ms 参数 immutable)。
		if (pushTimeChanged) {
			this.logger.info(`[live] pushTime 已更新为 ${config.pushTime}h,重排所有定时器`);
			this.listener.rearmAllPeriodicTimers();
		}
	}

	/**
	 * 热替换 CommentaryClient 实例。adapter 在用户运行时打开 / 关闭 / 更换 AI
	 * 配置后调用,引擎随后的直播总结会立即用新实例 (或回退到模板) ,无需重启 server。
	 */
	setCommentary(commentary: CommentaryClient | null): void {
		this.liveSummaryRequester.setCommentary(commentary);
	}

	/**
	 * 热替换 ImageRenderer 实例。adapter 在 image 服务上下线时调用。子组件 (词云 /
	 * room-context / 卡片渲染) 都通过共享 provider 现取,这里只需更新单一 state。
	 *
	 * 主要给 koishi adapter 用 —— sibling service (-image) 启停时通过 ctx.inject
	 * 后置注入。独立端 imageRenderer 是 engine 同进程一次性 wire,不会动态消失,
	 * 不需要调用本方法 (cardStyle 热更走 imageRenderer.updateConfig)。
	 */
	setImageRenderer(imageRenderer: ImageRenderer | null): void {
		this.currentImageRenderer = imageRenderer;
	}

	/** Final dispose; the engine instance must not be reused after this. */
	stop(): void {
		this.listener.disposeAll();
	}

	/** Diagnostic accessor, used by the koishi shell for `[conn] state` logging. */
	get listenerCount(): number {
		return this.listener.getListenerCount();
	}

	/**
	 * Per-room live-state snapshot for every active monitor. Routes / dashboards
	 * filter on `isLive` to show "正在直播" panels.
	 */
	listLiveSnapshots(): ReturnType<ListenerManager["listLiveSnapshots"]> {
		return this.listener.listLiveSnapshots();
	}

	/** Read-only view of the engine config (for the koishi shell to pass through). */
	getConfig(): LiveEngineConfig {
		return this.config;
	}
}

function toListenerConfig(c: LiveEngineConfig): ListenerManagerConfig {
	return {
		customGuardBuy: c.customGuardBuy,
		customLiveMsg: c.customLiveMsg,
		liveSummaryDefault: c.liveSummaryDefault,
		imageEnabled: c.imageEnabled,
	};
}

/** Combine the bundled stop-words with the user's comma-separated additions. */
function mergeStopWords(extra?: string): Set<string> {
	return new Set([...definedStopWords, ...parseStopWords(extra)]);
}
