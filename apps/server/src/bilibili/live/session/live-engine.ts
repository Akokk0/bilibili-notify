import type { CommentaryProvider } from "@bilibili-notify/ai";
import type { ImageRenderer } from "@bilibili-notify/image";
import type { ImageRef, Logger, ServiceContext } from "@bilibili-notify/internal";
import type { LiveContentBuilder } from "../../../live/content-builder";
import type { PickLiveCover } from "../../../live/live-types";
import { LiveSummaryRequester } from "../../../live/recap/live-summary-requester";
import definedStopWords, { parseStopWords } from "../../../live/recap/stop-words";
import { ViewerChatCollector } from "../../../live/recap/viewer-chat-collector";
import { WordcloudGenerator } from "../../../live/recap/wordcloud-generator";
import type { Api } from "../../api/index.js";
import type { ImagesDeps } from "../../images.js";
import type { GuardIcons } from "../guard-icons.js";
import type { LiveSubscriptionOp, PushLike, SubItemView, SubscriptionsView } from "../push-like";
import { LiveTemplateRenderer } from "../template-renderer";
import { ListenerManager, type ListenerManagerConfig } from "./listener-manager";
import type { LiveProblems } from "./room-context";

/**
 * Top-level platform-neutral configuration for {@link LiveEngine}. The host
 * (standalone runtime) fills it from its config store.
 *
 * The engine intentionally drops `logLevel` (the host sets it on the provided
 * logger before construction) and folds `liveSummary` (originally a `string[]`
 * joined by `\n`) into a single `liveSummaryDefault` string.
 */
export interface LiveEngineConfig {
	/**
	 * Comma-separated additional stop-words appended to the bundled
	 * Chinese-stop-word list before tokenisation.
	 */
	wordcloudStopWords?: string;
	/** Default global "弹幕总结" template (single string; adapter joins lines if needed). */
	liveSummaryDefault: string;
	guardTemplate: ListenerManagerConfig["guardTemplate"];
	customLiveMsg: ListenerManagerConfig["customLiveMsg"];
	/**
	 * 是否启用图片卡片渲染。`false` 时直播开播 / SC / 上舰 / 弹幕词云全部走文字回退。
	 * 缺省视为 true。Adapter 通常用 `globals.defaults.cardStyle.enabled` 填充。
	 */
	imageEnabled?: boolean;
	/**
	 * 总结时允不允许联网搜索。缺省 false(搜索按次付费,自动路径必须主人亲手
	 * 点亮)。Adapter 用 `globals.ai.search.engines.live` 填充。
	 */
	aiWebSearch?: boolean;
	/**
	 * 全局默认直播封面列表(独立端专属)。该 UP 无 per-UP / per-kind 覆盖时
	 * `liveCover()` 拿它做「每次推送轮换」的兜底列表,仅 live 卡消费。
	 */
	defaultLiveCoverImages?: string[];
}

