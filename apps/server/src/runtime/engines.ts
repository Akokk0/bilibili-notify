/**
 * Server-side engine wiring: the engines from apps/server/src/bilibili/dynamic + apps/server/src/bilibili/live,
 * driven by the file-backed ConfigStore + TargetDispatcher.
 *
 * Construction order:
 *
 *   1. Bind SubscriptionStore to ConfigStore
 *   2. Build TargetDispatcher (subscribers: HistoryStore via onDelivery)
 *   3. Construct PushRouter({ dispatcher, store, master })
 *   4. Optionally construct CommentaryGenerator (when apiKey + baseUrl set; the
 *      `enabled` flag is enforced at engine-config gating layer in step 5/6)
 *   5. Construct LiveEngine with PushLike adapters (post sources are registered later through
 *      `registerSource`: the source builds its own engine and gets a source context)
 *   6. Wire subscription-changed → live.applyOps; auth-restored → engine reseed
 *   7. Wire config-changed (globals scope) → LiveEngine.updateConfig
 *
 * Engine-stop is registered with serviceCtx.onDispose; the runtime's dispose()
 * propagates correctly.
 */

import { readFileSync } from "node:fs";
import type { CommentaryCallOverride } from "@bilibili-notify/ai";
import { CommentaryGenerator, webSearchExecutorFromSettings } from "@bilibili-notify/ai";
import type { LiveListenerSnapshot, ModuleState } from "@bilibili-notify/contract";
import { type CardColorOptions, ImageRenderer, type PuppeteerLike } from "@bilibili-notify/image";
import type {
	ActivePersonaShape,
	AddressCandidate,
	AISettings,
	CardKind,
	CardSkinManifest,
	ConnectionCapabilities,
	DeliveryResult,
	Disposable,
	EffectiveSubscription,
	FeatureKey,
	GlobalConfig,
	Identity,
	ImageRef,
	LinkParsingConfig,
	LinkParsingPolicy,
	Logger,
	MembershipTemplateBundle,
	NotificationPayload,
	PayloadSegment,
	ProbeResult,
	PushTarget,
	PushTargetScope,
	Result,
	SessionRef,
	Subscription,
	SubscriptionOp,
	TargetReachability,
	TemplateBundle,
} from "@bilibili-notify/internal";
import {
	BILIBILI_SOURCE_KEY,
	DEFAULT_TEMPLATES,
	GUARD_PROGRAM_ID,
	isReachabilityEvidence,
	resolve,
	resolveAIProfile,
	resolveSubscriptionPersona,
	type SourceAuth,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import { type Push, type PushAnchor, PushRouter } from "@bilibili-notify/push";
import { atomicWriteJsonSync } from "@bilibili-notify/storage";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import { attachReadOnlyTools, type ExtensionLiveSource } from "../ai/read-only-tools.js";
import type { Api } from "../bilibili/api/index.js";
import { resolveDynamicColorOptions } from "../bilibili/dynamic/index.js";
import type { ImagesDeps } from "../bilibili/images.js";
import type { GuardIcons } from "../bilibili/live/guard-icons.js";
import {
	LiveEngine,
	type LiveEngineConfig,
	type LiveNotifySend,
	type PushLike as LivePushLike,
	type LiveSubscriptionOp,
	type SubscriptionsView as LiveSubsView,
	type SubItemView as LiveSubView,
	rotateLiveCover,
} from "../bilibili/live/index.js";
import type { ConfigStore } from "../config/store.js";
import type { ReportDiscrepancy } from "../extensions/context.js";
import type { HistoryStore } from "../history/store.js";
import type { ImageWriter } from "../images/image-store.js";
import { createCardFailureTracker, type PostSettings } from "../posts/deliver-post.js";
import { bindExtensionPosts } from "../posts/extension-post.js";
import type { PostPushAnchor, PushSegment } from "../posts/post-push.js";
import { createPostQueue } from "../posts/post-queue.js";
import type { PlatformAdapterRegistry } from "../push/registry.js";
import { createTargetDispatcher, type SendInterceptHandler } from "../push/target-dispatcher.js";
import {
	type RegisterBuiltinSourceOptions,
	registerBuiltinSource,
} from "../subscriptions/builtin-sources.js";
import type { SourceRegistry } from "../subscriptions/registry.js";
import { createSourceStatusReader } from "../subscriptions/source-status.js";
import { errorMessageOf } from "../util/error-message.js";
import { toGeneratorConfig } from "./ai-config.js";
import {
	CARD_BG_CURSORS_FILE,
	makeExistingCardBgPicker,
	readCardBgDataUrl,
} from "./card-assets.js";
import { type CardBgRotator, createCardBgRotator } from "./card-bg-rotation.js";
import { segmentContentBuilder, segmentToPayload } from "./content-builder.js";
import type { ExtensionLiveTable } from "./extension-live.js";
import { bindExtensionLivePush } from "./extension-live-push.js";
import {
	createExtensionLiveSessions,
	type ExtensionLiveSession,
	type ExtensionLiveSessions,
} from "./extension-live-sessions.js";
import type { ExtensionSourceReader } from "./extension-push-common.js";
import { followTargetSubscriptions, syncFollows } from "./follow-sync.js";
import { resolveLinkParsingPolicies } from "./link-scope.js";
import { MasterNotifier } from "./master-notifier.js";
import { createMuteState, type MuteState } from "./mute-state.js";
import {
	historyRecordFromFilteredPost,
	historyRecordFromSend,
	type PushHistoryReader,
} from "./push-history.js";
import { dataPath } from "./roots.js";
import type { NodeServiceContext } from "./service-context.js";
import type { SubRuntimeStore } from "./sub-runtime-store.js";

export interface EnginesRuntime extends Disposable {
	/** 登记一个内置来源(建它的来源上下文、登记即 start)。关停时引擎自己先停掉登记过的来源,再关作品入口。 */
	registerSource(
		entry: Pick<RegisterBuiltinSourceOptions, "sourceKey" | "source" | "integration">,
	): Promise<void>;
	readonly live: LiveEngine;
	readonly push: PushRouter;
	/**
	 * 全局静音。`push` 已经接了闸(订阅推送在 `PushRouter.push` 交进来时被挡),
	 * 这里暴露出来是给指令与面板改状态用的。
	 */
	readonly muteState: MuteState;
	readonly subscriptionStore: SubscriptionStore;
	readonly commentary: CommentaryGenerator | null;
	/** Started Api; consumed by routes that need ad-hoc B-station calls (e.g. subs lookup). */
	readonly api: Api;
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
	/** Currently-broadcasting rooms; powers /api/live/listening. */
	listLiveRooms(): LiveListenerSnapshot[];
	/**
	 * 拓展订阅此刻那一场(ADR-0020 决策 6,场次模块 `extension-live-sessions.ts` 手里的):没在播、或没接
	 * 拓展订阅的直播(只测 B 站那几条路的引擎)是 `undefined`。统计页拿它判拓展行「此刻在播」—— 与盘上那一场
	 * 敞着的同源(开一场、关一场的帧都是它发的),断流等待里也还算在播,同 B 站直播间在等待期里仍是在播。
	 */
	extensionLiveSession(subscriptionId: string): ExtensionLiveSession | undefined;
	/**
	 * 拓展订阅的平台名(清单里订阅源的叫法 → 拓展名),每次现取 —— 与女仆查订阅那份视图同一口
	 * ({@link CreateEnginesOptions.extensionPlatformLabel})。锐评的「平台」一列用它(ADR-0020 决策 12)。
	 * 取不到(没接 / 没装 / 开机途中)是 `undefined`,调用方退拓展 id。
	 */
	extensionPlatformLabel(extensionId: string): string | undefined;
	/** 链接解析的开关与冷却 —— 随 config-changed 刷新的快照;群里每句话都会问它。 */
	linkParsing(): LinkParsingConfig;
	/**
	 * 链接解析里某个群的答案:解不解析、回什么(键与表见 `link-scope.ts`)。表随 globals /
	 * targets / connections 三种 config-changed 重算 —— 例外引用的是目标,目标或连接停用、
	 * 删掉都会改变答案,只盯 globals 的话面板上开着、实际却还在按旧目标表解析。
	 */
	linkPolicyFor(key: string): LinkParsingPolicy;
	/**
	 * 链接卡的呈现 = 推送的动态卡在没有 per-UP 覆盖时的呈现:全局「动态」样式(含图廊
	 * 轮换,**每调一次推进一次游标**)+ 全局那套皮肤。每张卡调一次,别攥着。
	 */
	linkCardPresentation(): { colors: CardColorOptions | undefined; cardSkin: string };
	/**
	 * Out-of-band reachability probe for `/api/connections/:id/probe`. 顺路把还没探出来的平台
	 * 能力再探一次(与定时健康探测同一条路)。
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
	 * uses `forSubsystem(name, level)` to give each engine its own pino instance
	 * driven by globals.logging.levels.{bilibili,image,ai}. The server
	 * runtime constructs the parent context once at boot.
	 */
	serviceCtx: NodeServiceContext;
	/** 数据根(`AppRuntime.dataRoot`):背景图资产与轮换游标住在它底下。 */
	dataRoot: string;
	/**
	 * 自带字体的读取口(`AppRuntime.loadFontFace`)。刻意由外面传进来而不是自建:
	 * 缓存里留的就是那条几十兆的 `@font-face`,建两个就在堆里存两遍。
	 */
	loadFontFace: (id: string) => Promise<string>;
	api: Api;
	/**
	 * B 站的登录口(`AuthSystem.auth`)的读面。开机关注同步那道门读它;不从来源登记表读,因为引擎装配建好的这一刻
	 * 来源还没登记(登记在 `compose.ts`,晚于这里)。
	 */
	auth: Pick<SourceAuth, "state">;
	configStore: ConfigStore;
	historyStore: HistoryStore;
	subscriptionStore: SubscriptionStore;
	/**
	 * Display-cache source for uname/uavatar (history snapshot + engine sub
	 * views). cachedProfile was externalized out of `Subscription`, so the
	 * config subs from subscriptionStore no longer carry it — read it here.
	 */
	subRuntimeStore: SubRuntimeStore;
	/** 订阅来源登记表(`AppRuntime.sourceRegistry`);来源由 `registerSource` 登进去。 */
	sources: SourceRegistry;
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
	/**
	 * 拓展订阅推送要从外面现取的几样(ADR-0019 决策 54 / 61 / 70):拓展在不在跑、平台对作品的叫法、
	 * 清单里声明的事件。装载器比引擎晚建起来,装卸也随时发生,都现取。
	 *
	 * 不给 = 不接拓展订阅的推送(只测 B 站那几条路的引擎)。独立端恒给。
	 */
	extensionSources?: ExtensionSourceReader;
	/**
	 * 拓展作品的配图、封面、事件带来的头像往图库存的口(`AppRuntime.postImages`,ADR-0021 决策 22 下的 ㉑d):
	 * 作品卡是 `Post`,图只收图库引用。**给了 `extensionSources` 就必须给** —— 漏给是开机直接抛,不是悄悄不出图。
	 */
	postImages?: Pick<ImageWriter, "put">;
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
	/**
	 * 拓展订阅的在播表(`runtime.extensionLive`,ADR-0019 决策 57 / 64):拓展直播的计时器拿它当「最新状态」,
	 * 女仆查直播状态也从它答。与 `extensionSources` 一起给才接拓展订阅的直播。
	 */
	extensionLive?: Pick<ExtensionLiveTable, "get">;
	/**
	 * 拓展直播的封面与事件带来的作者头像往图库存的口(`AppRuntime.liveImages`,ADR-0021 决策 22 / 24 下 2026-10-05
	 * 的 🔗,㉒c):直播卡是中立输入,图只收图库引用。**给了 `extensionSources` 与 `extensionLive` 就必须给** ——
	 * 漏给是开机直接抛,不是悄悄不出图。
	 */
	liveImages?: Pick<ImageWriter, "put">;
	/**
	 * 大航海徽章图标(`AppRuntime.guardIcons`,3a-33):B 站的上舰卡按档取图库引用。必给 —— 漏给上舰卡的徽章块静默收起。
	 * 开机时调一次 `ensure()` 抓图(不等它),直播间出卡前再补一次。
	 */
	guardIcons: GuardIcons;
	/**
	 * B 站作品图 / 直播封面的抓图服务(用 B 站接口那个请求客户端、`AppRuntime.postImages` 这一家引用方建的,接线层给):
	 * 出卡前把图抓进图库(3a-34)。必给 —— 漏给是编译不过,不是悄悄不出图。
	 */
	imageFetcher: ImagesDeps["images"];
	/**
	 * 拓展详情页的「上报出入」框(ADR-0019 决策 60 / 61):拓展直播的周期推送因为没有新状态跳过的那一轮
	 * 记进去。不给就只记日志。
	 */
	onReportDiscrepancy?: (discrepancy: ReportDiscrepancy) => void;
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
	// Per-module sub-contexts. Subsystem level falls back to `logging.level`
	// when its module-specific override is absent (schema doc spells this out).
	// Pino levels are mutable, so `config-changed: globals` later pushes new
	// levels onto these instances without a server restart.
	const initialGlobals = opts.configStore.getGlobals();
	const resolveLevel = (g: GlobalConfig, key: string): string =>
		g.logging.levels[key] ?? g.logging.level;
	// 动态与直播两个 B 站引擎共用日志等级表里的一个键(来源键),各自仍是自己的子上下文。
	const bootSourceLevel = resolveLevel(initialGlobals, BILIBILI_SOURCE_KEY);
	const dynamicCtx = opts.serviceCtx.forSubsystem("dynamic", bootSourceLevel);
	const liveCtx = opts.serviceCtx.forSubsystem("live", bootSourceLevel);
	const aiCtx = opts.serviceCtx.forSubsystem("ai", resolveLevel(initialGlobals, "ai"));
	const imageCtx = opts.serviceCtx.forSubsystem("image", resolveLevel(initialGlobals, "image"));
	const globals = (): GlobalConfig => opts.configStore.getGlobals();

	// Base logger boot reconcile. bootstrap.logLevel (BN_LOG_LEVEL / --log-level
	// / bn.config logLevel) only governs the pre-engines early window (config
	// load + bootstrap, before the core settings are applied). From engines-up onward
	// the base logger is the "core" module bucket — every non-engine log
	// (push / dispatcher / master-notifier / fans-poller / routes / config / history /
	// ws) goes through it, so it follows `logging.levels.core ?? logging.level` just
	// like the subsystem ctxs follow their own keys. Apply once here so it does
	// NOT wait for the first config-changed. Mirrors the change-path apply below.
	opts.serviceCtx.setLevel(resolveLevel(initialGlobals, "core"));

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
				profile: opts.subRuntimeStore.get(subscription.id)?.cachedProfile,
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
		quietHoursNow: opts.quietHoursNow,
		onSend: (info) => {
			// 一次推送 × 一个目标 = 历史一行;无目标那次也记(面板上才看得见)。
			const input = historyRecordFromSend(info, historyReader);
			if (input) recordHistory(input);
		},
	});
	push.start();

	/**
	 * B 站直播引擎说的是 uid,推送链认的是订阅自己(ADR-0019 决策 50)—— 直播适配器在这条边上先翻一次,
	 * 遗留重复订阅只取先出现的那条(作品那一半已按身份展开,在来源上下文里,直播随 3b)。
	 */
	const subscriptionIdOfUid = (uid: string): string | undefined => {
		const sub = opts.subscriptionStore.findByIdentity(biliIdentity(uid));
		if (!sub) log.debug(`[push] uid=${uid} 无订阅记录，跳过`);
		return sub?.id;
	};

	// ---------- Master notifier ----------
	// engine-error / auth-lost → 主人 OneBot 私聊。共用一张 per-source 60s 节流表。
	// Web dashboard 上同样会通过 AlertShell 看到 engine-error;两路通道互不影响。
	const masterNotifier = new MasterNotifier({
		bus: opts.bus,
		push,
		logger: log,
		serviceCtx: opts.serviceCtx,
	});
	masterNotifier.install();

	// ---------- AI (optional) ----------
	// 构造仅依赖 apiKey / baseUrl 是否齐备 —— 与 `enabled` 解耦,后者交给引擎 config 层
	// 的 aiEnabled flag 在每次推送前热判断。这样用户在 dashboard 把 AI 开关切关再切开
	// 不需要重启服务。完整字段变更则走下方 `rebuildCommentary` 重建实例。
	//
	// `AISettings` → CommentaryGeneratorConfig 的翻译(含字段改名与「人格看指针」)
	// 本体在 `./ai-config.ts` —— 「试一句」与统计页的锐评用的是同一份映射,人格该
	// 从哪儿读只能有一个答案。指针指向一个还没添加的服务商时 resolveAIProfile 兜一套
	// 空值回来,下方 buildCommentary 的 `!p.apiKey || !p.baseUrl` 就会照既有规矩停用 AI。
	const buildAiConfig = () => toGeneratorConfig(globals().ai);

	const extensionLiveSource = (): ExtensionLiveSource | undefined => {
		const table = opts.extensionLive;
		const sources = opts.extensionSources;
		if (!table || !sources) return undefined;
		return { row: (id) => table.get(id), running: (id) => sources.running(id) };
	};

	let commentary: CommentaryGenerator | null = null;
	const buildCommentary = (): CommentaryGenerator | null => {
		const p = resolveAIProfile(globals().ai);
		if (!p.apiKey || !p.baseUrl) return null;
		try {
			const c = new CommentaryGenerator({
				serviceCtx: aiCtx,
				api: opts.api,
				config: buildAiConfig(),
			});
			// 接工具能力 —— **只读档**。少了这一步,女仆连「我订了哪些 UP」都查不到,
			// 会一口咬定「当前没有订阅」;带上写能力则等于让她能真的加减订阅。
			// 两种都不是我们要的,取舍写在 attachReadOnlyTools 的文档里。
			attachReadOnlyTools(c, {
				subscriptionStore: opts.subscriptionStore,
				subRuntimeStore: opts.subRuntimeStore,
				platforms: { label: (id) => opts.extensionPlatformLabel?.(id) },
				// 女仆查直播状态对拓展订阅从在播表答(决策 64 的 🔗);拓展没在跑时 BN 手里没有它的在播状态。
				extensionLive: extensionLiveSource(),
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
	// DynamicEngine / LiveEngine via the `imageEnabled` config field; when false
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
	// pick 在推送点(room-session / DynamicEngine)同步推进;脏标记驱动定时 flush,避免每
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
	const sourceStatus = createSourceStatusReader({
		sources: opts.sources,
		extensions: opts.extensionSources,
	});

	// 出图连续失败「只提醒一次」的计数(ADR-0019 决策 66):B 站动态与拓展作品用的是同一个渲染器,
	// **全进程一份**,两条路各记各的话同一次故障会各提醒一遍。
	const cardFailures = createCardFailureTracker();

	// 卡上的主播头像:订阅 id → 订阅资料里的头像引用。**每次出卡现读**,所以资料之后补上 / 换掉的头像不用重启就跟上。
	const profileAvatarOf = (subscriptionId: string): ImageRef | undefined =>
		opts.subRuntimeStore.get(subscriptionId)?.cachedProfile?.avatar;

	const extensionSources = opts.extensionSources;
	const postQueue = createPostQueue({
		logger: dynamicCtx.logger,
		bus: opts.bus,
		serviceCtx: opts.serviceCtx,
		deps: {
			logger: dynamicCtx.logger,
			settings: makePostSettingsReader({
				subscription: (id) => opts.subscriptionStore.findById(id),
				globals,
				// 「来源还在跑吗」:登记表里有它(内置来源),或拓展订阅的拓展在跑(决策 61:拓展停了,等着的作品不补);
				// 没接拓展订阅(`extensionSources` 没给)的拓展键就一律不推。
				sourceRunning: (sub) => sourceStatus.running(subscriptionIdentityOf(sub).sourceKey),
			}),
			// 渲染器与 AI 会被热换:**必须是读外层 let 的闭包**,按值传就是「开机时没有浏览器,之后一直没有卡片」而门禁全绿。
			image: () => imageRenderer ?? undefined,
			ai: () => commentary ?? undefined,
			cardFailures,
			avatar: profileAvatarOf,
			readImage: opts.readImage,
			push: (subscriptionId, anchors) => boundPostPush(push, subscriptionId)(anchors),
			recordFiltered: recordFilteredPost,
			sendErrorMsg: masterTellers(push, log).sendErrorMsg,
			// 单列一个来源:主人私聊的 60 秒节流按来源算,与 B 站动态引擎的告警(风控之类)共用一个的话,
			// 一边刚报过,另一边这次出图失败的告警就被吞了。B 站与拓展两条路现在共用这一个。
			emitEngineError: (message) =>
				opts.bus.emit("engine-error", { source: "post-delivery", message }),
		},
	});

	// 登记过的内置来源的撤销把手(`registerSource`);关停时先于作品入口收。
	const sourceRegistrations: Disposable[] = [];

	/**
	 * 确保所有订阅的 UP 都已在 B 站被关注 —— 动态走 `feed/all`(关注流),没关注就一条
	 * 都收不到。独立端此前**从不** follow(只有当年的 koishi 插件做),所以存量订阅全是收不到
	 * 动态的哑订阅。见 `follow-sync.ts`。
	 *
	 * best-effort:失败不阻断引擎启动,状态会落进 SubRuntimeStore 让前端显示「未关注」,
	 * 下次 auth-restored 再试。
	 */
	const runFollowSync = (reason: string, only?: ReadonlySet<string>): void => {
		// 长跑(逐个订阅补关注、中间有 300ms 间隔):登记进 track 让关停等它写完状态,
		// 同时把 signal 交给它 —— 关停一开始它就停在当前这一个,不靠预算硬等。
		opts.serviceCtx.track(
			syncFollows({
				api: opts.api,
				subs: () => opts.subscriptionStore.list(),
				defaults: () => globals().defaults,
				...(only ? { only } : {}),
				rt: opts.subRuntimeStore,
				logger: log,
				signal: opts.serviceCtx.signal,
			}).then(
				() => undefined,
				(e: unknown) => {
					log.warn(
						`[follow] 关注同步(${reason})失败: ${e instanceof Error ? e.message : String(e)}`,
					);
				},
			),
		);
	};
	// 启动时只在已登录时补一遍。未登录时关系查询回 -101、逐个补关注也全是 -101:白打 B 站,
	// 还把每条订阅标成「未关注」。开机时登录状态已探完(createAuthSystem 等过探活);未登录时
	// LoginFlow 记下了 needsRestore,扫码登录后发 auth-restored,由下面那条补上。
	// `confirming`(开机没确认上)不算登录,与从前判「已登录」一致。
	const biliLoggedIn = (): boolean => opts.auth.state().status === "logged-in";
	if (biliLoggedIn()) runFollowSync("boot");

	// 开关从关翻到开时补一次:「关了就不查」之后,没开作品的人没被关注;订阅被启用、它的作品开关被打开、全局作品开关被打开,
	// 都会让一些人变成需要关注的。靠对比「需要关注的 uid 集合」前后差,而不是盯着具体哪个字段变了 —— 订阅覆盖、全局默认、
	// 启用三条路走的是同一个判据(`followTargetSubscriptions`),差集只在真有人新变成需要关注时才非空,
	// 无关的设置保存 / 订阅编辑算出来是空差集,一个请求都不发(补关注是写接口,最招风控)。从开到关、停用:不取关,什么都不做。
	const followTargetUidsNow = (): Set<string> =>
		new Set(
			followTargetSubscriptions(opts.subscriptionStore.list(), globals().defaults).map(
				(s) => subscriptionIdentityOf(s).externalId,
			),
		);
	let followTargetUids = followTargetUidsNow();
	const syncNewFollowTargets = (justAdded: ReadonlySet<string>): void => {
		const next = followTargetUidsNow();
		// 新建的那条订阅由路由当场关注(要把结果带进响应),这里再补就是对同一个人重复发写请求。
		const flipped = new Set(
			[...next].filter((uid) => !followTargetUids.has(uid) && !justAdded.has(uid)),
		);
		followTargetUids = next;
		if (flipped.size === 0) return;
		// 没登录就不白打 B 站(与开机那一轮同一个判据);登录恢复那一轮是全量,会把它们补上。
		if (!biliLoggedIn()) return;
		runFollowSync("switch-on", flipped);
	};

	// ---------- LiveEngine ----------
	const livePushLike = makeLivePushLike(push, subscriptionIdOfUid, log);

	const liveConfig = (): LiveEngineConfig => {
		const g = globals();
		return {
			liveSummaryDefault: g.defaults.templates.liveSummary,
			// 全局弹幕词云额外停用词:引擎记词时 merge 到 bundled 列表(随 templatesChanged
			// 经 live.updateConfig → setStopwords 热更)。per-UP 覆盖另经 SubItemView 在
			// dispatch 时过滤。
			wordcloudStopWords: g.defaults.templates.wordcloudStopWords,
			imageEnabled: g.defaults.cards.enabled,
			aiEnabled: g.ai.enabled,
			aiWebSearch: g.ai.search.engines.live,
			guardTemplate: guardTemplateOf(g.defaults.templates),
			// 直播消息模板与动态模板一致:无开关,全局模板始终下发(默认值 ==
			// DEFAULT_LIVE_TEMPLATES,未编辑时输出不变;编辑后即生效)。renderer 走
			// subCustom ?? globalCustom ?? DEFAULT_LIVE_TEMPLATES,enable 仅占位、不被读。
			customLiveMsg: {
				enable: true,
				customLiveStart: g.defaults.templates.liveStart,
				customLiveStreaming: g.defaults.templates.liveStreaming,
				customLiveEnd: g.defaults.templates.liveEnd,
			},
			// 无覆盖的 UP 靠它轮换全局默认直播封面(独立端专属,见 resolvedCardStyle)。
			defaultLiveCoverImages: g.defaults.cards.liveCoverImageIds,
		};
	};

	const live = new LiveEngine({
		serviceCtx: liveCtx,
		api: opts.api,
		push: livePushLike,
		contentBuilder: segmentContentBuilder,
		guardIcons: opts.guardIcons,
		imageFetcher: opts.imageFetcher,
		avatarOf: profileAvatarOf,
		imageRenderer: imageRenderer ?? null,
		commentary: commentary ?? null,
		config: liveConfig(),
		emitEngineError: (message) => opts.bus.emit("engine-error", { source: "live-engine", message }),
		emitLiveState: (uid, status, startedAt) =>
			opts.bus.emit("live-state-changed", { uid, status, at: startedAt }),
		emitViewers: (uid, viewers) => opts.bus.emit("live-viewers-changed", { uid, viewers }),
		pickCardBackground: pickExistingCardBg,
		// ③ 解析出房号即写盘(仅在与既有值不同时),下次启动/reload 直接读盘复用,
		// 省掉逐 UP 的 fetchUserInfo 房号解析请求。
		onRoomIdResolved: (uid, roomId) => {
			const sub = opts.subscriptionStore.findByIdentity(biliIdentity(uid));
			if (!sub) return;
			if (opts.subRuntimeStore.get(sub.id)?.roomId === roomId) return;
			opts.serviceCtx.track(
				opts.subRuntimeStore.patch(sub.id, { roomId }).catch((err) => {
					log.warn(`[engines] 房号写盘失败 uid=${uid}: ${String(err)}`);
				}),
			);
		},
	});

	// Initialise live with current subs.
	const initialLiveView = buildLiveSubsView(
		opts.subscriptionStore,
		opts.subRuntimeStore,
		globals(),
	);
	if (Object.keys(initialLiveView).length > 0) {
		// B 站直播起来了就把徽章图抓进图库,但**不等它**:抓图慢或断网都不能拖住启动(`ensure` 不抛、失败只记日志)。
		// 没有 B 站订阅时不抓:没人会上舰,首条上舰与卡片预览出卡前自己会补抓。
		void opts.guardIcons.ensure();
		live.start(initialLiveView);
	}

	// ---------- Bus wiring ----------
	const handles: Disposable[] = [postQueue];

	// 拓展订阅的作品(ADR-0019 决策 69–72):听上报,逐条订阅翻成中立的信封(图已写进图库)交给同一个核心入口 —— 与 B 站动态
	// 同一份装配、同一个渲染器、同一份出图失败计数。设置每条现折(`makePostSettingsReader`),渲染器与 AI 每条现取(会被热换)。
	if (extensionSources) {
		const postImages = opts.postImages;
		// 漏接线的症状是「拓展作品卡一张图都没有」而门禁全绿,所以开机就抛,不悄悄跳过。
		if (!postImages) throw new Error("createEngines: 给了 extensionSources 就必须给 postImages");
		handles.push(
			bindExtensionPosts({
				bus: opts.bus,
				logger: dynamicCtx.logger,
				serviceCtx: opts.serviceCtx,
				subscription: (id) => opts.subscriptionStore.findById(id),
				profileName: (id) => opts.subRuntimeStore.get(id)?.cachedProfile?.name,
				postNoun: (extensionId) => extensionSources.postNoun(extensionId),
				postImages,
				enqueue: (event) => postQueue.enqueue(event),
			}),
		);
	}

	// 拓展订阅的直播(ADR-0019 决策 57 / 58 / 61 / 67):场次(开播 / 下播、断流接续)由 `liveSessions` 算一份,
	// 推送吃它(ADR-0020 决策 6);开播 / 下播卡由事件触发,周期「正在直播」、重启补推由推送那头的小计时器管;
	// 推什么、怎么推与 B 站同一份(直播装配、文案渲染、按 UP 折好的设置、特性键映射)。最新状态从在播表取,
	// 出卡的渲染器现取(热换、关了出图时不出卡)。
	const extensionLive = opts.extensionLive;
	/** 拓展订阅的场次;没接拓展订阅的直播时没有。统计页经 `extensionLiveSession` 读它。 */
	let extensionLiveSessions: ExtensionLiveSessions | undefined;
	if (extensionSources && extensionLive) {
		const liveImages = opts.liveImages;
		// 同上:漏接线的症状是「拓展直播卡没有封面与头像」而门禁全绿,所以开机就抛。
		if (!liveImages) throw new Error("createEngines: 给了 extensionLive 就必须给 liveImages");
		const liveSessions = createExtensionLiveSessions({
			bus: opts.bus,
			logger: liveCtx.logger,
			table: extensionLive,
			subscription: (id) => opts.subscriptionStore.findById(id),
			running: (id) => extensionSources.running(id),
			fans: (id) => opts.subRuntimeStore.get(id)?.cachedProfile?.fans,
			settings: (sub) => liveWorkSettings(sub, globals()),
			timers: liveCtx,
		});
		handles.push(liveSessions);
		extensionLiveSessions = liveSessions;
		handles.push(
			bindExtensionLivePush({
				bus: opts.bus,
				logger: liveCtx.logger,
				serviceCtx: liveCtx,
				sessions: liveSessions,
				table: extensionLive,
				subscription: (id) => opts.subscriptionStore.findById(id),
				profile: (id) => opts.subRuntimeStore.get(id)?.cachedProfile,
				settings: (sub) => liveWorkSettings(sub, globals()),
				// 订阅的封面 ?? 全局的,再轮一张自定义封面 —— 与 B 站的直播间同一份规矩;游标键跟着人走(决策 73)。
				cardStyle: (sub, settings) => {
					const identity = subscriptionIdentityOf(sub);
					return rotateLiveCover(
						settings.customCardStyle,
						globals().defaults.cards.liveCoverImageIds,
						pickExistingCardBg,
						`${identity.sourceKey}:${identity.externalId}:live-cover`,
					);
				},
				sources: extensionSources,
				avatarRef: (id) => opts.subRuntimeStore.get(id)?.cachedProfile?.avatar,
				liveImages,
				sendFor: (id) => boundLivePush(push, id),
				renderer: () => (globals().defaults.cards.enabled ? imageRenderer : null),
				onReportDiscrepancy: (discrepancy) => opts.onReportDiscrepancy?.(discrepancy),
			}),
		);
	}

	handles.push(
		opts.bus.on("subscription-changed", ({ ops }) => {
			// 动态那一半:来源上下文自己听这个事件(`subscriptions/source-context.ts`)。
			const liveOps = subscriptionOpsToLive(
				ops,
				opts.subscriptionStore,
				opts.subRuntimeStore,
				globals(),
			);
			live.applyOps(liveOps, (uid) => {
				const sub = opts.subscriptionStore.findByIdentity(biliIdentity(uid));
				return sub ? buildLiveSubViewSingle(sub, opts.subRuntimeStore, globals()) : undefined;
			});
		}),
	);
	handles.push(
		opts.bus.on("auth-restored", () => {
			live.rebuildFromSubs(
				buildLiveSubsView(opts.subscriptionStore, opts.subRuntimeStore, globals()),
			);
			// 登录恢复 → 之前因未登录而关注失败的订阅在这里自愈。
			runFollowSync("auth-restored");
		}),
	);
	handles.push(
		opts.bus.on("subscription-changed", ({ ops }) =>
			syncNewFollowTargets(
				new Set(
					ops
						.filter((op) => op.kind === "add")
						.map((op) => subscriptionIdentityOf(op.sub).externalId),
				),
			),
		),
	);
	handles.push(
		opts.bus.on("config-changed", ({ scope }) => {
			if (scope === "globals") syncNewFollowTargets(new Set());
		}),
	);
	handles.push(
		opts.bus.on("auth-lost", () => {
			live.teardown();
		}),
	);
	// ---------- Connection probe scheduler ----------
	// Background reachability check. Plan §"系统不要主动测试" excludes message-
	// sending probes; this one only calls platformAdapter.probe (no side
	// effects) and writes the result back to the connection's probeState so the
	// dashboard reflects reality without the user clicking "测试" on every one.
	const CONNECTION_PROBE_INTERVAL_MS = 5 * 60 * 1000;
	let probeInFlight = false;
	/**
	 * 健康探测 + 顺路补探能力:连上那一刻没探到(反向 ws 的 bot 是后来才连入的)、或探的
	 * 时候没连上,能力会停在「未探测」;开机、每五分钟、主人点「测试」都从这儿再给一次机会。
	 * 只补「未探测」的,已经有答案的不重探 —— 那是 reconcile 的事。
	 */
	async function probeConnectionAndCapabilities(connectionId: string): Promise<ProbeResult> {
		const result = await dispatcher.probeConnection(connectionId);
		// 连都连不上的连接,能力必然也探不出来 —— 再问一次只是白等满一整个超时,
		// 而这条路是每五分钟一轮、逐个 await 的,离线的连接会把整轮时间翻倍。
		// (`unsupported` 是「没有探测协议」,不是连不上,不在此列。)
		if (!result.ok && result.code !== "unsupported") return result;
		if (dispatcher.connectionCapabilities(connectionId)?.miniAppCard.state === "unknown") {
			await dispatcher.probeConnectionCapabilities(connectionId);
		}
		return result;
	}

	async function probeAllConnections(): Promise<void> {
		if (probeInFlight) return;
		probeInFlight = true;
		try {
			for (const connection of opts.configStore.getConnections()) {
				if (!connection.enabled) continue;
				// 关停一开始就不再起新的探测:一轮探下来要等每条连接的超时,登记进 track 之后
				// 不能靠预算硬等它。
				if (opts.serviceCtx.signal.aborted) break;
				try {
					const result = await probeConnectionAndCapabilities(connection.id);
					// 探不了的连接(如 webhook):记成 `unsupported`(不是通也不是不通),但已经是它的不再写 ——
					// 否则每条这样的连接每五分钟多一次写盘与 `config-changed`。
					if (!result.ok && result.code === "unsupported") {
						if (connection.probeState?.status === "unsupported") continue;
						await opts.configStore.recordConnectionProbeState(connection.id, {
							status: "unsupported",
							lastCheckedAt: new Date().toISOString(),
						});
						continue;
					}
					// 失败的原话填进 `message`,码不落盘。
					await opts.configStore.recordConnectionProbeState(
						connection.id,
						result.ok
							? {
									status: "reachable",
									lastCheckedAt: new Date().toISOString(),
									latencyMs: result.latencyMs,
								}
							: {
									status: "unreachable",
									lastCheckedAt: new Date().toISOString(),
									message: result.message,
								},
					);
				} catch (e) {
					log.warn(`[probe] connection ${connection.id} update failed: ${String(e)}`);
				}
			}
		} finally {
			probeInFlight = false;
		}
	}

	// Kick off an immediate probe after engines come up, then poll on a timer.
	// `config-changed` for the 'connections' scope triggers an extra immediate probe
	// so the UI reflects new connections / edits without waiting up to 5 min.
	// 探测结果经 recordConnectionProbeState 写回连接表:登记进 track,关停等这笔写交进 config 写道。
	const trackProbe = (): void => {
		opts.serviceCtx.track(
			probeAllConnections().catch((e) => log.warn(`[probe] 健康探测失败: ${String(e)}`)),
		);
	};
	trackProbe();
	const probeTimer = setInterval(trackProbe, CONNECTION_PROBE_INTERVAL_MS);
	// Allow process exit without waiting for the next tick.
	probeTimer.unref?.();

	// config-changed:globals handler 的「上次已应用的 globals」快照。用来 diff 出本次
	// 实际改了哪些 section,只热更受影响的子系统 —— 否则改 AI 人设也会重排
	// 健康检查定时器(无谓扇出 + 日志噪音)。
	let prevGlobals = initialGlobals;

	// 链接卡(群里贴链接自动出的那张)的呈现与开关。呈现与推送的动态卡问同一处:全局
	// 「动态」样式 + 全局默认图廊轮换 + 全局版式。做成随 config-changed 刷新的快照 ——
	// 群里每句带链接的话都要读开关,而 `globals()` 是整份深拷贝,不该按条付这个钱。
	const linkCardViewOf = (g: GlobalConfig) => ({
		config: g.linkParsing,
		// 链接卡没有 UP 可言,吃的就是全局那套皮肤(与推送动态卡在没有 per-UP 覆盖时同源)。
		cardSkin: g.defaults.cardSkin,
		// 动态卡没有按订阅的封面可言:链接卡就是「没有样式覆盖」(渲染器逐字段回退自己的全局配置)。
		style: { enable: false } as const,
	});
	let linkCard = linkCardViewOf(initialGlobals);
	// 逐群答案从默认行 + 例外 + 目标表 + 连接表算出来,三者任一变了都重算(见接口上的说明)。
	const linkPoliciesOf = () =>
		resolveLinkParsingPolicies({
			config: linkCard.config,
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
				// 刻意不在这里触发 probeAllConnections:probe 经 recordConnectionProbeState 写回
				// probeState 会再 emit config-changed:connections → 死循环。adapter
				// 连通状态由 5 分钟轮询刷新(或用户点"测试"立即刷)。
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
				const aiChanged = !eq(prev.ai, g.ai);
				const cardStyleChanged = !eq(prev.defaults.cards, g.defaults.cards);
				const scheduleChanged = !eq(prev.defaults.schedule, g.defaults.schedule);
				// 直播拆键(⑬d):启动补报与周期间隔从 schedule 里搬出来各成一段,热更的门一并跟着。
				const liveSettingsChanged =
					!eq(prev.defaults.liveStart, g.defaults.liveStart) ||
					!eq(prev.defaults.liveStreaming, g.defaults.liveStreaming);
				const filtersChanged = !eq(prev.defaults.filters, g.defaults.filters);
				// 醒目留言与会员的门槛(㉓d 起自成 superchat / membership 两段,原先在 filters 里):它们在每个订阅的视图里定格,
				// 只有 applyOps 能刷,所以和上面几段一样要开热更的门 —— 漏掉的话改了门槛要重启才生效。
				const interactionChanged =
					!eq(prev.defaults.superchat, g.defaults.superchat) ||
					!eq(prev.defaults.membership, g.defaults.membership);
				const templatesChanged = !eq(prev.defaults.templates, g.defaults.templates);
				const featuresChanged = !eq(prev.defaults.features, g.defaults.features);
				// 皮肤换了 = 出图整个换一副样子,与旧的「版式变了」同一档热更需求:两个引擎的
				// per-sub 快照都得刷,否则要等重启才生效(ADR-0014 决策 15 起版式住皮肤里)。
				const skinChanged = prev.defaults.cardSkin !== g.defaults.cardSkin;
				// 旋钮拧一格与换皮肤同一档:出图立刻变个样。只喂渲染器的 config(旋钮不
				// 参与 per-sub 快照 —— 它按皮肤 id 存,全局一份)。
				const skinKnobsChanged = !eq(prev.defaults.cardSkinKnobs, g.defaults.cardSkinKnobs);
				const messageLayoutChanged = !eq(prev.defaults.messageLayout, g.defaults.messageLayout);

				// `logging` 里只按日志等级(`level` 与 `levels` 两格)开门,**不要写成整段比**:保留天数、内存自检开关
				// 各有各的读法,不在这里热推。粉丝轮询的 cron 是顶层的 `profileRefreshCron`,同样不在这里。
				// B 站那两格(cron / 健康检查间隔)在 B 站自己的设置里:cron 由 B 站来源自己听,健康检查间隔由登录系统(`bilibili/auth/`)自己听。
				if (
					!eq(prev.logging.level, g.logging.level) ||
					!eq(prev.logging.levels, g.logging.levels)
				) {
					const sourceLevel = resolveLevel(g, BILIBILI_SOURCE_KEY);
					opts.serviceCtx.setLevel(resolveLevel(g, "core"));
					dynamicCtx.setLevel(sourceLevel);
					liveCtx.setLevel(sourceLevel);
					aiCtx.setLevel(resolveLevel(g, "ai"));
					imageCtx.setLevel(resolveLevel(g, "image"));
				}
				// ImageRenderer 热更(仅在已构造时有意义)。配色 / 字体 / 数据区显示项都已经
				// 退役成皮肤旋钮,这里只剩旋钮那一份要送下去。
				if ((cardStyleChanged || skinKnobsChanged) && imageRenderer) {
					imageRenderer.updateConfig({
						cardSkinKnobs: g.defaults.cardSkinKnobs,
					});
				}
				// liveConfig() 读 defaults.{templates,cardStyle} 与顶层 ai(周期间隔与补报在每个订阅的视图里,
				// 经下面的 applyOps 推,不在引擎级的全局配置里)。
				if (filtersChanged || templatesChanged || cardStyleChanged || aiChanged) {
					live.updateConfig(liveConfig());
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
						live.setCommentary(null);
					} else if (needsCommentary && !commentary) {
						commentary = buildCommentary();
						live.setCommentary(commentary);
						if (commentary) log.info("[ai] commentary 已激活");
					} else if (commentary) {
						const next = buildAiConfig();
						commentary.updateConfig(next);
						// 报**真正推给引擎的那份人格**(指针指的那份),不是 `a.persona` ——
						// 后者永远冻在老值上,照它打日志等于给排查的人指错方向。
						log.info(
							`[ai] commentary 配置已更新: profile=${a.activeProfile}(${ap.provider}), model=${ap.model}, persona.name=${next.persona.name}, traits=${next.persona.traits}`,
						);
					}
				}
				// LiveEngine 是事件驱动 —— per-sub 视图(aiOverride / customCardStyle /
				// 周期间隔 / 补报 / 模板…)在 start / applyOps 时定格(动态那头吃名单、现算,不吃这种快照)。resolve() 把 cards / cardSkin / schedule / liveStart /
				// liveStreaming / superchat / membership / filters / templates / features / messageLayout / imageGroup 折进每个 sub 的 eff;
				// AI 人格不在 eff 里,由 resolveAiOverride(经 resolveSubscriptionPersona)在构造 per-sub 视图时另算 —— 任一变化都给所有
				// 订阅合成 update op 走 applyOps 增量路径,刷新活跃 listener 的 per-sub
				// 状态(Object.assign,不重连 WS)。否则全局默认改了直到重启才在 live 生效。
				if (
					aiChanged ||
					cardStyleChanged ||
					scheduleChanged ||
					liveSettingsChanged ||
					interactionChanged ||
					filtersChanged ||
					templatesChanged ||
					featuresChanged ||
					skinChanged ||
					messageLayoutChanged
				) {
					const refreshOps = subscriptionOpsToLive(
						opts.subscriptionStore.list().map((sub) => ({ kind: "update" as const, sub })),
						opts.subscriptionStore,
						opts.subRuntimeStore,
						g,
					);
					live.applyOps(refreshOps, (uid) => {
						const sub = opts.subscriptionStore.findByIdentity(biliIdentity(uid));
						return sub ? buildLiveSubViewSingle(sub, opts.subRuntimeStore, g) : undefined;
					});
				}
				// 作品来源的名单(全局作品开关一翻要重算)不在这里:来源上下文自己听 `config-changed` 的 globals 一档
				// (`subscriptions/source-context.ts`),名单每次现算,来源自己对比。
				// 作品设置(模板 / 版式 / 皮肤 / 图集 / 过滤……)核心每条作品现折,改了立即生效,也不经这里。
			}
		}),
	);

	// ---------- Disposal ----------
	// index.ts shutdown 既显式调 engines.dispose(),又经 runtime.dispose() 跑
	// serviceCtx.onDispose 钩子(下方 onDispose(dispose))→ 双调。幂等守卫,
	// 避免对各 engine .stop()/.dispose() 二次调用与重复 warn 噪音。
	let disposed = false;
	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		clearInterval(probeTimer);
		clearInterval(cursorFlushTimer);
		flushCursors(); // 关停前把未落盘的游标推进写一次,重启续接

		// 来源先停(后登记的先停),再关作品入口:停下之后不许再上报。来源的 `stop()` 必须在同步段里停干净。
		for (const registration of sourceRegistrations.splice(0).reverse()) {
			try {
				registration.dispose();
			} catch (e) {
				log.warn(`[engines] source dispose failed: ${errorMessageOf(e)}`);
			}
		}
		for (const h of handles.splice(0)) {
			try {
				h.dispose();
			} catch {
				// best-effort
			}
		}
		try {
			live.stop();
		} catch (e) {
			log.warn(`[engines] live.stop failed: ${String(e)}`);
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
				subscriptions: opts.subscriptionStore,
				defaults: () => globals().defaults,
				bus: opts.bus,
				// 来源上下文的 `ctx.logger` 就是这一个(动态子系统 logger):来源(含它造的动态引擎)的每行日志
				// 名字叫 `dynamic`,等级跟 `logging.levels` 里来源键那一格走(下面热更)。
				logger: dynamicCtx.logger,
				enqueue: (event) => postQueue.enqueue(event),
			});
			// 登记途中 `dispose()` 已跑完:关停那一遍没收到这个把手,来源却已起来 —— 当场收掉,别留孤儿。
			if (disposed) {
				registration.dispose();
				throw new Error("registerSource: 引擎装配已关停,来源登记作废");
			}
			sourceRegistrations.push(registration);
		},
		live,
		push,
		muteState,
		subscriptionStore: opts.subscriptionStore,
		// getter,理由同下面的 `imageRenderer` —— 这也是个会被热重载重新赋值的 let。
		// 写成普通属性的话它就是**启动那一刻的值拷贝**:没配 AI 起的服务永远是 null,
		// 主人在设置页补上 apiKey 后热重载确实把实例建起来了(`live` 靠 setCommentary、
		// 作品装配经 `deps.ai()` 每条现取,都拿到了新引用),可读这个字段的聊天路由还是拿到 null,
		// 于是「保存成功却照样报『还没填齐』,重启才好」。反向亦然:撤掉密钥后它会
		// 攥着已 stop 的旧实例继续答话。
		get commentary() {
			return commentary;
		},
		api: opts.api,
		// getter:`imageRenderer` 是个会被热切换重新赋值的 let,取值必须每次现读。
		get imageRenderer() {
			return imageRenderer;
		},
		listLiveRooms: () => listLiveRooms(live, opts.subscriptionStore),
		extensionLiveSession: (subscriptionId: string) => extensionLiveSessions?.get(subscriptionId),
		extensionPlatformLabel: (extensionId: string) => opts.extensionPlatformLabel?.(extensionId),
		probeConnection: (connectionId: string) => probeConnectionAndCapabilities(connectionId),
		connectionCapabilities: (connectionId: string) =>
			dispatcher.connectionCapabilities(connectionId),
		probeConnectionCapabilities: (connectionId: string) =>
			dispatcher.probeConnectionCapabilities(connectionId),
		listAddressCandidates: (connectionId, scope, signal) =>
			dispatcher.listAddressCandidates(connectionId, scope, signal),
		sendToAddress: (connectionId, session, payload) =>
			dispatcher.sendToAddress(connectionId, session, payload),
		linkParsing: () => linkCard.config,
		linkPolicyFor: (key: string) => linkPolicies.policyFor(key),
		linkCardPresentation: () => ({
			// 链接卡就是「全局那张动态卡」:吃全局那份动态样式(主人定的:它跟着全局走)。
			colors: resolveDynamicColorOptions(linkCard.style),
			cardSkin: linkCard.cardSkin,
		}),
		getModuleState: (): ModuleState => {
			const g = globals();
			// "live ready" = at least one enabled subscription has any live-related
			// feature routed to a target. Mirrors the LIVE_ROOM_CREATOR_KEYS set
			// inside bilibili/live's `needsLiveMonitor` plus the two
			// special-user features.
			// 只数 B 站订阅:这一格说的是 LiveEngine 会不会开监听器,拓展订阅不进它(ADR-0019 决策 9)。
			const liveReady = opts.subscriptionStore
				.list()
				.filter(fromBilibili)
				.some((sub) => {
					if (!sub.enabled) return false;
					const eff = resolve(sub, g.defaults);
					const keys: FeatureKey[] = [
						"liveStart",
						"liveStreaming",
						"liveEnd",
						"membership",
						"superchat",
						"specialDanmaku",
						"specialUserEnter",
					];
					return keys.some((k) => (eff.routing[k]?.length ?? 0) > 0);
				});
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
			live.setImageRenderer(imageRenderer);
			return true;
		},
		// 热切换浏览器来源(dashboard 改 chromePath / chromeEndpoint):无条件重建
		// renderer 并重新注入两个引擎。旧 adapter 的 dispose 由调用方(cards 路由)
		// 负责 —— 引擎层不持有 adapter,只消费 renderer。
		swapImageRendering: (pup: PuppeteerLike): void => {
			imageRenderer = buildImageRenderer(pup);
			live.setImageRenderer(imageRenderer);
		},
		dispose,
	};
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function pushSegmentsToPayload(segments: PushSegment[]): NotificationPayload {
	if (segments.length === 1 && segments[0]?.kind === "text") {
		return { kind: "text", text: segments[0].text };
	}
	if (segments.length === 1 && segments[0]?.kind === "image") {
		return {
			kind: "image",
			image: { buffer: segments[0].buffer, mime: segments[0].mime },
		};
	}
	if (segments.length === 1 && segments[0]?.kind === "image-group") {
		// segment.mergeForward 由设置里的 imageGroup.mergeForward(全局与逐订阅覆盖)决定:
		//   true  → adapter 走 send_group_forward_msg 合并转发
		//   false → adapter 走多 image segment 合并到一条普通 send_group_msg
		return {
			kind: "image-group",
			images: segments[0].images,
			mergeForward: segments[0].mergeForward,
		};
	}
	const mapped: PayloadSegment[] = [];
	for (const s of segments) {
		if (s.kind === "text") mapped.push({ kind: "text", text: s.text });
		else if (s.kind === "image") mapped.push({ kind: "image", buffer: s.buffer, mime: s.mime });
		else if (s.kind === "image-group") {
			// 混在别的段里的图集降成链接;没有 `url` 的图(只带图库引用)没有链接可给,跳过。
			for (const img of s.images) if (img.url) mapped.push({ kind: "link", href: img.url });
		}
	}
	if (mapped.length === 0) return { kind: "text", text: "" };
	return { kind: "composite", segments: mapped };
}

