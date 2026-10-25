/**
 * Server-side engine wiring: neutral live sessions / push plus the dynamic source adapters,
 * driven by the file-backed ConfigStore + TargetDispatcher.
 *
 * Construction order:
 *
 *   1. Bind SubscriptionStore to ConfigStore
 *   2. Build TargetDispatcher (subscribers: HistoryStore via onDelivery)
 *   3. Construct PushRouter({ dispatcher, store, master })
 *   4. Optionally construct CommentaryGenerator (when apiKey + baseUrl set; the
 *      `enabled` flag is enforced at engine-config gating layer in step 5/6)
 *   5. Wire the neutral live session, interaction and push layers
 *   6. Sources register later and report through their source contexts
 *
 * Engine-stop is registered with serviceCtx.onDispose; the runtime's dispose()
 * propagates correctly.
 */

import { readFileSync } from "node:fs";
import {
	CommentaryGenerator,
	PROMPT_NEUTRAL_NOUNS,
	webSearchExecutorFromSettings,
} from "@bilibili-notify/ai";
import { displayNameOf, type ModuleState } from "@bilibili-notify/contract";
import { ImageRenderer, type PuppeteerLike } from "@bilibili-notify/image";
import type {
	AddressCandidate,
	CardKind,
	CardSkinManifest,
	ConnectionCapabilities,
	CreatorCandidate,
	CreatorProfileReport,
	DeliveryResult,
	Disposable,
	GlobalConfig,
	Identity,
	ImageRef,
	LinkPreviewPolicy,
	LinkPreviewSettings,
	LiveSession,
	NotificationPayload,
	ProbeResult,
	PushTarget,
	PushTargetScope,
	Result,
	SessionRef,
	TargetReachability,
} from "@bilibili-notify/internal";
import {
	aiWritingNeeded,
	isReachabilityEvidence,
	needsLiveMonitor,
	resolve,
	resolveAIProfile,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import { textSettingsOf } from "@bilibili-notify/internal/i18n";
import { PushRouter } from "@bilibili-notify/push";
import { atomicWriteJsonSync } from "@bilibili-notify/storage";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import type { CreatorStatsReader } from "../ai/creator-stats.js";
import { attachReadOnlyTools, type LiveNowReader } from "../ai/read-only-tools.js";
import type { AiToolProviderRegistry } from "../ai/tool-provider-registry.js";
import type { ConfigStore } from "../config/store.js";
import type { HistoryStore } from "../history/store.js";
import type { ImageFetcher } from "../images/image-fetcher.js";
import { resolveLinkPreviewPolicies } from "../link-preview/link-scope.js";
import type { LinkResolverRegistry } from "../link-preview/registry.js";
import { createLiveInteractions, type LiveInteractions } from "../live/live-interactions.js";
import { bindLivePush } from "../live/live-push.js";
import { createLiveSessionEngine, type LiveSessionEngine } from "../live/live-sessions.js";
import { liveSettingsOf, rotateLiveCover } from "../live/live-settings.js";
import type { LiveTable } from "../live/live-table.js";
import { LiveSummaryRequester } from "../live/recap/live-summary-requester.js";
import { mergeStopWords } from "../live/recap/stop-words.js";
import { ViewerChatCollector } from "../live/recap/viewer-chat-collector.js";
import { WordcloudGenerator } from "../live/recap/wordcloud-generator.js";
import { createCardFailureTracker } from "../posts/deliver-post.js";
import { createPostQueue } from "../posts/post-queue.js";
import { makePostSettingsReader } from "../posts/post-settings.js";
import { createProblemNotifier } from "../problems/problem-notifier.js";
import type { ProblemTable } from "../problems/problem-table.js";
import { boundLivePush, boundPostPush } from "../push/bound-push.js";
import { createConnectionProbeEngine } from "../push/connection-probe-engine.js";
import type { PlatformAdapterRegistry } from "../push/registry.js";
import { createTargetDispatcher, type SendInterceptHandler } from "../push/target-dispatcher.js";
import {
	type RegisterBuiltinSourceOptions,
	registerBuiltinSource,
} from "../subscriptions/builtin-sources.js";
import {
	createSourceGates,
	fetchSourceLiveStatus,
	fetchSourceProfile,
} from "../subscriptions/call-source.js";
import {
	platformLabelOf,
	sourceNounsFor,
	subscriptionIdentityLabelOf,
} from "../subscriptions/platform-label.js";
import type { SourceRegistry } from "../subscriptions/registry.js";
import { searchSourceCreators } from "../subscriptions/search-source-creators.js";
import { createSourceStatusReader } from "../subscriptions/source-status.js";
import { errorMessageOf } from "../util/error-message.js";
import { builtinPersonasOf, toGeneratorConfig } from "./ai-config.js";
import {
	CARD_BG_CURSORS_FILE,
	makeExistingCardBgPicker,
	readCardBgDataUrl,
} from "./card-assets.js";
import { type CardBgRotator, createCardBgRotator } from "./card-bg-rotation.js";
import { MasterNotifier } from "./master-notifier.js";
import { createMuteState, type MuteState } from "./mute-state.js";
import {
	historyRecordFromFilteredPost,
	historyRecordFromSend,
	type PushHistoryReader,
} from "./push-history.js";
import type { ProfileReportHandler } from "./reported-profiles.js";
import { dataPath } from "./roots.js";
import type { NodeServiceContext } from "./service-context.js";
import type { SubscriptionStateStore } from "./subscription-state-store.js";

export interface EnginesRuntime extends Disposable {
	/**
	 * 关停(幂等,再调交回同一个 promise):逆序撤全部来源登记,等全部在途的收尾(含拓展已经撤了、`stop()` 还没落定的)
	 * 落定 —— 最多各等 `DISPOSE_TIMEOUT_MS` —— 再关作品入口与其余。
	 */
	dispose(): Promise<void>;
	/**
	 * 登记一个来源(建它的来源上下文、登记即 start):内置来源与拓展的订阅源走同一个口。交回撤登记的把手
	 * (先撤登记、触发来源的 `stop`,再收上下文;**幂等**);引擎关停时自己先停掉没撤的,再关作品入口。
	 * `rejectedProblemLevel`:拓展的来源给 `warn`(被拒的问题上报是拓展自己的 bug),内置的缺省 `error`。
	 */
	registerSource(
		entry: Pick<
			RegisterBuiltinSourceOptions,
			| "sourceKey"
			| "source"
			| "integration"
			| "logger"
			| "rejectedProblemLevel"
			| "onRejectedProblem"
			| "label"
		>,
	): Promise<Disposable>;
	/**
	 * 事件里没带作者名时补的名字:这个人名下订阅的资料缓存里的名字,没有就是身份标签
	 * (`displayNameOf` 那条链的后两段)。拓展的上报按它补缺的作者名(`extensions/extension-source.ts`)。
	 */
	fallbackCreatorName(identity: Identity): string;
	readonly push: PushRouter;
	/**
	 * 全局静音。`push` 已经接了闸(订阅推送在 `PushRouter.push` 交进来时被挡),
	 * 这里暴露出来是给指令与面板改状态用的。
	 */
	readonly muteState: MuteState;
	readonly subscriptionStore: SubscriptionStore;
	/** 经同一来源串行闸取资料:资料刷新与女仆回落共用这一口。 */
	fetchProfile(identity: Identity, signal?: AbortSignal): Promise<Result<CreatorProfileReport>>;
	/**
	 * 在某个来源里搜人(宿主外壳 `searchSourceCreators`):与 `fetchProfile`、查直播状态共用同一道来源串行闸,
	 * 同一个来源一次只有一个调用在途。女仆的搜人工具与面板的解析门都走这一个,别各自再绑一份。
	 */
	searchCreators(
		sourceKey: string,
		query: string,
	): Promise<Result<{ candidates: CreatorCandidate[] }>>;
	readonly commentary: CommentaryGenerator | null;
	/** 只给测试世界挂假点评用。 */
	setCommentary(commentary: CommentaryGenerator | null): void;
	/** 只给测试世界挂假出图器用。 */
	setImageRenderer(renderer: ImageRenderer | null): void;
	/**
	 * 推送用的卡片渲染器,`null` = 没有 puppeteer(未装 / 未配 Chrome)。
	 *
	 * **是 getter,别解构** —— `/api/cards/renderer` 与热重载会整个换掉它,
	 * 拿到一次就长期攥着会渲染到一个已 dispose 的浏览器上。
	 *
	 * 与 `cards.ts` 那个预览渲染器刻意分开:预览每次请求都按页面草稿 updateConfig,
	 * 而这一个跟着**已保存**的 `cardStyle` 热同步 —— 周报卡要的正是后者。
	 */
	readonly imageRenderer: ImageRenderer | null;
	/** 核心回顾收集器此刻的规模(资源监控用)。 */
	viewerChatStats(): { subscriptions: number; words: number; senders: number };
	/**
	 * 这条订阅此刻那一场(ADR-0020 决策 6,场次模块 `live-sessions.ts` 手里的):没在播就是 `undefined`。
	 * 统计页拿它判这一行「此刻在播」,断流等待里也还算在播。
	 */
	liveSession(subscriptionId: string): LiveSession | undefined;
	/** 开发场景:把这条订阅的直播核对提前到现在。 */
	tickLiveSessionNow(subscriptionId: string): Promise<boolean>;
	/**
	 * 拓展订阅的平台名(清单里订阅源的叫法 → 拓展名),每次现取 —— 与女仆查订阅那份视图同一口
	 * ({@link CreateEnginesOptions.extensionPlatformLabel})。锐评的「平台」一列用它(ADR-0020 决策 12)。
	 * 取不到(没接 / 没装 / 开机途中)是 `undefined`,调用方退拓展 id。
	 */
	extensionPlatformLabel(extensionId: string): string | undefined;
	/** 拓展清单里平台对作品的叫法;取不到与 {@link extensionPlatformLabel} 同样回 `undefined`。 */
	extensionPostNoun(extensionId: string): string | undefined;
	/** 链接解析的开关与冷却 —— 随 config-changed 刷新的快照;群里每句话都会问它。 */
	linkPreview(): LinkPreviewSettings;
	/**
	 * 链接解析里某个群的答案:解不解析、回什么(键与表见 `link-preview/link-scope.ts`)。表随 globals /
	 * targets / connections 三种 config-changed 重算 —— 例外引用的是目标,目标或连接停用、
	 * 删掉都会改变答案,只盯 globals 的话面板上开着、实际却还在按旧目标表解析。
	 */
	linkPolicyFor(key: string): LinkPreviewPolicy;
	/**
	 * 链接卡的呈现 = 全局那套皮肤(链接卡没有 UP 可言)。每张卡调一次,别攥着。
	 */
	linkCardPresentation(): { cardSkin: string };
	/**
	 * 主人点「测试」(`/api/connections/:id/probe`):顺路把还没探出来的平台能力再探一次(与定时
	 * 健康探测同一条路),结果每次都写进连接的 `probeState`;通了当场清「连不上」,不通不算进失败次数。
	 */
	probeConnection(connectionId: string): Promise<ProbeResult>;
	/** 这条连接所在平台的能力快照(能不能签小程序卡);没有能力概念的平台是 undefined。 */
	connectionCapabilities(connectionId: string): ConnectionCapabilities | undefined;
	/** 主动探一次平台能力(还没探出来时)。与上一条同源,都走 dispatcher 的连接寻址。 */
	probeConnectionCapabilities(connectionId: string): Promise<ConnectionCapabilities | undefined>;
	/** 列这条连接上可挑的地址(只查 `scope` 那一种),转给派发器的 `listAddressCandidates`。 */
	listAddressCandidates(
		connectionId: string,
		scope: PushTargetScope,
		signal: AbortSignal,
	): Promise<Result<{ candidates: readonly AddressCandidate[] }>>;
	/** 不经目标表往某条连接上的一个会话发(链接回复),转给派发器的 `sendToAddress`。 */
	sendToAddress(
		connectionId: string,
		session: SessionRef,
		payload: NotificationPayload,
	): Promise<DeliveryResult>;
	/** 各引擎模块开没开,`/api/health` 的 `modules` 那一格。 */
	getModuleState(): ModuleState;
	/**
	 * Runtime hot-enable of card image rendering. When the server booted without
	 * a chromePath the engines run text-only; once the operator detects/sets a
	 * Chrome binary in the dashboard, this constructs + starts a shared
	 * ImageRenderer and wires it into the live + dynamic engines WITHOUT a
	 * restart. Idempotent: returns false if rendering was already enabled.
	 */
	enableImageRendering(puppeteer: PuppeteerLike): boolean;
	/**
	 * Hot-swap the browser behind card rendering (dashboard changed chromePath /
	 * chromeEndpoint). Rebuilds the ImageRenderer on the new adapter and rewires
	 * both engines; also usable as a first enable. Disposing the previous
	 * adapter is the caller's job — engines never own the adapter lifecycle.
	 */
	swapImageRendering(puppeteer: PuppeteerLike): void;
}
export interface CreateEnginesOptions {
	/**
	 * NodeServiceContext (not the platform-neutral ServiceContext) — engines.ts
	 * uses `forSubsystem(name, levelKey)` to give each engine its own pino instance
	 * whose level follows the `levelKey` slot of the log-level table
	 * (`bindLogLevels` pushes it). The server runtime constructs the parent
	 * context once at boot.
	 */
	serviceCtx: NodeServiceContext;
	/** 数据根(`AppRuntime.dataRoot`):背景图资产与轮换游标住在它底下。 */
	dataRoot: string;
	/**
	 * 自带字体的读取口(`AppRuntime.loadFontFace`)。刻意由外面传进来而不是自建:
	 * 缓存里留的就是那条几十兆的 `@font-face`,建两个就在堆里存两遍。
	 */
	loadFontFace: (id: string) => Promise<string>;
	configStore: ConfigStore;
	historyStore: HistoryStore;
	subscriptionStore: SubscriptionStore;
	/**
	 * Display-cache source for uname/uavatar (history snapshot + engine sub
	 * views). cachedProfile was externalized out of `Subscription`, so the
	 * config subs from subscriptionStore no longer carry it — read it here.
	 */
	subscriptionStateStore: SubscriptionStateStore;
	/** 订阅来源登记表(`AppRuntime.sourceRegistry`);来源由 `registerSource` 登进去。 */
	sources: SourceRegistry;
	/** 链接解析器登记表(`AppRuntime.linkResolvers`);来源经上下文登进去。 */
	linkResolvers: LinkResolverRegistry;
	/** AI 工具提供方登记表(`AppRuntime.aiToolProviders`);来源经上下文登进去。 */
	aiToolProviders: AiToolProviderRegistry;
	/** 来源报资料的收口(`AppRuntime.profileReports`):递给来源上下文的 `profiles` 选项。 */
	profileReports: Pick<ProfileReportHandler, "report">;
	/** 问题表(`AppRuntime.problems`):递给来源上下文当写口,问题通知器听它,订阅删了关于它的问题也在这清。 */
	problems: ProblemTable;
	bus: import("@bilibili-notify/internal").MessageBus;
	adapters: PlatformAdapterRegistry;
	/** 开发版的推送截流,原样递给派发器(出口咽喉那一处);生产不传。 */
	interceptSend?: SendInterceptHandler;
	/**
	 * Optional puppeteer adapter. When provided the engines spin up a shared
	 * {@link ImageRenderer} so live / dynamic cards render to JPEG instead of
	 * falling back to plain text. When null (no BN_CHROME_PATH), pushes go out
	 * as the engines' text-only fallback path.
	 */
	puppeteer?: PuppeteerLike | null;
	/**
	 * 推送免扰按哪一刻判。缺省真时钟;devtools 用它做「当作现在是 xx:xx」的单点覆盖,
	 * 原样交给 `PushRouter.quietHoursNow`。
	 */
	quietHoursNow?: () => Date;
	/**
	 * 拓展订阅的平台名,女仆查订阅那份视图用(ADR-0019 决策 64)。每次现取 —— 拓展装载器比引擎
	 * 晚建起来,装卸也随时发生。取不到(没接 / 没装 / 开机途中)交 `undefined`,视图退拓展 id。
	 */
	extensionPlatformLabel?: (extensionId: string) => string | undefined;
	/** 拓展清单里平台对作品的叫法;与 {@link extensionPlatformLabel} 同源、同样现取。 */
	extensionPostNoun?: (extensionId: string) => string | undefined;
	/**
	 * 女仆读作品与统计的口(`ai/creator-stats.ts`,接线层造):统计仓、数据统计总开关、统计总览读口。
	 * 不给 = 女仆的作品 / 统计工具答「当前不可用」。
	 */
	creatorStats?: CreatorStatsReader;
	/**
	 * 出图器的「图库引用 → 可画的地址」解析口(`imageRefDataUrl(runtime.imageStore)`):作品卡里的配图、封面、
	 * 头像、正文小图标都是图库引用,出图前经它转成 data URL。不给 = 引用一律画占位(只测不画图的引擎时)。
	 */
	resolveImageRef?: (ref: ImageRef) => Promise<string | undefined>;
	/**
	 * 图库引用 → 字节与类型(`runtime.imageStore.read`):AI 点评看只有图库引用的图(拓展作品)时,核心要量字节数
	 * (超 3 MiB 的跳过)再编成 data URL,所以不复用上面那个回拼好的串的 `resolveImageRef`。必给 —— 漏给是编译不过,不是悄悄不给 AI 看图。
	 */
	readImage: (ref: ImageRef) => Promise<{ bytes: Uint8Array; mime: string } | undefined>;
	/** 在播表(`runtime.liveTable`,ADR-0019 决策 57 / 64):场次引擎写它,女仆查直播状态也从它答。 */
	liveTable?: Pick<LiveTable, "get" | "list" | "replace" | "merge" | "remove">;
	/**
	 * B 站作品图 / 直播封面的抓图服务(接线层给 B 站集成的上下文:它自己的请求客户端,引用方是「集成在途」):
	 * 出卡前把图抓进图库(3a-34)。必给 —— 漏给是编译不过,不是悄悄不出图。
	 */
	imageFetcher: Pick<ImageFetcher, "fetchImage">;
	/**
	 * 卡片皮肤(ADR-0014)的三口。由接线层从 `CardSkinStore` 接过来 —— engines 不认识
	 * 皮肤库,店也不认识引擎,中间就这三个函数。缺省(没接)= 只有内置默认皮肤。
	 */
	cardSkins?: {
		/** 皮肤 id → 清单;取不到 → 渲染器回落默认皮肤。 */
		get: (id: string) => CardSkinManifest | undefined;
		/** 包内资产名 → data URL。 */
		asset: (skinId: string, name: string) => Promise<string | undefined>;
		/** 出图回落了。宿主负责去重与「怎么让主人看见」。 */
		onFallback: (info: { skinId: string; kind: CardKind; reason: string }) => void;
	};
}

export function createEngines(opts: CreateEnginesOptions): EnginesRuntime {
	const log = opts.serviceCtx.logger;
	// 各子上下文只交「标签」与「跟哪一格」,等级表由 `bindLogLevels`(入口,配置读完之后)整张推、热更也在那边。
	// 一行日志是谁的代码打的就跟谁那一格:作品队列、拓展作品的接入、替拓展跑的直播场次与推送是核心的代码,跟 `core`;
	const initialGlobals = opts.configStore.getGlobals();
	const postsCtx = opts.serviceCtx.forSubsystem("posts", "core");
	const coreLiveCtx = opts.serviceCtx.forSubsystem("live", "core");
	/** 宿主调来源的串行闸:搜人与查直播状态共用,同一个来源一次只有一个调用在途。 */
	const sourceGates = createSourceGates();
	const fetchProfile = (identity: Identity, signal?: AbortSignal) =>
		fetchSourceProfile(
			{ sources: opts.sources, logger: log, gates: sourceGates },
			identity,
			signal,
		);
	const searchCreators = (sourceKey: string, query: string) =>
		searchSourceCreators(
			{ sources: opts.sources, logger: log, gates: sourceGates },
			sourceKey,
			query,
		);
	/** 这个来源实现了 `fetchLiveStatus`(核心据此给它的每一场挂周期核对)。 */
	const hasLiveStatus = (sourceKey: string): boolean =>
		opts.sources.get(sourceKey)?.fetchLiveStatus !== undefined;
	const aiCtx = opts.serviceCtx.forSubsystem("ai", "ai");
	const imageCtx = opts.serviceCtx.forSubsystem("image", "image");
	const globals = (): GlobalConfig => opts.configStore.getGlobals();
	/** 现存推送目标的 id(含停用的),每次现取:作品与直播总结的 AI 生成门共用,悬空的例外 id 不算数。 */
	const targetIds = (): string[] => opts.configStore.getTargets().map((t) => t.id);
	const sourceStatus = createSourceStatusReader({
		sources: opts.sources,
	});
	/**
	 * 这个来源实现了直播吗:就是它实现了 `fetchLiveStatus`。声明了周期直播的拓展现在必须实现拉取式(登记订阅源时核,
	 * 不合就加载失败),所以与今天的模块状态口径一致。
	 */
	const sourceHasLive = (sourceKey: string): boolean => hasLiveStatus(sourceKey);

	// ---------- Dispatcher + push ----------
	// onDelivery 只负责 target.reachability 同步 —— dispatcher 拿不到订阅 + feature,
	// 没法填 history 的订阅 / uid 字段。history 写入挂到 PushRouter.onSend
	// (见下方),那里能拿到完整的发起上下文。
	const dispatcher = createTargetDispatcher({
		store: opts.configStore,
		adapters: opts.adapters,
		logger: log,
		interceptSend: opts.interceptSend,
		onDelivery: (target, _payload, result) => {
			// 没真出网的投递(devtools 截流)不是可达性证据 —— 写回去会把一个发不出去的目标
			// 标成绿的,而且落盘、活得比截流本身还久。
			if (!isReachabilityEvidence(result)) return;
			const prev = target.reachability;
			// 只在通断翻转时写(没记过的也算一次)。
			if (!prev || (prev.status === "reachable") !== result.ok) {
				// 失败的原话填进 `message`,码不落盘。
				const next: TargetReachability = result.ok
					? {
							status: "reachable",
							changedAt: new Date().toISOString(),
							latencyMs: result.latencyMs,
						}
					: {
							status: "unreachable",
							changedAt: new Date().toISOString(),
							message: result.message,
						};
				// 发出去不等,但登记进 track:关停得等这笔写交进 config 写道,写道才能关门。
				opts.serviceCtx.track(
					opts.configStore
						.recordTargetReachability(target.id, next)
						.catch((e) =>
							log.warn(`[sink] target ${target.id} reachability writeback failed: ${String(e)}`),
						),
				);
			}
		},
	});

	const masterTarget = (): PushTarget | undefined => {
		const id = globals().master.targetId;
		if (!id) return undefined;
		return opts.configStore.getTargets().find((t) => t.id === id);
	};

	// 全局静音。到期时刻存在 globals 里 —— 重启不解除,网页上也看得见。
	const muteState = createMuteState({
		read: () => globals().mutedUntil,
		write: async (until) => {
			await opts.configStore.patchGlobals({ mutedUntil: until });
		},
	});

	// 历史行要的「替谁、当时叫什么」:推送落行与被过滤的作品留痕共用这一份查法。
	const historyReader: PushHistoryReader = {
		subscriptionOf: (subscriptionId) => {
			const subscription = opts.subscriptionStore.findById(subscriptionId);
			if (!subscription) return undefined;
			return {
				subscription,
				profile: opts.subscriptionStateStore.get(subscription.id)?.cachedProfile,
			};
		},
	};
	/** 往历史仓记一行。发出去不等,但登记进 track:关停得等这行历史(含图片落盘)交进历史写道,写道才能关门。 */
	const recordHistory = (input: Parameters<typeof opts.historyStore.record>[0]): void => {
		opts.serviceCtx.track(
			opts.historyStore
				.record(input)
				.catch((e) => log.warn(`[history] record failed: ${String(e)}`)),
		);
	};
	/**
	 * 一条被过滤挡下的作品 → 推送历史里的一行(ADR-0021 决策 34 的 🔗)。B 站动态与拓展作品两条路
	 * (都经核心入口 `PostQueue` 的装配)的 `deps.recordFiltered` 都接到这儿;留痕不是推送,不经推送层、不走事件总线。
	 */
	const recordFilteredPost = (
		filtered: Parameters<typeof historyRecordFromFilteredPost>[0],
	): void => {
		const input = historyRecordFromFilteredPost(filtered, historyReader);
		if (input) recordHistory(input);
	};

	const push = new PushRouter({
		dispatcher,
		store: opts.subscriptionStore,
		master: masterTarget() ?? null,
		logger: log,
		serviceCtx: opts.serviceCtx,
		defaults: () => globals().defaults,
		muted: () => muteState.isMuted(),
		// 锚点带 AI 版时逐目标挑哪一份,现取:面板里改了例外,下一次推送就按新的。
		aiWriting: () => globals().ai.writing,
		quietHoursNow: opts.quietHoursNow,
		onSend: (info) => {
			// 一次推送 × 一个目标 = 历史一行;无目标那次也记(面板上才看得见)。
			const input = historyRecordFromSend(info, historyReader);
			if (input) recordHistory(input);
		},
	});
	push.start();

	// ---------- Master notifier ----------
	// 组件告警(`engine-error`)→ 主人私聊,共用一张 per-source 60s 节流表。登录失效不在这里:
	// 那是「主人该知道的事」,由下面的问题通知器说(带「已恢复」)。
	// Web dashboard 上同样会通过 AlertShell 看到 engine-error;两路通道互不影响。
	const masterNotifier = new MasterNotifier({
		bus: opts.bus,
		push,
		logger: log,
		serviceCtx: opts.serviceCtx,
	});
	masterNotifier.install();

	// ---------- 问题通知器 ----------
	// 问题表里 `notify` 为真的问题 → 主人私聊(只有真送到才算说过,没送到限次再送;清掉时补「已恢复」)。
	// 与上面的 MasterNotifier 各有各的节流表:组件告警按 source,问题按 报的人 + code。
	const problemNotifier = createProblemNotifier({
		table: opts.problems,
		notify: (text) => push.notifyMaster(text),
		serviceCtx: opts.serviceCtx,
		logger: log,
	});

	// ---------- AI (optional) ----------
	// 构造仅依赖 apiKey / baseUrl 是否齐备 —— 与 `enabled` 解耦,后者交给引擎 config 层
	// 的 aiEnabled flag 在每次推送前热判断。这样用户在 dashboard 把 AI 开关切关再切开
	// 不需要重启服务。完整字段变更则走下方 `rebuildCommentary` 重建实例。
	//
	// `AISettings` → CommentaryGeneratorConfig 的翻译(含字段改名与「人格看指针」)
	// 本体在 `./ai-config.ts` —— 「试一句」与统计页的锐评用的是同一份映射,人格该
	// 从哪儿读只能有一个答案。指针指向一个还没添加的服务商时 resolveAIProfile 兜一套
	// 空值回来,下方 buildCommentary 的 `!p.apiKey || !p.baseUrl` 就会照既有规矩停用 AI。
	const buildAiConfig = () => toGeneratorConfig(globals().ai, builtinPersonasOf(globals()));

	const liveNowReader = (): LiveNowReader | undefined => {
		const table = opts.liveTable;
		if (!table) return undefined;
		// `row` 直接是在播表的行(`{ startedAt, details }`),AI 工具那头读新形状。
		return {
			row: (id) => table.get(id),
			running: (sourceKey) => sourceStatus.running(sourceKey),
		};
	};
	const labelDeps = {
		sources: opts.sources,
		extensionPlatformLabel: opts.extensionPlatformLabel,
		extensionPostNoun: opts.extensionPostNoun,
	};

	let commentary: CommentaryGenerator | null = null;
	const buildCommentary = (): CommentaryGenerator | null => {
		const p = resolveAIProfile(globals().ai);
		if (!p.apiKey || !p.baseUrl) return null;
		try {
			const c = new CommentaryGenerator({
				serviceCtx: aiCtx,
				config: buildAiConfig(),
				nouns: (keys) =>
					sourceNounsFor(
						keys,
						{
							...labelDeps,
							subscriptions: () => opts.subscriptionStore.list(),
						},
						PROMPT_NEUTRAL_NOUNS,
					),
			});
			// 接工具能力 —— **只读档**。少了这一步,女仆连「我订了哪些 UP」都查不到,
			// 会一口咬定「当前没有订阅」;带上写能力则等于让她能真的加减订阅。
			// 两种都不是我们要的,取舍写在 attachReadOnlyTools 的文档里。
			attachReadOnlyTools(c, {
				subscriptionStore: opts.subscriptionStore,
				subscriptionStateStore: opts.subscriptionStateStore,
				// 平台名问来源登记表,登记表里没有的(拓展)才问装载器 —— 与锐评同一条链。
				platformLabel: (sourceKey) => platformLabelOf(sourceKey, labelDeps),
				identityLabel: (identity) => subscriptionIdentityLabelOf(identity, labelDeps),
				sources: opts.sources,
				// 女仆的搜人走宿主外壳(超时、中止、抛错收成 unavailable),不直接碰来源。
				searchCreators,
				// 没订阅、停用或还没缓存时,同一份来源闸上按身份向平台查一次;不写资料缓存。
				fetchProfile,
				// 女仆查直播状态统一从在播表答;来源没在跑时 BN 手里没有它的在播状态。
				liveNow: liveNowReader(),
				// 作品与统计:统计仓、总开关、统计总览读口(接线层给的,总览比引擎晚一步建)。
				...(opts.creatorStats ? { stats: opts.creatorStats } : {}),
				// 每次请求现取:来源随上下文登记与撤销。
				providedTools: () => opts.aiToolProviders.tools(),
			});
			// 联网搜索的执行器**每次工具调用现取** —— 后端 / key 是运行期随时改的
			// 配置,快照会让「刚填的 key 不生效,重启才行」。没填 key 时取到 null,
			// 生成器那侧静默不挂 web_search。
			c.setWebSearchSource(() => webSearchExecutorFromSettings(globals().ai.search));
			c.start();
			return c;
		} catch (err) {
			log.warn(`[ai] commentary init failed: ${String(err)}`);
			return null;
		}
	};
	commentary = buildCommentary();

	// ---------- ImageRenderer (optional) ----------
	// Constructed when puppeteer is wired — at boot if chromePath was set, or at
	// runtime via enableImageRendering() when the operator auto-detects Chrome in
	// the dashboard (no restart). `cardStyle.enabled` is enforced inside
	// DynamicPoller via the `imageEnabled` config field; when false
	// the engines bypass the renderer and emit text-only payloads, so we keep the
	// instance alive rather than hot-swapping on the user toggling the switch.
	let imageRenderer: ImageRenderer | null = null;
	// 字体读取口由 runtime 建好传进来,**全进程只有那一个** —— 从前这儿自建一个、
	// 预览路由再自建一个,同一份几十兆的 `@font-face` 就在 512MB 的堆里存了两遍。
	// 热切换浏览器会重建渲染器,读取口跨重建复用,免得又从盘上搓一遍。
	const loadFontFace = opts.loadFontFace;

	const buildImageRenderer = (pup: PuppeteerLike): ImageRenderer => {
		return new ImageRenderer({
			serviceCtx: imageCtx,
			puppeteer: pup,
			config: {
				// 字体与背景图 2026-09-14 退役成皮肤旋钮:值住 `cardSkinKnobs`,由渲染器自己
				// 读盘解析(见 `skin/knob-assets.ts`)。这里不再喂那两样。
				cardSkinKnobs: globals().defaults.cardSkinKnobs,
			},
			resolveAsset: (id) => readCardBgDataUrl(opts.dataRoot, id),
			resolveFontFace: loadFontFace,
			// 卡上的时间按全局时区排;出卡那一刻现取,主人改了设置,后续的卡立刻跟上。
			timezone: () => globals().timezone,
			// 作品卡里的图库引用(配图 / 封面 / 头像 / 小图标)出图前经它转成可画的地址。
			resolveImageRef: opts.resolveImageRef,
			// 皮肤库那三口(接线层给);没给就是「只有内置默认皮肤」。
			resolveCardSkin: opts.cardSkins?.get,
			resolveCardSkinAsset: opts.cardSkins?.asset,
			onCardSkinFallback: opts.cardSkins?.onFallback,
		});
	};
	if (opts.puppeteer) {
		imageRenderer = buildImageRenderer(opts.puppeteer);
	}

	// ---------- 背景图轮换游标(每次推送轮换 + fs 持久化)----------
	// 游标按 `uid:kind` 独立,落盘 `<dataRoot>/runtime/card-bg-cursors.json`,重启续接不归零。
	// pick 在推送点(room-session / DynamicPoller)同步推进;脏标记驱动定时 flush,避免每
	// 推送写盘。注入给两个引擎。
	const cursorFile = dataPath(opts.dataRoot, ...CARD_BG_CURSORS_FILE);
	const loadCursors = (): Record<string, number> => {
		try {
			const parsed: unknown = JSON.parse(readFileSync(cursorFile, "utf8"));
			return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
		} catch {
			return {}; // 首次运行 / 文件缺失 / 损坏 → 从零开始
		}
	};
	const cardBgRotator: CardBgRotator = createCardBgRotator(loadCursors());
	const flushCursors = (): void => {
		if (!cardBgRotator.isDirty()) return;
		try {
			atomicWriteJsonSync(cursorFile, cardBgRotator.snapshot());
			cardBgRotator.clearDirty();
		} catch (e) {
			log.warn(`[engines] 背景轮换游标落盘失败: ${String(e)}`);
		}
	};
	const cursorFlushTimer = setInterval(flushCursors, 30_000);
	cursorFlushTimer.unref?.();
	// 轮换前过滤盘上已不存在的资产(配置里的悬空引用):死条目不占游标位、不会渲染成
	// 原封面;全悬空返回 undefined → 推送点静态兜底。今天只剩直播封面在轮 —— 卡片背景图
	// 那条链 2026-09-20 删掉(背景图归皮肤的 `image` 旋钮)。
	const pickExistingCardBg = makeExistingCardBgPicker(opts.dataRoot, cardBgRotator.pick);

	// ---------- 作品来源 ----------
	// 来源只管生产(B 站的是动态引擎:拉 feed、判新、翻译、抓图),作品经来源上下文交给核心入口 `postQueue`;
	// 过滤、出卡、点评、推送、图集都在核心里。来源由 `registerSource` 登记并启动(调它的是 `compose.ts`)。
	// 出图连续失败「只提醒一次」的计数(ADR-0019 决策 66):B 站动态与拓展作品用的是同一个渲染器,
	// **全进程一份**,两条路各记各的话同一次故障会各提醒一遍。
	const cardFailures = createCardFailureTracker();

	// 卡上的主播头像:订阅 id → 订阅资料里的头像引用。**每次出卡现读**,所以资料之后补上 / 换掉的头像不用重启就跟上。
	const profileAvatarOf = (subscriptionId: string): ImageRef | undefined =>
		opts.subscriptionStateStore.get(subscriptionId)?.cachedProfile?.avatar;

	const postQueue = createPostQueue({
		logger: postsCtx.logger,
		bus: opts.bus,
		serviceCtx: opts.serviceCtx,
		deps: {
			logger: postsCtx.logger,
			settings: makePostSettingsReader({
				subscription: (id) => opts.subscriptionStore.findById(id),
				globals,
				// 「来源还在跑吗」:登记表里有它。拓展停止时撤销登记,还在队列里的作品不再补推。
				sourceRunning: (sub) => sourceStatus.running(subscriptionIdentityOf(sub).sourceKey),
				targetIds,
			}),
			// 渲染器与 AI 会被热换:**必须是读外层 let 的闭包**,按值传就是「开机时没有浏览器,之后一直没有卡片」而门禁全绿。
			image: () => imageRenderer ?? undefined,
			ai: () => commentary ?? undefined,
			cardFailures,
			avatar: profileAvatarOf,
			readImage: opts.readImage,
			push: (subscriptionId, anchors) => boundPostPush(push, subscriptionId)(anchors),
			recordFiltered: recordFilteredPost,
			// 出图失败的提醒只剩这一路组件告警(`MasterNotifier` 私聊一条 + 面板红条)。
			// 单列一个来源:主人私聊的 60 秒节流按来源算,与别的组件告警共用一个的话,
			// 一边刚报过,另一边这次出图失败的告警就被吞了。B 站与拓展两条路共用这一个。
			emitEngineError: (message) =>
				opts.bus.emit("engine-error", { source: "post-delivery", message }),
		},
	});

	// 登记过的内置来源的撤销把手(`registerSource`);关停时先于作品入口收。
	const sourceRegistrations: Disposable[] = [];
	// 每个把手撤登记之后的收尾(等来源 `stop()` 落定、收上下文)。拓展收摊时自己先撤、把手同步返回而收尾还在路上,
	// 这时它已不在 `sourceRegistrations` 里,关停靠这一份才等得到它。永不拒。
	const sourceClosings = new Set<Promise<void>>();

	// ---------- Bus wiring ----------
	const handles: Disposable[] = [postQueue];

	// 订阅来源的直播(ADR-0019 决策 57 / 58 / 61 / 67):场次(开播 / 下播、断流接续)由 `liveSessions` 算一份,
	// 推送吃它(ADR-0020 决策 6);开播 / 下播卡由事件触发,周期「正在直播」、重启补推由推送那头的小计时器管;
	// 推什么、怎么推与 B 站同一份(直播装配、文案渲染、按 UP 折好的设置、特性键映射)。最新状态从在播表取,
	// 出卡的渲染器现取(热换、关了出图时不出卡)。
	const liveTable = opts.liveTable;
	/** 订阅来源的场次;统计页经 `liveSession` 读它。 */
	let liveSessionEngine: LiveSessionEngine | undefined;
	/** 来源报上来的观众互动(特别弹幕、特别进场……)的入口;和场次引擎同生同灭。 */
	let liveInteractionEngine: LiveInteractions | undefined;
	let viewerChats: ViewerChatCollector | undefined;
	/** 核心下播回顾的总结请求器;AI 实例热换时要跟着换引用。 */
	let liveSummaryRequester: LiveSummaryRequester | undefined;
	if (liveTable) {
		// `liveTable` 在这里是写口:场次引擎先写表、再改场次,表自己不听上报。
		const liveSessions = createLiveSessionEngine({
			bus: opts.bus,
			logger: coreLiveCtx.logger,
			table: liveTable,
			subscription: (id) => opts.subscriptionStore.findById(id),
			sourceStatus,
			fans: (id) => opts.subscriptionStateStore.get(id)?.cachedProfile?.followers,
			settings: (sub) => liveSettingsOf(sub, globals()),
			timers: coreLiveCtx,
			// 拉取式:来源实现了 `fetchLiveStatus` 就按每一场自己的时钟问它(外壳:超时、抛错收口、同一来源串行)。
			liveStatus: {
				has: hasLiveStatus,
				fetch: (identity, signal) =>
					fetchSourceLiveStatus(
						{ sources: opts.sources, logger: coreLiveCtx.logger, gates: sourceGates },
						identity,
						signal,
					),
			},
			subscriptions: () => opts.subscriptionStore.list(),
			// 要不要监听直播:internal 里那份唯一判定(折好的开关 ∧ 特别关注名单)。
			wantsLive: (sub) =>
				needsLiveMonitor({
					features: resolve(sub, globals().defaults).features,
					specialViewers: sub.specialViewers,
				}),
		});
		handles.push(liveSessions);
		liveSessionEngine = liveSessions;
		// 核心回顾的一份收集器与两个生产者:场次开始登记、互动记一条、下播卡同步取快照。
		const wordcloudStopWords = () =>
			mergeStopWords(globals().defaults.templates.wordcloudStopWords);
		viewerChats = new ViewerChatCollector(wordcloudStopWords());
		handles.push(
			opts.bus.on("config-changed", ({ scope }) => {
				if (scope === "globals") viewerChats?.setStopwords(wordcloudStopWords());
			}),
		);
		const wordcloudGenerator = new WordcloudGenerator({
			getImageRenderer: () => imageRenderer,
			isImageEnabled: () => globals().defaults.cards.enabled,
			logger: coreLiveCtx.logger,
		});
		liveSummaryRequester = new LiveSummaryRequester({
			commentary,
			isAiEnabled: () => {
				const g = globals();
				return g.ai.enabled && aiWritingNeeded(g.ai.writing.liveSummary, targetIds());
			},
			isWebSearchEnabled: () => globals().ai.search.engines.live,
			logger: coreLiveCtx.logger,
		});
		const summaryRequester = liveSummaryRequester;
		handles.push(
			bindLivePush({
				bus: opts.bus,
				logger: coreLiveCtx.logger,
				serviceCtx: coreLiveCtx,
				sessions: liveSessions,
				table: liveTable,
				subscription: (id) => opts.subscriptionStore.findById(id),
				profile: (id) => opts.subscriptionStateStore.get(id)?.cachedProfile,
				identityLabel: (identity) => subscriptionIdentityLabelOf(identity, labelDeps),
				settings: (sub) => liveSettingsOf(sub, globals()),
				// 订阅的封面 ?? 全局的,再轮一张自定义封面 —— 与 B 站的直播间同一份规矩;游标键跟着人走(决策 73)。
				liveCover: (sub, settings) => {
					const identity = subscriptionIdentityOf(sub);
					return rotateLiveCover(
						settings.liveCoverImageIds,
						globals().defaults.cards.liveCoverImageIds,
						pickExistingCardBg,
						`${identity.sourceKey}:${identity.externalId}:live-cover`,
					);
				},
				sourceStatus,
				avatarRef: (id) => opts.subscriptionStateStore.get(id)?.cachedProfile?.avatar,
				recap: {
					collector: viewerChats,
					wordcloud: wordcloudGenerator,
					summary: summaryRequester,
				},
				sendFor: (id) => boundLivePush(push, id),
				renderer: () => (globals().defaults.cards.enabled ? imageRenderer : null),
			}),
		);
		// 来源报上来的观众互动(R4 甲):特别弹幕、特别进场、醒目留言按这条订阅现折的设置判,发送绑到这条订阅上;
		// 下播回顾的弹幕收集归核心这一份(场次开了登记、结束清掉)。
		const interactions = createLiveInteractions({
			logger: coreLiveCtx.logger,
			subscription: (id) => opts.subscriptionStore.findById(id),
			settings: (sub) => liveSettingsOf(sub, globals()),
			sourceStatus,
			table: liveTable,
			profileName: (id) => opts.subscriptionStateStore.get(id)?.cachedProfile?.name,
			identityLabel: (identity) => subscriptionIdentityLabelOf(identity, labelDeps),
			profileAvatar: (id) => opts.subscriptionStateStore.get(id)?.cachedProfile?.avatar,
			source: (sourceKey) => opts.sources.get(sourceKey),
			gates: sourceGates,
			renderer: () => (globals().defaults.cards.enabled ? imageRenderer : null),
			fetchImage: (url) => opts.imageFetcher.fetchImage(url),
			readImage: opts.readImage,
			sendFor: (id) => boundLivePush(push, id),
			sessions: liveSessions,
			collector: viewerChats,
			serviceCtx: coreLiveCtx,
		});
		handles.push(interactions);
		liveInteractionEngine = interactions;
	}

	// 订阅删了:关于它的问题跟着清(宿主在清,不补「已恢复」)。表是总线的消费者,不是转发器 ——
	// `problems-changed` 不会再翻回 `subscription-changed`。
	handles.push(
		opts.bus.on("subscription-changed", ({ ops }) => {
			for (const op of ops) {
				if (op.kind === "remove") opts.problems.clearSubscription(op.sub.id);
			}
		}),
	);
	// ---------- Connection probe ----------
	// 后台连通探测与结果回写住 `push/connection-probe-engine.ts`;这里只接线。
	// 写回登记进 track:关停等这笔写交进 config 写道。
	const connectionProbe = createConnectionProbeEngine({
		getConnections: () => opts.configStore.getConnections(),
		dispatcher,
		recordProbeState: (id, state) => opts.configStore.recordConnectionProbeState(id, state),
		problems: opts.problems,
		masterConnectionId: () => masterTarget()?.connectionId,
		adapterOf: (adapterKey) => opts.adapters.list().find((a) => a.adapterKey === adapterKey),
		serviceCtx: opts.serviceCtx,
		logger: log,
	});

	// config-changed:globals handler 的「上次已应用的 globals」快照。用来 diff 出本次
	// 实际改了哪些 section,只热更受影响的子系统 —— 否则改 AI 人设也会重排
	// 健康检查定时器(无谓扇出 + 日志噪音)。
	let prevGlobals = initialGlobals;

	// 链接卡(群里贴链接自动出的那张)的呈现与开关。呈现就是全局那套皮肤。做成随
	// config-changed 刷新的快照 ——
	// 群里每句带链接的话都要读开关,而 `globals()` 是整份深拷贝,不该按条付这个钱。
	const linkCardViewOf = (g: GlobalConfig) => ({
		settings: g.linkPreview,
		// 链接卡没有 UP 可言,吃的就是全局那套皮肤(与推送动态卡在没有 per-UP 覆盖时同源)。
		cardSkin: g.defaults.cardSkin,
	});
	let linkCard = linkCardViewOf(initialGlobals);
	// 逐群答案从默认行 + 例外 + 目标表 + 连接表算出来,三者任一变了都重算(见接口上的说明)。
	const linkPoliciesOf = () =>
		resolveLinkPreviewPolicies({
			settings: linkCard.settings,
			targets: opts.configStore.getTargets(),
			connections: opts.configStore.getConnections(),
		});
	let linkPolicies = linkPoliciesOf();

	handles.push(
		opts.bus.on("config-changed", ({ scope }) => {
			if (scope === "connections") {
				linkPolicies = linkPoliciesOf();
				// 有状态 adapter(OneBot ws / ws-reverse)自己订了这一档、自己对账(登记即 `start(ctx)`,
				// 见 `push/builtin-adapters.ts`),引擎不替它们对账。
				//
				// 刻意不在这里触发连接探测:probe 经 recordConnectionProbeState 写回
				// probeState 会再 emit config-changed:connections → 死循环。adapter
				// 连通状态由 connectionProbe 的定时轮询刷新(或用户点"测试"立即刷)。
				// 只做设置合不合法的记账(不探测、不写盘,同一句不重复报),新填的设置不用等下一轮。
				connectionProbe.checkSettings();
				return;
			}
			if (scope === "globals" || scope === "targets") {
				// targets 也可能影响 master 解析(被引用的 target 删了 / 改了元数据)。
				// 单独一行先 push,避免后续 globals-only 路径未执行时漏掉。
				push.setMaster(masterTarget() ?? null);
				if (scope === "targets") {
					linkPolicies = linkPoliciesOf();
					return;
				}
			}
			if (scope === "globals") {
				const g = globals();
				const prev = prevGlobals;
				prevGlobals = g;
				linkCard = linkCardViewOf(g);
				linkPolicies = linkPoliciesOf();
				// 只热更本次真正改了的 section,避免编辑一个模块扇出到其它模块。
				//
				// `eq` 用 JSON.stringify 比较,**键序敏感** —— 它依赖「globals 永远是 zod
				// parse 的规范形态」这一不变式。该不变式由 ConfigStore 保证:写路径的
				// `parsed.data` 天然规范,而 `hydrateSecrets()` 往内存里注水 apiKey 后会
				// 重新 parse 一次把键序归位(它曾经不这么做,导致重启后第一次改**任何**字段
				// 都把 ai 误判成变了 → 白白热重载 AI)。往 globals 里塞键的新代码
				// 必须维持这个不变式,否则这里会静默产生假阳性。
				const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
				// 内置人格的内容跟着语言走:只换语言(ai 没动)常驻生成器也要换成新语言的人格。
				const aiChanged =
					!eq(prev.ai, g.ai) || textSettingsOf(prev).locale !== textSettingsOf(g).locale;
				const cardStyleChanged = !eq(prev.defaults.cards, g.defaults.cards);
				// 旋钮拧一格与换皮肤同一档:出图立刻变个样。只喂渲染器的 config(旋钮不
				// 参与 per-sub 快照 —— 它按皮肤 id 存,全局一份)。
				const skinKnobsChanged = !eq(prev.defaults.cardSkinKnobs, g.defaults.cardSkinKnobs);

				// 日志等级(`logging.level` / `logging.levels`)不在这里推:由入口的 `bindLogLevels` 整张推。
				// 粉丝轮询的 cron 是顶层的 `profileRefreshCron`,同样不在这里。
				// B 站那两格(cron / 健康检查间隔)在 B 站自己的设置里:cron 由 B 站来源自己听,健康检查间隔由登录系统(`bilibili/auth/`)自己听。
				// ImageRenderer 热更(仅在已构造时有意义)。配色 / 字体 / 数据区显示项都已经
				// 退役成皮肤旋钮,这里只剩旋钮那一份要送下去。
				if ((cardStyleChanged || skinKnobsChanged) && imageRenderer) {
					imageRenderer.updateConfig({
						cardSkinKnobs: g.defaults.cardSkinKnobs,
					});
				}
				if (aiChanged) {
					// AI 实例热重载:lazy 构造 + 配置失效降级 + 已存在时增量 updateConfig。
					// 直播引擎构造时 commentary 字段是 snapshot,新建/置空后必须通过 setCommentary
					// 把引用同步过去,否则永远沿用启动时的 null;作品装配经 `deps.ai()` 每条现取,不用同步。
					const a = g.ai;
					// 当前选中那份实例的连接是否配齐 —— 换实例也会走到这里(activeProfile
					// 指针本身就在 ai 里,变了就算 aiChanged)。
					const ap = resolveAIProfile(a);
					const needsCommentary = Boolean(ap.apiKey && ap.baseUrl);
					if (!needsCommentary && commentary) {
						commentary = null;
						liveSummaryRequester?.setCommentary(null);
					} else if (needsCommentary && !commentary) {
						commentary = buildCommentary();
						liveSummaryRequester?.setCommentary(commentary);
						if (commentary) log.info("[ai] commentary 已激活");
					} else if (commentary) {
						const next = buildAiConfig();
						commentary.updateConfig(next);
						liveSummaryRequester?.setCommentary(commentary);
						// 报**真正推给引擎的那份人格**(指针指的那份),不是 `a.persona` ——
						// 后者永远冻在老值上,照它打日志等于给排查的人指错方向。
						log.info(
							`[ai] commentary 配置已更新: profile=${a.activeProfile}(${ap.provider}), model=${ap.model}, persona.name=${next.persona.name}, traits=${next.persona.traits}`,
						);
					}
				}
				// 作品来源的名单(全局作品开关一翻要重算)不在这里:来源上下文自己听 `config-changed` 的 globals 一档
				// (`subscriptions/source-context.ts`),名单每次现算,来源自己对比。
				// 作品设置(模板 / 版式 / 皮肤 / 图集 / 过滤……)核心每条作品现折,改了立即生效,也不经这里。
			}
		}),
	);

	// ---------- Disposal ----------
	// 关停钩子(下方 onDispose(dispose))与测试都会调到 dispose:幂等守卫,避免对各 engine
	// .stop()/.dispose() 二次调用与重复 warn 噪音,再调交回同一个 promise。
	let disposed = false;
	let disposing: Promise<void> | undefined;
	const dispose = async (): Promise<void> => {
		if (disposing) return disposing;
		disposing = closeAll();
		return disposing;
	};
	const closeAll = async (): Promise<void> => {
		disposed = true;
		connectionProbe.dispose();
		clearInterval(cursorFlushTimer);
		flushCursors(); // 关停前把未落盘的游标推进写一次,重启续接

		// 来源先停(后登记的先停),再关作品入口:停下之后不许再上报。各来源的 `stop()` 在这个同步段里全部叫到,
		// 然后等全部在途的收尾落定(来源的 `stop()` 途中报的作品照收),才往下关作品入口。
		for (const registration of sourceRegistrations.splice(0).reverse()) {
			try {
				registration.dispose();
			} catch (e) {
				log.warn(`[engines] source dispose failed: ${errorMessageOf(e)}`);
			}
		}
		await Promise.all(sourceClosings);
		for (const h of handles.splice(0)) {
			try {
				h.dispose();
			} catch {
				// best-effort
			}
		}
		try {
			push.stop();
		} catch (e) {
			log.warn(`[engines] push.stop failed: ${String(e)}`);
		}
		try {
			masterNotifier.dispose();
		} catch (e) {
			log.warn(`[engines] masterNotifier.dispose failed: ${String(e)}`);
		}
		try {
			problemNotifier.dispose();
		} catch (e) {
			log.warn(`[engines] problemNotifier.dispose failed: ${String(e)}`);
		}
	};
	opts.serviceCtx.onDispose(dispose, "stop");
	return {
		registerSource: async (entry) => {
			const registration = await registerBuiltinSource({
				...entry,
				// 来源的登录状态变了 → 总线上一条 `subscription-auth-changed`(宿主订阅、宿主发,来源拿不到总线)。
				onAuthChanged: (state) =>
					opts.bus.emit("subscription-auth-changed", { sourceKey: entry.sourceKey, state }),
				registry: opts.sources,
				linkResolvers: opts.linkResolvers,
				aiToolProviders: opts.aiToolProviders,
				subscriptions: opts.subscriptionStore,
				defaults: () => globals().defaults,
				bus: opts.bus,
				enqueue: (event) => postQueue.enqueue(event),
				// 没接拓展订阅的直播(没有场次引擎)时来源报直播是接线漏了:丢弃并记 error,不静默吞。
				liveSignals: (signal) => {
					if (!liveSessionEngine) {
						coreLiveCtx.logger.error(
							`[engines] 没有场次引擎,${signal.identity.sourceKey} 报的直播 ${signal.kind} 丢弃`,
						);
						return;
					}
					liveSessionEngine.apply(signal);
				},
				liveInteractions: (subscriptionId, report) => {
					if (!liveInteractionEngine) {
						coreLiveCtx.logger.error(
							`[engines] 没有直播互动入口,订阅 ${subscriptionId} 的直播互动 ${report.kind} 丢弃`,
						);
						return;
					}
					liveInteractionEngine.apply(subscriptionId, report);
				},
				profiles: (subscriptionIds, report) => opts.profileReports.report(subscriptionIds, report),
				problems: opts.problems,
			});
			// 登记途中 `dispose()` 已跑完:关停那一遍没收到这个把手,来源却已起来 —— 当场收掉,别留孤儿。
			if (disposed) {
				await registration.dispose();
				throw new Error("registerSource: 引擎装配已关停,来源登记作废");
			}
			// 撤登记幂等:拓展收摊时自己撤,引擎关停再兜底收一遍,第二遍什么都不做。
			let revoked = false;
			const revocable: Disposable = {
				dispose() {
					if (revoked) return;
					revoked = true;
					const at = sourceRegistrations.indexOf(revocable);
					if (at !== -1) sourceRegistrations.splice(at, 1);
					// 收尾记进 `sourceClosings`,关停时等它;把手同步返回、不等(拓展那头发了就不管)。
					const closing = registration.dispose().catch((e: unknown) => {
						log.warn(`[engines] source dispose failed: ${errorMessageOf(e)}`);
					});
					sourceClosings.add(closing);
					void closing.then(() => sourceClosings.delete(closing));
				},
			};
			sourceRegistrations.push(revocable);
			// 重启之后来源登记完:它名下要监听、手里没场次的订阅问一次,在播就认出一场(来源没实现拉取式则什么都不做)。
			liveSessionEngine?.pollUnseen(entry.sourceKey);
			return revocable;
		},
		fallbackCreatorName: (identity) =>
			displayNameOf(
				{
					profileName: opts.subscriptionStore
						.listByIdentity(identity)
						.map((sub) => opts.subscriptionStateStore.get(sub.id)?.cachedProfile?.name)
						.find((name) => name !== undefined && name.trim() !== ""),
				},
				subscriptionIdentityLabelOf(identity, labelDeps),
			),
		push,
		muteState,
		subscriptionStore: opts.subscriptionStore,
		fetchProfile,
		searchCreators,
		// getter,理由同下面的 `imageRenderer` —— 这也是个会被热重载重新赋值的 let。
		// 写成普通属性的话它就是**启动那一刻的值拷贝**:没配 AI 起的服务永远是 null,
		// 主人在设置页补上 apiKey 后热重载确实把实例建起来了,可读这个字段的聊天路由还是拿到 null,
		// 于是「保存成功却照样报『还没填齐』,重启才好」。反向亦然:撤掉密钥后它会
		// 攥着已 stop 的旧实例继续答话。
		get commentary() {
			return commentary;
		},
		setCommentary(next) {
			commentary = next;
			liveSummaryRequester?.setCommentary(next);
		},
		setImageRenderer(next) {
			imageRenderer = next;
		},
		// getter:`imageRenderer` 是个会被热切换重新赋值的 let,取值必须每次现读。
		get imageRenderer() {
			return imageRenderer;
		},
		viewerChatStats: () => viewerChats?.stats() ?? { subscriptions: 0, words: 0, senders: 0 },
		liveSession: (subscriptionId: string) => liveSessionEngine?.get(subscriptionId),
		tickLiveSessionNow: (subscriptionId: string) =>
			liveSessionEngine?.tickNow(subscriptionId) ?? Promise.resolve(false),
		extensionPlatformLabel: (extensionId: string) => opts.extensionPlatformLabel?.(extensionId),
		extensionPostNoun: (extensionId: string) => opts.extensionPostNoun?.(extensionId),
		probeConnection: (connectionId: string) =>
			connectionProbe.probe(connectionId, { manual: true }),
		connectionCapabilities: (connectionId: string) =>
			dispatcher.connectionCapabilities(connectionId),
		probeConnectionCapabilities: (connectionId: string) =>
			dispatcher.probeConnectionCapabilities(connectionId),
		listAddressCandidates: (connectionId, scope, signal) =>
			dispatcher.listAddressCandidates(connectionId, scope, signal),
		sendToAddress: (connectionId, session, payload) =>
			dispatcher.sendToAddress(connectionId, session, payload),
		linkPreview: () => linkCard.settings,
		linkPolicyFor: (key: string) => linkPolicies.policyFor(key),
		linkCardPresentation: () => ({
			cardSkin: linkCard.cardSkin,
		}),
		getModuleState: (): ModuleState => {
			const g = globals();
			// "live ready" = 至少一条启用的订阅会开直播间监听,且它的来源实现了直播:问的是 internal 里那份唯一判定
			// (只看折好的开关与特别关注名单,不看有没有推送目标;特别关注要「开关 ∧ 名单上有人带它」;ADR-0027 决策 1)。
			const liveReady = opts.subscriptionStore.list().some(
				(sub) =>
					sub.enabled &&
					needsLiveMonitor({
						features: resolve(sub, g.defaults).features,
						specialViewers: sub.specialViewers,
					}) &&
					sourceHasLive(subscriptionIdentityOf(sub).sourceKey),
			);
			return {
				dynamic: true,
				live: liveReady,
				image: imageRenderer !== null && g.defaults.cards.enabled,
				ai: commentary !== null && g.ai.enabled,
			};
		},
		enableImageRendering: (pup: PuppeteerLike): boolean => {
			if (imageRenderer) return false; // 幂等:已启用,不重复构造浏览器
			imageRenderer = buildImageRenderer(pup);
			return true;
		},
		// 热切换浏览器来源(dashboard 改 chromePath / chromeEndpoint):无条件重建
		// renderer 并重新注入两个引擎。旧 adapter 的 dispose 由调用方(cards 路由)
		// 负责 —— 引擎层不持有 adapter,只消费 renderer。
		swapImageRendering: (pup: PuppeteerLike): void => {
			imageRenderer = buildImageRenderer(pup);
		},
		dispose,
	};
}