export interface LiveEngineOptions {
	serviceCtx: ServiceContext;
	api: Api;
	push: PushLike;
	/**
	 * 分层上报器(动态与直播共用的那一个):房间不监听了、被 B 站拒了、预检撞风控都经它报给问题表;
	 * 直播引擎自己不再私聊主人。
	 */
	problems: LiveProblems;
	contentBuilder: LiveContentBuilder;
	/** Optional — if absent, image-based pushes are skipped / fall back to text. */
	imageRenderer?: ImageRenderer | null;
	/** Optional — if absent, live summaries fall back to the configured template. */
	commentary?: CommentaryProvider | null;
	config: LiveEngineConfig;
	/**
	 * 下播总结的 AI 那份要不要做:宿主算好的布尔(AI 总开关且「写正文」设置里默认开或有现存目标的例外开),
	 * 每次下播现取、不缓存。引擎不看目标(ADR-0032 决策 2),原样递给请求器。必给 —— 漏给编译不过。
	 */
	isAiEnabled: () => boolean;
	/** Called by the engine to surface an `engine-error`; the host forwards it to its MessageBus. */
	emitEngineError: (message: string) => void;
	/** Per-UID live-state transitions; the host forwards to `bus.emit("live-state-changed", …)`. */
	emitLiveState: (uid: string, status: "live" | "idle", startedAt?: string) => void;
	/**
	 * Per-UID watched-count updates; the host forwards to `bus.emit("live-viewers-changed", …)`.
	 * Throttled per-UID to 2s at the room-session boundary.
	 */
	emitViewers: (uid: string, viewers: number) => void;
	/**
	 * Background-rotation picker: a card kind with >1 configured backgrounds cycles
	 * one-per-push; returning undefined keeps the first background. Threaded straight
	 * through to every RoomContext.
	 */
	pickCardBackground: PickLiveCover;
	/** 大航海徽章图标(图库引用),透传到每个 RoomContext。 */
	guardIcons: GuardIcons;
	/** 抓图服务:直播卡的封面在出卡前抓进图库(3a-34),透传到每个 RoomContext。 */
	imageFetcher: ImagesDeps["images"];
	/** 图库引用 → 字节(上舰消息发图段用),透传到每个 RoomContext。 */
	readImage: (ref: ImageRef) => Promise<{ bytes: Uint8Array; mime: string } | undefined>;
	/** 订阅 id → 订阅资料里的头像引用;出卡那一刻现读。必给 —— 漏给编译不过。 */
	avatarOf: (subscriptionId: string) => ImageRef | undefined;
	/**
	 * uid→roomId 解析成功回调。宿主据此把房号写盘,下次启动/reload 直接读盘复用,
	 * 省掉逐 UP 的 `fetchUserInfo` 房号解析请求。透传到每个 RoomContext。
	 */
	onRoomIdResolved: (uid: string, roomId: string) => void;
}

/**
 * Platform-neutral live-monitoring engine. Wires the five helpers
 * (listener-manager / viewer-chat-collector / wordcloud-generator /
 * template-renderer / live-summary-requester) together and exposes the public
 * surface the host runtime drives.
 *
 * Lifecycle:
 *
 * - {@link start}: register subscription set, open listeners for those that need them.
 * - {@link applyOps}: incremental subscription delta (add / delete / update);
 *   adapter forwards `bilibili-notify/subscription-changed` events here.
 * - {@link rebuildFromSubs}: full rebootstrap (used after `auth-restored`).
 * - {@link teardown}: tear down all listeners + records (used on `auth-lost`).
 * - {@link stop}: dispose; called by the host on shutdown.
 */
export class LiveEngine {
	private readonly logger: Logger;
	private readonly listener: ListenerManager;
	private readonly danmakuCollector: ViewerChatCollector;
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
		this.danmakuCollector = new ViewerChatCollector(stopwords);
		const templateRenderer = new LiveTemplateRenderer();
		const wordcloudGenerator = new WordcloudGenerator({
			getImageRenderer,
			isImageEnabled: () => this.config.imageEnabled !== false,
			logger: this.logger,
		});
		this.liveSummaryRequester = new LiveSummaryRequester({
			commentary: opts.commentary ?? null,
			isAiEnabled: opts.isAiEnabled,
			isWebSearchEnabled: () => this.config.aiWebSearch === true,
			logger: this.logger,
		});
		const liveSummaryRequester = this.liveSummaryRequester;

		this.listener = new ListenerManager({
			serviceCtx: opts.serviceCtx,
			api: opts.api,
			push: opts.push,
			problems: opts.problems,
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
			pickCardBackground: opts.pickCardBackground,
			guardIcons: opts.guardIcons,
			imageFetcher: opts.imageFetcher,
			readImage: opts.readImage,
			avatarOf: opts.avatarOf,
			onRoomIdResolved: opts.onRoomIdResolved,
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

	/**
	 * Tear down all listeners + per-room state, leaving the engine instance reusable.
	 *
	 * **只在 `auth-lost` 时调用**(独立端 `engines.ts` 一处),所以日志直接写明原因。
	 * 此前它打的是 info「关闭所有直播间监听」——
	 * 级别上跟正常停服没区别,措辞上既不说为什么关也不说怎么恢复,而同一时刻动态
	 * 那边打的是一条 warn。两条讲的是同一件事,读起来却像两回事。
	 */
	teardown(): void {
		this.logger.warn("[auth] 账号登录已失效，直播间监听已全部关闭（待 auth-restored 重建）");
		this.listener.disposeAll();
	}

	/** Full rebootstrap. 与 {@link teardown} 一一对应,只在 `auth-restored` 时调用。 */
	rebuildFromSubs(subs: SubscriptionsView): void {
		this.logger.info("[auth] 账号登录已恢复，正在重建直播间监听");
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
			switch (op.kind) {
				case "add": {
					if (!this.listener.needsListener(op.sub)) break;
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
						// 周期「正在直播」的计时器是 setInterval 句柄,ms 参数 immutable,开关或间隔变了
						// 都需要 dispose+rearm(开关关了只拆不建)。先记下旧值,assign 完成后比对。
						const wasStreaming = existing.liveStreaming;
						const prevInterval = existing.streamingIntervalHours;
						for (const change of liveChanges) {
							const { scope: _scope, ...fields } = change;
							Object.assign(existing, fields);
						}
						for (const change of targetChanges) {
							existing.target = change.target;
						}
						if (!this.listener.needsListener(existing)) {
							this.listener.stopForUid(op.uid);
						} else if (
							existing.liveStreaming !== wasStreaming ||
							existing.streamingIntervalHours !== prevInterval
						) {
							this.listener.rearmPeriodicTimerForUid(op.uid);
						}
					} else {
						const fullSub = lookupFullSub(op.uid);
						if (fullSub && this.listener.needsListener(fullSub)) {
							this.listener.startForUid(fullSub);
						}
					}
					break;
				}
			}
		}
	}