function collapseSegments(segments: PayloadSegment[]): NotificationPayload {
	if (segments.length === 0) return { kind: "text", text: "" };
	if (segments.length === 1) {
		const only = segments[0];
		if (!only) return { kind: "text", text: "" };
		if (only.kind === "text") return { kind: "text", text: only.text };
		if (only.kind === "image") {
			return { kind: "image", image: { buffer: only.buffer, mime: only.mime } };
		}
	}
	return { kind: "composite", segments };
}

/**
 * 引擎→推送层的两个适配器。**提成工厂是为了让这一跳自己有守卫** ——
 * 它们原本编在 `createEngines` 里、测试够不着,于是把直播那一跳的翻译整个换掉也没一条
 * 测试会红(2026-09-19 剪线实测:219 个文件全绿)。而那一跳里揣着三样东西,掉了都是
 * 静默的:锚点上附加项的键(掉了按目标收窄全失效)、锚点的角色(图集掉成本体就会
 * 再 @ 一次全体)、`allowAtAll`(掉了「每条直播推送都 @全体」那个修过的 bug 直接回归)。
 * 历史记成什么不另说:它记的就是交出去的那把特性键。
 */
type PushForEngines = Pick<PushRouter, "push" | "notifyMaster">;

/**
 * 引擎窄接口上「告诉主人」的两个口,转调 {@link PushRouter.notifyMaster}:没送到记一条 warn、
 * 仍回 `void`(引擎从来不看结果)。`sendErrorMsg` 先 `logger.error` 再转调 ——
 * `notifyMaster` 自己只发、不记 error 日志,这一条是原 `PushRouter.sendErrorMsg` 多打的那条,
 * 现在由调用方自己打。3a-30 把引擎里这些旁路整个删掉时,这个函数跟着删。
 */
export function masterTellers(
	push: Pick<PushRouter, "notifyMaster">,
	logger: Logger,
): {
	sendPrivateMsg: (text: string) => Promise<void>;
	sendErrorMsg: (text: string) => Promise<void>;
} {
	const tell = async (text: string): Promise<void> => {
		const r = await push.notifyMaster(text);
		if (!r.ok) logger.warn(`[push] 通知主人没送到: ${r.message}`);
	};
	return {
		sendPrivateMsg: tell,
		sendErrorMsg: async (text) => {
			logger.error(`[push] ${text}`);
			await tell(text);
		},
	};
}

/**
 * B 站 uid → 订阅 id。引擎说的是 uid,推送链认的是订阅自己的 id(ADR-0019 决策 50),
 * 翻译就在这两个适配器里做;查不到(推送途中被退订)就不往下交,由解析函数自己记一笔。
 */
type SubscriptionIdOf = (uid: string) => string | undefined;

/**
 * 引擎侧的锚点 → 推送层的锚点:角色与附加项的键原样带上,内容(现成的或约定)逐条翻成载荷。
 * 两个适配器共用这一处,内容怎么翻各给各的。
 */
function toPushAnchors<T>(
	anchors: ReadonlyArray<{
		role: PushAnchor["role"];
		extra?: PushAnchor["extra"];
		messages: T[] | Promise<T[] | undefined>;
	}>,
	toPayload: (message: T) => NotificationPayload,
): PushAnchor[] {
	return anchors.map(({ role, extra, messages }) => ({
		role,
		extra,
		messages: Array.isArray(messages)
			? messages.map(toPayload)
			: messages.then((made) => made?.map(toPayload)),
	}));
}