	/**
	 * 弹幕收集器当前占着的 key 规模,给内存自检日志用(见 `ViewerChatCollector.stats`)。
	 *
	 * 这是引擎里唯一一处会随「弹幕量 × 在播时长」无界增长的结构,所以单独开一个
	 * 口子报出来 —— 堆在涨的时候,得能一眼看出是不是它。
	 */
	danmakuStats(): { rooms: number; words: number; senders: number } {
		return this.danmakuCollector.stats();
	}

	/** Replace runtime config (called when the adapter receives a config-changed event). */
	updateConfig(config: LiveEngineConfig): void {
		this.config = config;
		this.danmakuCollector.setStopwords(mergeStopWords(config.wordcloudStopWords));
		this.listener.updateConfig(toListenerConfig(config));
		// 周期「正在直播」的开关与间隔都是每个 UP 折好的值(`SubItemView`),全局改了也由宿主逐订阅
		// 经 `applyOps` 推下来,那边比对前后值才重排 —— 引擎级不再另存一份全局间隔。
	}

	/**
	 * 热替换 CommentaryProvider 实例。adapter 在用户运行时打开 / 关闭 / 更换 AI
	 * 配置后调用,引擎随后的直播总结会立即用新实例 (或回退到模板) ,无需重启 server。
	 */
	setCommentary(commentary: CommentaryProvider | null): void {
		this.liveSummaryRequester.setCommentary(commentary);
	}

	/**
	 * 热替换 ImageRenderer 实例。宿主在渲染器上下线时调用。子组件 (词云 /
	 * room-context / 卡片渲染) 都通过共享 provider 现取,这里只需更新单一 state。
	 */
	setImageRenderer(imageRenderer: ImageRenderer | null): void {
		this.currentImageRenderer = imageRenderer;
	}

	/** Final dispose; the engine instance must not be reused after this. */
	stop(): void {
		this.listener.disposeAll();
	}

	/**
	 * Per-room live-state snapshot for every active monitor. Routes / dashboards
	 * filter on `isLive` to show "正在直播" panels.
	 */
	listLiveSnapshots(): ReturnType<ListenerManager["listLiveSnapshots"]> {
		return this.listener.listLiveSnapshots();
	}

	/**
	 * 把这位 UP 的「正在直播」复推提前到现在(宿主 devtools 用)。没监听 / 没在播回 false。
	 */
	repushNow(uid: string): Promise<boolean> {
		return this.listener.tickNowForUid(uid);
	}
}

function toListenerConfig(c: LiveEngineConfig): ListenerManagerConfig {
	return {
		guardTemplate: c.guardTemplate,
		customLiveMsg: c.customLiveMsg,
		liveSummaryDefault: c.liveSummaryDefault,
		imageEnabled: c.imageEnabled,
		defaultLiveCoverImages: c.defaultLiveCoverImages,
	};
}

/** Combine the bundled stop-words with the user's comma-separated additions. */
function mergeStopWords(extra?: string): Set<string> {
	return new Set([...definedStopWords, ...parseStopWords(extra)]);
}