/**
 * 不往下交的那条路(uid 查不到订阅):锚点里的约定没人等了,先接住,免得做不出来的内容
 * 变成没人处理的拒绝。
 */
function dropAnchors(anchors: ReadonlyArray<{ messages: unknown }>): void {
	for (const { messages } of anchors) void Promise.resolve(messages).catch(() => {});
}

/**
 * 作品那一路(核心装配 `deliverPost` 依赖里的 `push`):绑到**一条订阅**上(ADR-0019 决策 50 / 66),装配交来的
 * 锚点 → 推送层的一次推送,特性恒为 `post`。B 站动态与拓展作品共用这一跳(都经核心入口 `PostQueue` 的装配)。开关、免扰、路由、@全体、历史都在推送层(`PushRouter.push`)里。
 */
export function boundPostPush(
	push: Pick<PushRouter, "push">,
	subscriptionId: string,
): (anchors: PostPushAnchor[]) => Promise<void> {
	return async (anchors) => {
		await push.push({
			subscriptionId,
			feature: "post",
			anchors: toPushAnchors(anchors, pushSegmentsToPayload),
		});
	};
}

/**
 * 一种直播推送交给推送层时的那两格:特性键({@link liveTypeToFeature}),以及只有开播许 @全体
 * ({@link liveTypeAllowsAtAll})—— 重启补报也走 `liveStart` 那把键,不显式抑制就每条都 @。
 * B 站直播间与拓展订阅的直播共用这一处映射。
 */
function livePushHead(type: number): Pick<Push, "feature" | "allowAtAll"> {
	return {
		feature: liveTypeToFeature(type),
		...(liveTypeAllowsAtAll(type) ? {} : { allowAtAll: false }),
	};
}

/**
 * 直播那一路(`pushLiveNotify` 的 {@link LiveNotifySend}):绑到**一条订阅**上,装配交来的消息组 →
 * 推送层的一次推送(只有本体那一个锚点),特性键与 @全体 照 {@link livePushHead}。拓展订阅的直播用它
 * (ADR-0019 决策 67);B 站的直播间经 {@link makeLivePushLike} 走同一套映射,段也照同一个口子翻
 * (`segmentContentBuilder` → `segmentToPayload`)。
 *
 * 一组是一条消息:几组就是本体那个锚点里的一串(推送层的序列语义,同 B 站的「分条」)。
 */
export function boundLivePush(
	push: Pick<PushRouter, "push">,
	subscriptionId: string,
): LiveNotifySend {
	return async (groups, type) => {
		const messages = groups.map((segs) =>
			collapseSegments(
				segmentToPayload(
					segmentContentBuilder.message(
						segs.map((seg) =>
							seg.kind === "image"
								? segmentContentBuilder.image(seg.buffer, seg.mime)
								: segmentContentBuilder.text(seg.text),
						),
					),
				),
			),
		);
		await push.push({
			subscriptionId,
			...livePushHead(type),
			anchors: [{ role: "main", messages }],
		});
	};
}

/** 直播引擎那侧的 PushLike:uid → 订阅 id,推送类型 → 特性键与 @全体,锚点逐个翻过去。 */
export function makeLivePushLike(
	push: PushForEngines,
	subscriptionIdOf: SubscriptionIdOf,
	logger: Logger,
): LivePushLike {
	return {
		async push({ uid, type, anchors }) {
			const subscriptionId = subscriptionIdOf(uid);
			if (subscriptionId === undefined) return dropAnchors(anchors);
			await push.push({
				subscriptionId,
				...livePushHead(type as number),
				anchors: toPushAnchors(anchors, (content) => collapseSegments(segmentToPayload(content))),
			});
		},
		sendPrivateMsg: masterTellers(push, logger).sendPrivateMsg,
	};
}

/**
 * LivePushType → 特性键(管开关与路由)。周期「正在直播」(0)有自己的 liveStreaming(⑬d 拆键,
 * 各有开关与目标);开播(3)与重启补报(11,补的就是一次开播)走 liveStart。下播的词云 / 总结
 * 不是单独的一种推送:它们是下播(9)那次推送里的附加项锚点,自然跟着下播那把键走。
 */
export function liveTypeToFeature(type: number): FeatureKey {
	switch (type) {
		case 0:
			return "liveStreaming";
		case 3:
		case 11:
			return "liveStart";
		case 4:
			return "membership";
		case 9:
			return "liveEnd";
		case 6:
			return "superchat";
		case 7:
			return "specialDanmaku";
		case 8:
			return "specialUserEnter";
		default:
			return "liveStart";
	}
}

/**
 * 一条 LivePushType 是否允许 @全体成员。仅 `StartBroadcasting`(=3,开播)允许;
 * 重启补报(`CatchUp`=11)也翻译成 `feature === "liveStart"`,光看 feature 区分不出
 * 真开播 vs 补报 —— push 层据本结果决定是否进 atAll 分支,否则每条补报都 @全体
 * (从前周期复推就这么出过 bug)。裸数字 3 = LivePushType.StartBroadcasting,与
 * apps/server/src/bilibili/live 的 LivePushType 保持一致。
 */
export function liveTypeAllowsAtAll(type: number): boolean {
	return type === 3;
}

/**
 * 把 `EffectiveSubscription.ai` (per-UP 折叠后) 翻译成 CommentaryCallOverride。
 * schema 用「面向用户」的 baseRole / extraSystemPrompt 字段名,而 CommentaryGenerator
 * 的 PersonaConfig 沿用 customBase / extraPrompt 历史命名 —— 这里集中做翻译,
 * 引擎层不感知差异。preset 强制设为 "custom":adapter 已把 inherit / preset.id 在
 * resolve() 里折叠成具体 persona,引擎不需要再走 preset lookup 一次。
 */
/**
 * 一条订阅的 per-UP AI 覆盖 —— 没配就是 `undefined`。
 *
 * **`undefined` 与「把全局值折进来」不是一回事。** 留 undefined 时
 * `CommentaryGenerator` 内部走 `?? this.config` 兜底,主人改了全局人格立刻生效;
 * 折进来则把当时的全局值冻成这条订阅的 per-UP 值,快照不刷就永远沿用旧值。
 *
 * 三处调用点(动态视图、直播视图、统计页的单人锐评)共用这一个入口,免得
 * 「只在真有 override 时才传」这条纪律各写各的 —— 漏写一处的表现是某位 UP
 * 的人格悄悄失效,而类型、构建、lint 全绿。
 */
export function resolveAiOverride(
	sub: Subscription,
	ai: AISettings,
): CommentaryCallOverride | undefined {
	return sub.overrides.ai
		? buildAiOverride(resolveSubscriptionPersona(ai, sub.overrides.ai))
		: undefined;
}

function buildAiOverride(active: ActivePersonaShape): CommentaryCallOverride {
	return {
		persona: {
			preset: "custom" as const,
			name: active.persona.name,
			addressUser: active.persona.addressUser,
			addressSelf: active.persona.addressSelf,
			traits: active.persona.traits,
			catchphrase: active.persona.catchphrase,
			customBase: active.persona.baseRole,
			extraPrompt: active.persona.extraSystemPrompt,
		},
		dynamicPrompt: active.dynamicPrompt,
		liveSummaryPrompt: active.liveSummaryPrompt,
	};
}

/**
 * 把一份解析后的 CardStyle(或 per-UP 覆盖切片)映射成引擎消费的 colorOptions 形状
 * (`enable:true` + `liveCoverImage` 取列表首张作为静态兜底,`liveCoverImages` 透传完整
 * 列表给推送点做「每次推送轮换」——见 `RoomSessionBase.resolvedCardStyle`)。
 *
 * 无封面时 `liveCoverImage` 留 undefined(**不是** `""`)—— generate* 用
 * `colorOptions.liveCoverImage` 兜底,`""` 非 nullish 会把封面抹空而非回退 B 站原图,
 * 故只设字体之类的 per-UP 覆盖必须让封面透传 undefined。
 *
 * 从前这里还映射一对 `backgroundImage` / `backgroundImages`;整条链 2026-09-20 删掉
 * (背景图归皮肤自己的 `image` 旋钮)。
 */
function cardStyleToColorOptions(s: {
	liveCoverImageIds?: string[];
}): LiveSubView["customCardStyle"] {
	return {
		enable: true,
		// 🪦 字体两项(`font` / `fontAsset`)2026-09-20 从这里摘掉。它们 09-14 退役成皮肤
		// 自己的字体旋钮,卡片页上那几栏入口也一并删了 —— 而这一步还在读盘上的老值往下喂,
		// 于是给某位 UP / 某类卡单独设过字体的人**改不动它、它却还在生效**,面板上连看都
		// 看不到。全局那一份早就断了(见上面 createImageRenderer 那儿的注释),漏的是
		// per-UP 与 per-kind 这两层。
		//
		// ⚠️ 这里从前写的是反向的注释(「此前整个漏在这里…选了等于没选」)。那句话在入口
		// 还在的时候是对的:收不到才是 bug。入口没了之后,继续读它才是 bug。别照着旧版本
		// 把这两行加回来 —— 守卫在 `__tests__/sub-views.test.ts`,它也跟着翻了向。
		//
		// 字段本身留在 schema 里(退役字段不删,`.strict()` 会让老配置装不进来),只是再没有
		// 读者;想换字体请拧那套皮肤的字体旋钮。
		//
		// 直播封面(独立端专属,仅 live 卡消费)。
		liveCoverImage: s.liveCoverImageIds?.[0],
		liveCoverImages: s.liveCoverImageIds,
	};
}

/** B 站引擎说的 uid → 订阅身份(B 站的外部 id 就是 uid)。 */
function biliIdentity(uid: string): Identity {
	return { sourceKey: BILIBILI_SOURCE_KEY, externalId: uid };
}

/** 这条订阅订的是 B 站吗 —— B 站引擎(动态 / 直播)只看这样的订阅,拓展订阅不进它(ADR-0019 决策 9)。 */
function fromBilibili(sub: Subscription): boolean {
	return subscriptionIdentityOf(sub).sourceKey === BILIBILI_SOURCE_KEY;
}

/**
 * 一条订阅(B 站或拓展)→ 作品装配吃的设置(ADR-0019 决策 65 / 66):订阅覆盖与全局折成一层。B 站与拓展作品
 * 都从这里拿,别抄第二份 —— 两份的话主人给某个抖音号换的文案模板 / 版式 / 皮肤,迟早有一格只有 B 站那头认。
 * 每条作品现折一次({@link makePostSettingsReader}),没有快照问题。
 *
 * 留在 engines.ts 而不进 `posts/`:`resolveAiOverride` 直播那头也在用,搬进核心会把直播的东西一起拖走。
 * 刻意只在**真有 per-UP 覆盖**时才生成的两格:`aiOverride`(没配就 undefined,生成器走全局配置)与
 * `cardSkinKnobs`(订阅自己那层原样给、不折全局,渲染器出图时与全局那份逐枚合并)。
 *
 * `eff` 给了就不再折一遍。
 */
export function postSettingsOf(
	sub: Subscription,
	globals: GlobalConfig,
	eff: EffectiveSubscription = resolve(sub, globals.defaults),
): PostSettings {
	const d = globals.defaults;
	return {
		filter: eff.filters,
		// per-UP 解析后的消息版式动态切片,恒有值(默认 = 复刻现状:卡片+文本+链接合并一条)。
		messageLayout: eff.messageLayout.post,
		cardEnabled: d.cards.enabled,
		// per-UP 解析后的卡片皮肤 id(eff = per-UP 指了就是它,否则全局)。
		cardSkin: eff.cardSkin,
		cardSkinKnobs: sub.overrides.cardSkinKnobs,
		aiEnabled: globals.ai.enabled,
		aiWebSearch: globals.ai.search.engines.dynamic,
		aiOverride: resolveAiOverride(sub, globals.ai),
		template: eff.templates.post,
		videoTemplate: eff.templates.postVideo,
		imageGroup: { enabled: eff.imageGroup.enabled, mergeForward: eff.imageGroup.mergeForward },
	};
}

/**
 * 核心装配用的「这条订阅此刻的作品设置」读口(`DeliverPostDeps.settings`):不该推就回 `undefined` ——
 * 订阅不在、停用、作品开关关着、来源没在跑。**每次现折**:入口问一次、装配开头问一次、回问再问一次。
 * 导出它是为了让这一跳有自己的测试。
 */
export function makePostSettingsReader(deps: {
	subscription: (id: string) => Subscription | undefined;
	globals: () => GlobalConfig;
	/** 这条订阅的来源还在跑吗(问来源登记表:内置来源登着就在;拓展看它自己在不在跑)。 */
	sourceRunning: (sub: Subscription) => boolean;
}): (subscriptionId: string) => PostSettings | undefined {
	return (subscriptionId) => {
		const sub = deps.subscription(subscriptionId);
		if (sub === undefined || !sub.enabled) return undefined;
		const g = deps.globals();
		const eff = resolve(sub, g.defaults);
		if (!eff.features.post) return undefined;
		if (!deps.sourceRunning(sub)) return undefined;
		return postSettingsOf(sub, g, eff);
	};
}

/**
 * 配置里 B 站的会员体系(`guard`)那一份文案 → 引擎视图(㉓d,原先的 `toCustomGuardBuy`):`enabled` + 体系默认 + 按档 key 存的覆盖整份
 * 下发,room-session 按事件的档位 key 取同一档(`membershipTemplateOf`)。全局(`liveConfig`)与 per-UP(`buildLiveSubViewSingle`,
 * 取的是折好的生效值)共用这一处,别在两边各抄一份映射。配置里没有 `guard` 这一项(手改删掉了)就回出厂那份:自定义关着,走官方上舰图。
 */
function guardTemplateOf(templates: TemplateBundle): MembershipTemplateBundle {
	return (
		templates.membership[GUARD_PROGRAM_ID] ?? {
			enabled: false,
			default: { ...DEFAULT_TEMPLATES.membership.guard.default },
			tiers: {},
		}
	);
}

function buildLiveSubsView(
	store: SubscriptionStore,
	subRuntimeStore: SubRuntimeStore,
	globals: GlobalConfig,
): LiveSubsView {
	const view: LiveSubsView = {};
	// 只有 B 站订阅进直播引擎(ADR-0019 决策 9)。
	for (const sub of store.list().filter(fromBilibili)) {
		if (!sub.enabled) continue;
		view[subscriptionIdentityOf(sub).externalId] = buildLiveSubViewSingle(
			sub,
			subRuntimeStore,
			globals,
		);
	}
	return view;
}

/**
 * 一条订阅折好的**直播设置** —— 开播 / 正在直播 / 下播三张卡共用的那几格(ADR-0019 决策 65 / 67):
 * 两个特性开关、卡片样式(订阅的直播封面)、皮肤、消息版式、三句文案模板,以及推送频率 / 重启补推 /
 * 断流接续这几格按 UP 折好的值。
 */
export type LiveWorkSettings = Pick<
	LiveSubView,
	| "liveStart"
	| "liveStreaming"
	| "liveEnd"
	| "customCardStyle"
	| "cardSkin"
	| "cardSkinKnobs"
	| "messageLayout"
	| "customLiveMsg"
	| "streamingIntervalHours"
	| "catchUpOnBoot"
	| "liveEndGrace"
	| "liveEndGraceMinutes"
>;

/**
 * 一条订阅(B 站或拓展)→ 直播设置(ADR-0019 决策 65 / 67)。B 站直播引擎的视图(`buildLiveSubViewSingle`)
 * 与拓展订阅的直播都从这里拿,别抄第二份 —— 与 {@link postSettingsOf} 同一个道理:两份的话主人给某个
 * 抖音号换的文案 / 版式 / 推送频率,迟早有一格只有 B 站那头认。
 *
 * `eff` 给了就不再折一遍。
 */
export function liveWorkSettings(
	sub: Subscription,
	globals: GlobalConfig,
	eff: EffectiveSubscription = resolve(sub, globals.defaults),
): LiveWorkSettings {
	return {
		// 特性布尔 = features.X(source-side gate)。routing 由推送层 PushRouter 在每个锚点发出
		// 时按 routing 空 = 无 dispatcher 自然兜底,这里不再 AND routing。即:features.X=true / routing.X=[] 的
		// UP 也开 WS / build payload,加 routing 后下一次事件立即生效。
		liveStart: eff.features.liveStart,
		liveStreaming: eff.features.liveStreaming,
		liveEnd: eff.features.liveEnd,
		// customCardStyle 只在真有 per-UP override 时生成。无 override → enable:false → 推送时(`pushLiveNotify` 的 `cardStyle?.enable ? … :
		// undefined`)自动传 undefined → ImageRenderer 走 this.config 兜底,跟全局 hot-reload 同步。
		customCardStyle: sub.overrides.cards?.liveCoverImageIds
			? cardStyleToColorOptions(sub.overrides.cards)
			: { enable: false },
		// Per-UP 调度(per-UP ?? 全局,resolve 已折算)。B 站:已活跃 listener 通过 LiveScopedChange 同步
		// 增量更新(`subscriptionOpsToLive` 在 update 分支把这些字段一并带上,LiveEngine.applyOps
		// Object.assign 后即刻生效;`liveStreaming` 开关或间隔变化时 engine 额外 rearm 一次 setInterval)。
		streamingIntervalHours: eff.liveStreaming.streamingIntervalHours,
		catchUpOnBoot: eff.liveStart.catchUpOnBoot,
		// 断流接续:该 UP 下播是否先挂起等待重开。
		liveEndGrace: eff.schedule.liveEndGrace,
		liveEndGraceMinutes: eff.schedule.liveEndGraceMinutes,
		// 无开关:始终下发 eff 模板(eff 合并 per-UP override → 全局),与 liveSummary
		// 同模式;LiveEngine 在全局/per-UP 变更时收完整 update op 刷新,无快照陈旧问题。
		customLiveMsg: {
			enable: true,
			customLiveStart: eff.templates.liveStart,
			customLiveStreaming: eff.templates.liveStreaming,
			customLiveEnd: eff.templates.liveEnd,
		},
		// per-UP 解析后的卡片皮肤 id(eff = per-UP 指了就是它,否则全局)。
		cardSkin: eff.cardSkin,
		// 这位 UP 自己那层旋钮覆盖,原样给、不折全局(理由同 `postSettingsOf` 那一格)。
		// 开播 / 直播中 / 下播 / SC / 上舰 / 词云都吃这一份(不分卡种)。
		cardSkinKnobs: sub.overrides.cardSkinKnobs,
		// per-UP 解析后的消息版式直播切片(覆盖开播 / 直播中 / 下播),恒有值。
		messageLayout: eff.messageLayout.live,
	};
}

export function buildLiveSubViewSingle(
	sub: Subscription,
	subRuntimeStore: SubRuntimeStore,
	globals: GlobalConfig,
): LiveSubView {
	const eff = resolve(sub, globals.defaults);
	// B 站引擎以 uid 为键,调用方只给 B 站订阅。
	const uid = subscriptionIdentityOf(sub).externalId;
	const danmakuUsers = sub.specialUsers.filter((u) => u.kinds.includes("danmaku"));
	const enterUsers = sub.specialUsers.filter((u) => u.kinds.includes("enter"));
	// SubItemView 上每个 feature 的布尔字段 = features.X(source-side gate),同 liveWorkSettings。
	const feat = (k: keyof typeof eff.routing) => eff.features[k];
	return {
		// 中立事件(会员 / 醒目留言)要核心的订阅 id,引擎自己只认 uid —— 宿主带进来。
		subscriptionId: sub.id,
		uid,
		uname: subRuntimeStore.get(sub.id)?.cachedProfile?.name ?? uid,
		// ③ 读盘复用已解析的房号;缺失(首见该 UP)时留空 → LiveEngine 现解析并写回。
		roomId: subRuntimeStore.get(sub.id)?.roomId ?? "",
		post: feat("post"),
		membership: feat("membership"),
		superchat: feat("superchat"),
		// 四把附加项整份下发(ADR-0016);引擎只读下播那两把,@全体 归推送层。
		extras: eff.features.extras,
		target: eff.routing,
		// 开播 / 正在直播 / 下播三张卡共用的那几格(与拓展订阅的直播同一份)。dynamic 卡不经 LiveEngine
		// (走 DynamicEngine),所以按种类的样式只折 live / sc / guard。
		...liveWorkSettings(sub, globals, eff),
		// Per-UP 门槛 / AI;adapter 在 add 路径上灌入(门槛是折好的生效值,没配 = 不设门槛),room-session 在 SC / guard /
		// liveSummary 调用点先取 sub 值,缺失时回退全局。aiOverride 只在真有 per-UP override 时生成 —— 无 override →
		// undefined → live-summary-requester 透传 → CommentaryGenerator 走 this.config 兜底。
		minSuperchatAmount: eff.superchat.minAmount,
		minGuardRank: eff.membership.minRank[GUARD_PROGRAM_ID],
		aiOverride: resolveAiOverride(sub, globals.ai),
		guardTemplate: guardTemplateOf(eff.templates),
		customLiveSummary: {
			enable: true,
			liveSummary: eff.templates.liveSummary,
		},
		// per-UP 解析后的弹幕词云额外停用词(eff = per-UP override ?? 全局)。room-session
		// 在下播 dispatch 时对 sortedWords 过滤,使该 UP 的词云 / 总结热词额外生效。
		wordcloudStopWords: eff.templates.wordcloudStopWords,
		customSpecialDanmakuUsers:
			danmakuUsers.length > 0
				? {
						enable: true,
						specialDanmakuUsers: danmakuUsers.map((u) => u.uid),
						msgTemplate: eff.templates.specialDanmaku,
					}
				: { enable: false, msgTemplate: "" },
		customSpecialUsersEnterTheRoom:
			enterUsers.length > 0
				? {
						enable: true,
						specialUsersEnterTheRoom: enterUsers.map((u) => u.uid),
						msgTemplate: eff.templates.specialUserEnter,
					}
				: { enable: false, msgTemplate: "" },
	};
}

function subscriptionOpsToLive(
	ops: SubscriptionOp[],
	store: SubscriptionStore,
	subRuntimeStore: SubRuntimeStore,
	globals: GlobalConfig,
): LiveSubscriptionOp[] {
	const out: LiveSubscriptionOp[] = [];
	for (const op of ops) {
		// 同 subscriptionOpsToDynamic:直播引擎只管 B 站订阅。
		if (!fromBilibili(op.sub)) continue;
		const identity = subscriptionIdentityOf(op.sub);
		if (op.kind === "add") {
			// 禁用态新增不开监听器。新增订阅默认 enabled,此处为防御性兜底。
			if (!op.sub.enabled) continue;
			out.push({ kind: "add", sub: buildLiveSubViewSingle(op.sub, subRuntimeStore, globals) });
		} else if (op.kind === "remove") {
			out.push({ kind: "delete", uid: identity.externalId });
		} else {
			const sub = store.findByIdentity(identity);
			if (!sub) continue;
			// 禁用订阅 = 拆掉直播监听器。LiveEngine 是事件驱动(常驻 WS),没有每轮现读名单的兜底 —— update op 必须显式翻译
			// 成 delete,否则 listener 一直挂着、直播事件照推(已修 bug)。重新启用时
			// 走下面的 update 分支发完整 LiveScopedChange,LiveEngine.applyOps 见无
			// 活跃 listener → lookupFullSub → startForUid 重新拉起。
			if (!sub.enabled) {
				out.push({ kind: "delete", uid: identity.externalId });
				continue;
			}
			// 用完整 SubItemView 投影出所有 LiveScopedChange 支持的字段——路由布尔、
			// per-UP 阈值 / 调度 / AI override 之外,模板 / 上舰 / 特别关注 / 卡片样式
			// 也跟着一起同步,避免活跃 listener 用旧值(本来 add 路径就走这里,update
			// 没必要弱化语义)。周期间隔与开关变化由 engine 在 applyOps 内单独 rearm。
			const view = buildLiveSubViewSingle(sub, subRuntimeStore, globals);
			out.push({
				kind: "update",
				uid: identity.externalId,
				changes: [
					{
						scope: "live",
						liveStart: view.liveStart,
						liveStreaming: view.liveStreaming,
						liveEnd: view.liveEnd,
						membership: view.membership,
						superchat: view.superchat,
						extras: view.extras,
						// 键恒在(值可能是 undefined):没配 = 不设门槛,门槛被清掉的订阅得靠这个 undefined 把引擎里旧的那份盖掉。
						minSuperchatAmount: view.minSuperchatAmount,
						minGuardRank: view.minGuardRank,
						streamingIntervalHours: view.streamingIntervalHours,
						catchUpOnBoot: view.catchUpOnBoot,
						liveEndGrace: view.liveEndGrace,
						liveEndGraceMinutes: view.liveEndGraceMinutes,
						aiOverride: view.aiOverride,
						wordcloudStopWords: view.wordcloudStopWords,
						customCardStyle: view.customCardStyle,
						customLiveMsg: view.customLiveMsg,
						guardTemplate: view.guardTemplate,
						customLiveSummary: view.customLiveSummary,
						customSpecialDanmakuUsers: view.customSpecialDanmakuUsers,
						customSpecialUsersEnterTheRoom: view.customSpecialUsersEnterTheRoom,
						cardSkin: view.cardSkin,
						// 键恒在(值可能是 undefined):LiveEngine 按 Object.assign 合进活着的监听器,
						// 这位 UP「全部还原」之后得靠这个 undefined 把旧的那份盖掉。
						cardSkinKnobs: view.cardSkinKnobs,
						messageLayout: view.messageLayout,
					},
				],
			});
		}
	}
	return out;
}

function listLiveRooms(
	live: LiveEngine,
	subscriptionStore: Pick<SubscriptionStore, "findByIdentity">,
): LiveListenerSnapshot[] {
	// Only rooms that have reported `liveStatus === true` via the WS dispatcher
	// surface to the Dashboard. Monitored-but-idle rooms are filtered so the
	// "正在直播" panel matches its name (vs. the looser "正在监听" set).
	//
	// 每个房间带上订阅自己的 id(ADR-0019 决策 50),面板拿它对订阅。直播引擎只认 uid,在这儿翻;
	// 翻不到的不列 —— 监听器只为在册的 B 站订阅开,翻不到只可能是订阅刚删掉的那一瞬。
	const out: LiveListenerSnapshot[] = [];
	for (const s of live.listLiveSnapshots()) {
		if (!s.isLive) continue;
		const subscriptionId = subscriptionStore.findByIdentity(biliIdentity(s.uid))?.id;
		if (subscriptionId === undefined) continue;
		out.push({
			subscriptionId,
			uid: s.uid,
			roomId: s.roomId,
			isLive: s.isLive,
			title: s.title,
			cover: s.cover,
			areaName: s.areaName,
			startedAt: s.startedAt,
			viewers: s.viewers,
		});
	}
	return out;
}
