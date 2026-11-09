import {
	CookieJar,
	type FetchOptions,
	generateBrowserIdentity,
	HttpClient,
} from "@bilibili-notify/http";
import { buildFontFace } from "@bilibili-notify/image";
import { fail, type ImageRef, type MessageBus, resolve } from "@bilibili-notify/internal";
import { createKeyProvider, type KeyProvider } from "@bilibili-notify/storage";
import { type ConversationStore, createConversationStore } from "../ai/conversation-store.js";
import {
	type AiToolProviderRegistry,
	createAiToolProviderRegistry,
} from "../ai/tool-provider-registry.js";
import { flushAssetLabelWrites } from "../assets/asset-store.js";
import type { BootstrapConfig } from "../config/schema.js";
import { createSecretStore } from "../config/secret-store.js";
import { syncSettingsProblem } from "../config/settings-problems.js";
import {
	type ConfigStore,
	createConfigStore,
	type IntegrationSettingsSegment,
} from "../config/store.js";
import { syncSubscriptionsProblem } from "../config/subscriptions-problems.js";
import { createFollowersStore, type FollowersStore } from "../followers/store.js";
import { createRepushRunner, type RepushRunner } from "../history/repush-runner.js";
import { createRepushStore, listRepushImageRefs } from "../history/repush-store.js";
import { listHistoryImageRefs } from "../history/retention.js";
import { createHistoryStore, type HistoryStore } from "../history/store.js";
import { i18n, logText, t } from "../i18n/index.js";
import { createImageFetcher, type ImageFetcher } from "../images/image-fetcher.js";
import { IMAGE_REFERRERS } from "../images/image-referrers.js";
import { createImageStore, type ImageStore, type ImageWriter } from "../images/image-store.js";
import { createIntegrationStore, type IntegrationStore } from "../integration-store/store.js";
import { createLinkResolverRegistry, type LinkResolverRegistry } from "../link-preview/registry.js";
import { createLiveTable, type LiveTable } from "../live/live-table.js";
import { createLogStore, type LogStore } from "../logs/store.js";
import { createValueRedactor, type ValueRedactor } from "../logs/value-redactor.js";
import { createProblemTable, type ProblemTable } from "../problems/problem-table.js";
import { createPlatformAdapterRegistry, type PlatformAdapterRegistry } from "../push/registry.js";
import { flushSkinWrites } from "../skins/skin-store.js";
import { createStatsEnabled } from "../stats/enabled.js";
import { createStatsRecorder, type StatsRecorderHandle } from "../stats/recorder.js";
import { recordingSwitches } from "../stats/recording-switches.js";
import { createStatsStore, type StatsStore } from "../stats/store.js";
import { createSourceRegistry, type SourceRegistry } from "../subscriptions/registry.js";
import { createUptimeRecorder, type UptimeRecorder } from "../uptime/recorder.js";
import { createUptimeStore, type UptimeStore } from "../uptime/store.js";
import { createFontAssetReader } from "./font-assets.js";
import { createNodeMessageBus } from "./message-bus.js";
import type { PipelineRuntime } from "./pipeline.js";
import { createProfileCacheWriter, type ProfileCacheWriter } from "./profile-cache.js";
import type { ProfileRefreshHandle } from "./profile-refresh.js";
import { createProfileReportHandler, type ProfileReportHandler } from "./reported-profiles.js";
import { dataPath } from "./roots.js";
import { createNodeServiceContext, type NodeServiceContext } from "./service-context.js";
import { secretBootstrapValues } from "./settings-redaction.js";
import {
	createSubscriptionStateStore,
	type SubscriptionStateStore,
} from "./subscription-state-store.js";
import { createTargetScope } from "./target-scope.js";

export interface AppRuntime {
	bootstrap: BootstrapConfig;
	/**
	 * 宿主根:只放冻住的外壳认的宿主件(`versions/`、`logs/`),拼路径经 `hostPath`。
	 * 两个根只在 {@link createAppRuntime} 推这一次,下游一律读这里,不各自从配置里再推。
	 */
	readonly hostRoot: string;
	/** 数据根:其余一切,拼路径经 `dataPath`。 */
	readonly dataRoot: string;
	serviceCtx: NodeServiceContext;
	bus: MessageBus;
	/**
	 * Shared at-rest encryption key provider. Built once from
	 * `bootstrap.cookieEncryptionKey`; reused by the integration stores and
	 * the config SecretStore so one `BN_COOKIE_KEY` protects everything and
	 * exactly one scrypt salt is persisted.
	 */
	keyProvider: KeyProvider;
	/**
	 * 各集成(B 站、内置适配器、拓展)的 state / secrets 存储宿主。建时不碰盘,谁开谁读;`flush` 段关门。
	 * 备份导出 / 恢复密钥、卸载拓展时清存储也走它。
	 */
	integrationStore: IntegrationStore;
	/**
	 * 自带字体的读取口,**全进程唯一一个**。给 id 返回拼好的 `@font-face` 规则,
	 * 没选字体(空 id)返回空串。
	 *
	 * 为什么挂在这儿而不是各建各的:缓存里留的就是那条几十兆的规则,建两个读取器
	 * 就是同一份东西在堆里存两遍,而镜像里 V8 的 old-space 只有 512MB。推送渲染器
	 * 与预览路由都从这里取同一个,读盘、base64、拼规则一个进程只干一遍。
	 */
	loadFontFace: (id: string) => Promise<string>;
	configStore: ConfigStore;
	/**
	 * 推送出口的活登记表。**在配置仓之前建**:配置仓保存连接时要按在场适配器的 `settingsSchema` 验
	 * `settings`,它拿的是这张表现取的闭包。适配器的登记(内置 / 拓展)在 `index.ts` 里往后做。
	 */
	adapterRegistry: PlatformAdapterRegistry;
	/**
	 * 日志按值打码登记册的**登记口**(只有 `replace`,读 / 遮的一面在日志出口里):给核心自己登记设置里的机密值
	 * (`runtime/settings-redaction.ts`)。集成的值走各自的存储把手,不经这里。
	 */
	valueRedactor: Pick<ValueRedactor, "replace">;
	/** 订阅来源的登记表:建在这里、挂在运行时上,来源由 `pipeline.registerSource` 登进去。 */
	sourceRegistry: SourceRegistry;
	/** 链接解析器的登记表:来源在自己的 `start(ctx)` 里经 `ctx.registerLinkResolver` 登进去。 */
	linkResolvers: LinkResolverRegistry;
	/** AI 工具提供方的登记表:来源在自己的 `start(ctx)` 里经 `ctx.registerAiToolProvider` 登进去。 */
	aiToolProviders: AiToolProviderRegistry;
	/**
	 * 问题表:各集成(今天是订阅来源)报上来的「主人该知道的事」,全在内存。写口经来源上下文
	 * (`reportProblem`),读口是 `GET /api/problems`;变了发 `problems-changed`。
	 */
	problems: ProblemTable;
	historyStore: HistoryStore;
	/**
	 * 人工重推(ADR-0017)。它持有「哪些行正在补」那张表,所以**整个进程只能有一个** ——
	 * 每请求现建一个,并发挡就等于没有,两个标签页各点一下真会往群里多发一条。
	 */
	repushRunner: RepushRunner;
	fansStore: FollowersStore;
	/**
	 * 「UP 产出」时序(动态事件 + 直播场次),数据统计 Tab 的数据源。写侧是
	 * StatsRecorder(订阅总线,随 runtime 一起起停),读侧是 `/api/stats`。
	 */
	statsStore: StatsStore;
	/** 统计采集。构造时只挂上总线;「在记」由登记表适配按在册来源记,开机时登记表还空、不碰盘,来源登记之后最多 1 分钟记上。 */
	statsRecorder: Pick<
		StatsRecorderHandle,
		"compactRecording" | "clear" | "drop" | "recordActive" | "recordFollowers"
	>;
	/**
	 * 数据统计的总开关(`stats.enabled`)的缓存读口 —— 记录器入口用的就是它,B 站粉丝轮询(直接写粉丝仓、
	 * 绕开记录器)由 `index.ts` 从这里取去用。设置变了下一次读就是新值,不用重启。
	 */
	isStatsEnabled: () => boolean;
	/**
	 * Per-subscription runtime data (display cache + fans anchor), externalized
	 * out of the persisted `Subscription` config so profile refresh's per-tick
	 * `cachedProfile` writes no longer fan out as `config-changed:subscriptions`.
	 * Loaded alongside configStore; consumed by profile refresh / pipeline / the
	 * `/api/subscriptions` join.
	 */
	subscriptionStateStore: SubscriptionStateStore;
	/** 运行记录(ADR-0033 决策 3):每个 UTC 整点小时里 BN 跑了多少分钟。不算数据统计,与 `statsStore` 无关。 */
	uptimeStore: UptimeStore;
	/** 运行记录的记录器。构造时不碰盘、不排定时器;`index.ts` 在数据那一代就位之后 `start()`,关停的 flush 段补记并停表。 */
	uptimeRecorder: UptimeRecorder;
	/**
	 * 图库 `<dataRoot>/images/`(ADR-0022 决策 9):所有图按内容摘要存一份,引用就是文件名。全进程共用这一个;
	 * `GET /api/images/:ref` 读。
	 */
	imageStore: ImageStore;
	/**
	 * 女仆 AI 聊天往图库存图的口:上传的附件 `put`,发消息时把请求里带的图 `keep`(续期)。图库的存图口只有登记成
	 * 引用方才拿得到 —— 这一家引用的是会话里的 `images`(`conversationStore.listImageRefs`),装配时登记。
	 */
	chatImages: ImageWriter;
	/**
	 * 订阅头像往图库存图的口(ADR-0019 决策 49;头像进图库见 ADR-0022 决策 9 下 10-04「⑳ 开片」的 🔗):新建订阅
	 * 那条路、拓展「报资料更新」与 B 站头像的抓取(3a-35,经抓图服务)存头像,资料缓存里放回来的引用。这一家引用的是资料缓存里的 `avatar`
	 * (`subscriptionStateStore.listImageRefs`),装配时登记。
	 */
	profileImages: ImageWriter;
	/**
	 * 资料缓存的**唯一**写口(全进程一个):资料刷新与资料上报共用。按订阅 id 串行,提交前现查订阅还在不在 ——
	 * 两条路交错写同一条订阅时后落地的那条不会用旧资料盖回去。关停的 `flush` 段 `close()`。
	 */
	profileCache: ProfileCacheWriter;
	/**
	 * 来源经 `ctx.reportProfile` 报的资料的收口(`createProfileReportHandler`):`createPipelineRuntime` 把它递给来源上下文的
	 * `profiles` 选项。写资料缓存(经 {@link AppRuntime.profileCache})、记粉丝样本、写完叫资料刷新(现取
	 * {@link AppRuntime.profileRefresh})重算面板那几行。
	 */
	profileReports: ProfileReportHandler;
	/**
	 * 账号头像往图库存图的口:来源的登录系统(今天是 B 站的)登录后与头像网址变了时抓头像、存进图库。这一家引用的是
	 * 在册来源 `auth.account().avatar`(现读来源登记表),装配时登记。
	 */
	accountImages: ImageWriter;
	/** 作品输入里的图往图库存的口:真实卡片预览也经它抓图。 */
	postImages: ImageWriter;
	/**
	 * 宿主自己的抓图口:核心要抓的图(今天是会员上舰消息的自定义图)经它抓进图库。走 BN 自己的请求客户端
	 * (空罐子、不带 cookie),不借任何集成的;图存进「集成在途」那一家({@link AppRuntime.transitImages})。
	 */
	imageFetcher: Pick<ImageFetcher, "fetchImage">;
	/**
	 * 集成往图库存图的口(ADR-0025 决策 8):每个集成上下文的 `ctx.fetchImage` / `ctx.storeImage` 都经它,宿主自己的
	 * 抓图口({@link AppRuntime.imageFetcher})也是。集成抓到的图是
	 * **在途数据**:名单恒空(`listRefs` 恒空),图靠清扫的 24 小时宽限期活到被历史行、资料缓存、在播表、登录状态等
	 * 哪一家引用上;只攥在集成自己手里、没交给宿主的引用,过了宽限期就被收走(契约里写明)。
	 */
	transitImages: ImageWriter;
	/**
	 * 推送历史往图库存图的口:配图 `put`、拓展行的头像快照 `keep`(续期)。历史仓用它存图;这一家引用方登记的名单是
	 * 保留期内(水位线之后)的日文件里所有 `image` 与 `avatarSnapshot`(`listHistoryImageRefs`)。重推原件是另一家引用方
	 * (`listRepushImageRefs`),各登记各的 —— 拿到的是同一个口,这里只暴露历史这一份。
	 */
	historyImages: ImageWriter;
	/**
	 * 女仆 AI 聊天的会话记录(dashboard 聊天侧栏「最近」的数据源)。刻意与
	 * pipeline 解耦 —— AI 没配好时会话照样能建能列,页面才有地方摆「去把 key
	 * 填上」这句话。
	 */
	conversationStore: ConversationStore;
	/**
	 * jsonl-by-day log archive. Fed (post-redaction) by the log sink installed
	 * in index.ts; queried by the `/api/system/logs` route. No floor — level gating is
	 * upstream in service-context `fanOut`, so the archive equals the live Tab
	 * equals the console, all driven by the per-module pino level.
	 */
	logStore: LogStore;
	/**
	 * 在播表(ADR-0019 决策 12 / 57 / 61):首页「正在直播」里的那些订阅。只听总线(订阅增删改、
	 * 拓展停了),所以与 StatsRecorder 一样在这里就起;`/api/live/listening` 读它。
	 */
	liveTable: LiveTable;
	/**
	 * Push-pipeline layer: TargetDispatcher + PushRouter + post queue + live runtime
	 * + connection probing.
	 *
	 * `null` until {@link attachPipeline} is called. The login system is no longer a boot
	 * step of its own: the bilibili source builds, starts and stops it, so the bootstrap split is:
	 *
	 *   1. createAppRuntime(bootstrap) — produces ConfigStore + HistoryStore
	 *   2. keyProvider.getKey() — eagerly loads/creates the at-rest secrets key
	 *   3. configStore.load()
	 *   4. createPipelineRuntime(...) — then `builtins.registerSources(pipeline)` opens the bilibili
	 *      context and registers the bilibili source (its `start` brings the login up)
	 *   5. attachPipeline(runtime, pipeline) — fills `pipeline`
	 *   6. createApp(runtime, ...) — mounts routes
	 */
	pipeline: PipelineRuntime | null;
	attachPipeline(pipeline: PipelineRuntime): void;
	/**
	 * ProfileRefresh handle (cron 跟 globals.profileRefreshCron 刷新每个 enabled sub 的
	 * 资料并 emit `followers-refreshed`)。`null` 直到 attachPipeline 完成 + 启动
	 * 完成后由 index.ts 注入;Routes 通过 `runtime.profileRefresh?.getLastEntries()` 读
	 * 最近一轮快照。
	 */
	profileRefresh: ProfileRefreshHandle | null;
	attachProfileRefresh(refresh: ProfileRefreshHandle): void;
	/** 关停:分段跑收尾钩子,预算见 `NodeServiceContext.dispose`。再调一次拿到的是同一次关停。 */
	dispose(options?: { timeoutMs?: number; flushReserveMs?: number }): Promise<void>;
}

/**
 * Glues a parsed bootstrap config + a fresh NodeServiceContext + NodeMessageBus + ConfigStore
 * into a single object. Higher layers (Hono routes, pipeline, sinks) consume this.
 *
 * Stage 2.1 keeps this minimal — no pipeline, no API client, no dispatcher. Those wire in stage 2.2+.
 */
export interface AppRuntimeRoots {
	/**
	 * 这次开机用的那一代(`runtime/generations.ts` 选出来的 `generations/<序号>/`)。要开新代时,它是
	 * 还没改名的正式路径:构造期不读盘,数据段迁完、改完名才有人去读。宿主根照旧取 `bootstrap.dataDir`。
	 */
	dataRoot: string;
}

/** 装配时可换的外部依赖;不给就用真的。 */
export interface AppRuntimeDeps {
	/** 各集成的设置段(配置仓构造时定死):入口递内置集成那份(`compose.ts` 的 `BUILTIN_INTEGRATION_SETTINGS`)。 */
	integrationSettings: readonly IntegrationSettingsSegment[];
	/** 测试用:统计看登记表记「在记」的间隔。生产不传,缺省 1 分钟。 */
	statsRecordingCheckMs?: number;
	/** 测试用:宿主抓图口连接之前对地址的检查。生产不传,缺省拦内网(`requirePublicAddress`)。 */
	imageAddressCheck?: FetchOptions["addressCheck"];
}

export function createAppRuntime(
	bootstrap: BootstrapConfig,
	roots: AppRuntimeRoots,
	deps: AppRuntimeDeps,
): AppRuntime {
	// 日志按值打码的登记册,**整个运行时只建这一个**:先于日志上下文建,日志出口从第一行就按它遮;
	// 交给集成存储宿主(下面,各集成的值经存储把手登记)与运行时上的登记口(核心设置里的机密值),不再往别处转手。
	const valueRedactor = createValueRedactor();
	// 引导配置里标了机密的格（面板密码、口令）：开机就在手上，建日志上下文之前登记，日志从第一行就遮。
	valueRedactor.replace("core", "bootstrap", secretBootstrapValues(bootstrap));
	const serviceCtx = createNodeServiceContext({
		name: "core",
		level: bootstrap.logLevel,
		valueRedactor,
	});
	// 监听者异步 reject 经 logger 报:过入口打码、进面板日志页与归档(总线本身不持 logger)。
	const bus = createNodeMessageBus({
		onHandlerError: (event, error) =>
			serviceCtx.logger.error(logText("log.host.asyncHandlerFailed"), { event }, error),
	});
	const hostRoot = bootstrap.dataDir;
	const { dataRoot } = roots;

	// Shared at-rest encryption key. Injected passphrase (BN_COOKIE_KEY) →
	// scrypt-derived key, never written to disk = real protection. Absent →
	// co-located random key file (obfuscation only; loud warning below).
	const keyProvider = createKeyProvider({
		passphrase: bootstrap.cookieEncryptionKey,
		keyPath: dataPath(dataRoot, "secrets", "master.key"),
		saltPath: dataPath(dataRoot, "secrets", "kdf.salt"),
		logger: serviceCtx.logger,
	});
	if (keyProvider.protected) {
		serviceCtx.logger.info(logText("log.storage.encryptionEnabled"), {
			event: "storage.encryption_enabled",
			algorithm: "AES-256-GCM",
			source: "BN_COOKIE_KEY",
		});
	} else {
		// 通用「仅混淆」告警已由 createKeyProvider 统一发出;这里只补服务端
		// 专属的可执行指引(设置 BN_COOKIE_KEY)。
		serviceCtx.logger.warn(logText("log.storage.encryptionAdvice"), {
			event: "storage.encryption_advice",
			source: "BN_COOKIE_KEY",
		});
	}

	const secretStore = createSecretStore({
		filePath: dataPath(dataRoot, "secrets", "config-secrets.enc"),
		keyProvider,
		logger: serviceCtx.logger,
	});
	// 各集成的 state / secrets 存储宿主,与 `config-secrets.enc` 用同一把主密钥。建的时候不读盘 —— 谁开
	// (B 站、内置适配器、装载器)谁读。写道在 flush 段关门:各生产者已停,还在路上的写落完,之后的写被拒,
	// 关停返回之后数据目录里它的文件不再变。
	const integrationStore = createIntegrationStore({
		reservedIntegrationKeys: deps.integrationSettings.map((segment) => segment.key),
		dataRoot,
		keyProvider,
		logger: serviceCtx.logger,
		redactor: valueRedactor,
	});
	serviceCtx.onDispose(() => integrationStore.close(), "flush");
	// 推送出口的活登记表:没有任何依赖,先建,配置仓才能按在场适配器的规则验连接设置。
	const adapterRegistry = createPlatformAdapterRegistry();
	// 订阅来源的登记表(内置来源由 `compose.ts` 经 `pipeline.registerSource` 登进去)。
	const sourceRegistry = createSourceRegistry();
	const linkResolvers = createLinkResolverRegistry();
	const aiToolProviders = createAiToolProviderRegistry();
	// 问题表:变了(按报的人合并过)发 `problems-changed`。表是总线的生产者,不是转发器。
	const problems = createProblemTable({
		logger: serviceCtx.logger,
		onChanged: (reporter) => bus.emit("problems-changed", { reporter }),
		// 宿主交的是取字函数,换语言或口吻时由表重跑(见 `problems/problem-table.ts` 文件头「换语言」)。
		texts: {
			locale: () => i18n.state().locale,
			onChange: (fn) => ({ dispose: i18n.subscribe(fn) }),
		},
	});
	serviceCtx.onDispose(() => problems.dispose(), "stop");
	// 各集成的设置段由组装根交进来(`compose.ts`),这里不认得是哪个集成。
	const configStore = createConfigStore({
		bootstrap,
		dataRoot,
		bus,
		serviceCtx,
		secretStore,
		integrationSettings: deps.integrationSettings,
		connectionSettingsSchemaOf: (adapterKey) =>
			adapterRegistry.list().find((a) => a.adapterKey === adapterKey)?.settingsSchema,
		// 隔离订阅只交数量,核心坏格只交安全原因:各合成一条问题,不私聊。
		onInvalidSubscriptionsChanged: (count) => syncSubscriptionsProblem(problems, count),
		onInvalidSettingsChanged: () =>
			syncSettingsProblem(
				problems,
				() => configStore.getInvalidSettings().map(({ path, issues }) => ({ path, issues })),
				serviceCtx.logger,
			),
	});
	// 连接没了,关于它的问题跟着清(不补「已恢复」)。路由删除与恢复备份整表换都发 `config-changed { connections }`,
	// 事件不带改动内容,所以拿此刻的连接 id 集合比一遍;先看表里有没有连接支,没有就不拷整张连接表。
	// 放在这里而不在 `pipeline.ts`:那里是推送链路的装配,问题表与配置仓都在这一层。
	const connectionSweep = bus.on("config-changed", ({ scope }) => {
		if (scope !== "connections") return;
		const reported = new Set<string>();
		for (const problem of problems.list()) {
			if (problem.about && "connectionId" in problem.about)
				reported.add(problem.about.connectionId);
		}
		if (reported.size === 0) return;
		const alive = new Set(configStore.getConnections().map((c) => c.id));
		for (const id of reported) if (!alive.has(id)) problems.clearConnection(id);
	});
	serviceCtx.onDispose(() => connectionSweep.dispose(), "stop");
	// 写道在 flush 段落盘并关门:此时 HTTP 已排空、各生产者已停,还在路上的配置写(如送达回调写回的目标可达性,
	// 那处发出去就不管)在这里等到落盘,关停返回之后 `state/` 不再变。
	serviceCtx.onDispose(() => configStore.close(), "flush");
	// 模块级的两条写道(皮肤门面、资产库的原名清单)住在同一个进程的所有实例之间,所以只 flush、不关门 ——
	// 关了它们,同一进程里下一个起的服务就写不进了。
	serviceCtx.onDispose(() => flushSkinWrites(), "flush");
	serviceCtx.onDispose(() => flushAssetLabelWrites(), "flush");
	// 图库先建、先登记关门:历史仓与重推原件往里存图,同段后登记的先跑,所以图库的 `close` 得排在历史仓
	// `close` 的登记之前 —— 历史仓先把在途的写(含它的图)落完,图库才关门;反过来的话关停时在途那一行的图存不进去。
	const imageStore = createImageStore({ dir: dataPath(dataRoot, "images") });
	// 来源声明的图:名单现读来源登记表里的描述符。B 站启动后补进各档 `icon.ref` 的徽章图
	// 因此一写上就有人引用,不必再由组装根把一份抓图器交给运行时。
	imageStore.register({
		name: IMAGE_REFERRERS.sourceDeclared,
		listRefs: async () =>
			sourceRegistry
				.list()
				.flatMap((view) =>
					(view.descriptor.membershipPrograms ?? []).flatMap((program) =>
						Array.isArray(program.tiers)
							? program.tiers.flatMap((tier) =>
									tier.icon?.ref === undefined ? [] : [tier.icon.ref],
								)
							: [],
					),
				),
	});
	serviceCtx.onDispose(() => imageStore.close(), "flush");
	// 推送历史是图库的一家引用方:保留期内的日文件里的配图与头像快照。名单直接读盘(不经历史仓实例),
	// 所以先登记、再把存图的口交给历史仓,没有先有鸡还是先有蛋的问题。
	const historyImages = imageStore.register({
		name: IMAGE_REFERRERS.history,
		listRefs: () => listHistoryImageRefs(dataRoot),
	});
	// 重推原件是另一家:盘上每份原件里的图(原件按保留期整天清,留着的都是活的)。
	const repushImages = imageStore.register({
		name: IMAGE_REFERRERS.repush,
		listRefs: () => listRepushImageRefs(dataRoot),
	});
	// 重推原件(ADR-0017):历史仓每次落行 / 追加时顺手留一份没有损耗的原料。
	// 它没有内部状态;保留期的清扫直接按日子端目录(`dropRepushDay`),不经这个实例。
	const repushStore = createRepushStore({
		dataRoot,
		logger: serviceCtx.logger,
		images: repushImages,
		imageStore,
	});
	const historyStore = createHistoryStore({
		dataRoot,
		bus,
		logger: serviceCtx.logger,
		images: historyImages,
		repush: repushStore,
	});
	serviceCtx.onDispose(() => historyStore.close(), "flush");
	const fansStore = createFollowersStore({
		dataRoot,
		logger: serviceCtx.logger,
	});
	// 粉丝样本的写(轮询追加、记录器代拓展追加、定时压缩)同走仓里按订阅的队。同段后登记的先跑:这一行必须排在
	// 记录器收尾(下面 statsRecorder 那条 flush 钩子)**之前**登记,记录器排着的粉丝写才落得进还开着的仓。
	serviceCtx.onDispose(() => fansStore.close(), "flush");
	const statsStore = createStatsStore({
		dataRoot,
		logger: serviceCtx.logger,
	});
	// Recorder 只订阅总线、不碰推送链路,所以在这里就能起 —— 不必等 attachPipeline。
	// 早起一点反而更稳:来源一开始 emit 就有人接着,不会漏掉启动瞬间的事件。
	//
	// 来源在记由登记表统一记,直播场次由中立的 `live-session-changed` 统一记。
	// 数据统计总开关(`stats.enabled`):一个缓存布尔,设置变了作废。记录器入口与粉丝轮询共用这一个。
	const statsEnabled = createStatsEnabled({ bus, getGlobals: () => configStore.getGlobals() });
	const statsRecorder = createStatsRecorder({
		bus,
		store: statsStore,
		followers: fansStore,
		sources: sourceRegistry,
		isEnabled: statsEnabled.isEnabled,
		recordingCheckMs: deps.statsRecordingCheckMs,
		logger: serviceCtx.logger,
		// 判订阅在不在、启用着没有、两格「在记」条件(启用着 ∧ 作品开关 / 直播类开关,取有效值)。
		// 读的是配置仓,开机时它在推送链路发出第一条事件之前就载好了。
		subscriptions: () => {
			const { defaults } = configStore.getGlobals();
			return configStore.getSubscriptions().map((sub) => {
				const switches = recordingSwitches(resolve(sub, defaults).features, sub.specialViewers);
				return {
					id: sub.id,
					identity: sub.identity,
					enabled: sub.enabled,
					recordsPosts: sub.enabled && switches.posts,
					recordsLive: sub.enabled && switches.live,
				};
			});
		},
	});
	serviceCtx.onDispose(async () => {
		// 排在 flush 段:生产者都停了、后台活都落定了,这时补的下播帧才是最后一帧。
		// 先给在播的场次补下播帧,再解绑 —— 顺序反了就没人记得谁还在播。
		// dispose() 会 await 这个钩子,所以写盘赶得及在进程退出前完成。拓展直播的场次在更早的关机步骤里
		// (拓展收摊、推送链路拆)就结束了、下播帧已经交出去;closeOpenSessions 等到它们也落地才返回,
		// 且不会给它们补第二帧。
		await statsRecorder.closeOpenSessions();
		statsRecorder.dispose();
		statsEnabled.dispose();
	}, "flush");
	// 运行记录:整点记一行、关停补一行。不挂总线、不依赖统计,单独一条;`start()` 在 index.ts 里等数据那一代就位。
	const uptimeStore = createUptimeStore({ dataRoot, logger: serviceCtx.logger });
	const uptimeRecorder = createUptimeRecorder({ store: uptimeStore, logger: serviceCtx.logger });
	serviceCtx.onDispose(async () => {
		// 先补记当前这一小时、停表,再关仓门 —— 反过来补的那一行会被拒掉。
		await uptimeRecorder.stop();
		await uptimeStore.close();
	}, "flush");
	const subscriptionStateStore = createSubscriptionStateStore({
		dataRoot,
		logger: serviceCtx.logger,
	});
	serviceCtx.onDispose(() => subscriptionStateStore.close(), "flush");
	// 订阅资料是图库的一家引用方:拓展订阅的头像由资料缓存交名单,清扫据此留下还在资料里的图。订阅被删之后
	// 资料缓存里没了这一条,头像就不再被引用、由清扫收走 —— 没有「删订阅顺手删头像文件」这一步。
	const profileImages = imageStore.register({
		name: IMAGE_REFERRERS.profiles,
		listRefs: () => subscriptionStateStore.listImageRefs(),
	});
	// 账号头像是图库的一家引用方:名单从来源登记表现读(每个在册来源登录着的账号的头像),不点名哪个来源 ——
	// 以后别的来源交了 `auth.account()` 自动进名单。登录这套在登记表之外抓、存(`accountImages`),重启后重抓;
	// 重启到重抓成功之间名单为空,靠新图 24 小时的宽限期不被清。
	const accountImages = imageStore.register({
		name: IMAGE_REFERRERS.accounts,
		listRefs: async () =>
			sourceRegistry.list().flatMap((view) => {
				const avatar = view.auth?.account?.()?.avatar;
				return avatar === undefined ? [] : [avatar];
			}),
	});
	// 资料缓存只有这一个写口:资料刷新(在 `index.ts` 里起)与来源报的资料都经它写,按订阅 id 串行、
	// 提交前现查订阅还在不在(删订阅排的 prune 因此一定在它之后)。
	const profileCache = createProfileCacheWriter({
		bus,
		subscriptionState: subscriptionStateStore,
		images: profileImages,
		subscription: (id) => configStore.getSubscription(id),
		logger: serviceCtx.logger,
	});
	// 🔴 顺序承重:它往图库与资料缓存仓写,所以这条必须登记在那两家的 close 之后 —— 同段后登记的先跑,
	// 它先把在途的写走空,那两家才关门;反过来的话在途的写会被拒、这次资料更新就丢了。
	serviceCtx.onDispose(() => profileCache.close(), "flush");
	// 来源经 `ctx.reportProfile` 报的资料(3b-42):不听总线,由推送链路把它递给来源上下文。写上面那个资料缓存。
	// 写完叫资料刷新重算面板那几行 —— 资料刷新在开机更后面才建(`attachProfileRefresh`),所以现取;
	// 还没建好时面板还没有快照,什么都不用做。
	const profileReports = createProfileReportHandler({
		profileCache,
		subscription: (id) => configStore.getSubscription(id),
		recorder: statsRecorder,
		profileRefreshCron: () => configStore.getGlobals().profileRefreshCron,
		refreshReportedEntries: async (ids) => {
			await profileRefresh?.refreshReportedEntries(ids);
		},
		logger: serviceCtx.logger,
	});
	serviceCtx.onDispose(() => profileReports.dispose(), "stop");
	// 🔴 顺序承重:它等的是上面那个 writer 写完在途的那条,所以这条必须登记在 writer 的 close 之后 ——
	// 同段后登记的先跑,它先把在途的那条写完,writer 与那两家 store 才关门。
	serviceCtx.onDispose(() => profileReports.close(), "flush");
	const conversationStore = createConversationStore({
		dataRoot,
		logger: serviceCtx.logger,
	});
	serviceCtx.onDispose(() => conversationStore.close(), "flush");
	// 女仆对话是图库的一家引用方:会话里的图由会话库交名单,清扫据此留下还在对话里的图。关停顺序没有承重点 ——
	// 登记只是把名单口交给图库,会话库不往图库写;清扫登记在 track 里,关停先等它跑完才进 flush 段。
	const chatImages = imageStore.register({
		name: IMAGE_REFERRERS.chat,
		listRefs: () => conversationStore.listImageRefs(),
	});
	// 作品输入里的图(今天只有卡片的真实预览经它抓图)是图库的一家引用方,但它**没有东西可列**:作品是在途数据,
	// 不落盘,图只在出卡那一刻要用。所以名单恒空,图全靠新图 24 小时的宽限期活到卡片画完;卡画完、没有哪家引用(历史行的配图是
	// 推送时另存的一份,头像抄的是资料缓存里的引用),下一轮清扫就收走。名单不会因为「列不出」而抛 —— 空就是空。
	const postImages = imageStore.register({
		name: IMAGE_REFERRERS.posts,
		listRefs: async () => [],
	});
	// 集成在途是图库的一家引用方,同样**没有东西可列**:集成经上下文抓 / 存的图在它手里只是引用,落进历史行、资料缓存
	// 之类才有人认领;名单恒空,过了宽限期没人认领的下一轮清扫收走。每个集成共用这一个写口。
	const transitImages = imageStore.register({
		name: IMAGE_REFERRERS.inTransit,
		listRefs: async () => [],
	});
	// 宿主自己的抓图口:BN 自己的请求不走集成的客户端(集成副作用规范「边界与例外」)—— 集成的客户端带着它的身份与
	// cookie。罐子是空的,抓图又只外发不摄入,所以永远不带 cookie;图存进在途那一家。客户端攒着连接池,关停时收。
	const hostHttp = new HttpClient({ jar: new CookieJar(), identity: generateBrowserIdentity() });
	serviceCtx.onDispose(() => hostHttp.dispose(), "stop");
	const imageFetcher = createImageFetcher({
		http: hostHttp,
		images: transitImages,
		...(deps.imageAddressCheck ? { addressCheck: deps.imageAddressCheck } : {}),
	});
	const logStore = createLogStore({
		hostRoot,
		serviceCtx,
		logger: serviceCtx.logger,
	});
	// 在播表:早起造好,不漏来源开机第一轮报上来的直播状态(拓展在 index.ts 里装载,晚于这里)。写表的是场次引擎
	// (`pipeline.ts`),表自己只听作废的两处。
	const liveTable = createLiveTable({ bus });
	serviceCtx.onDispose(() => liveTable.dispose(), "stop");
	// 直播是图库的一家引用方:在播表各行 `LiveDetails` 里的封面与主播头像(都是图库引用)。在播表只在内存,所以
	// 名单是「此刻在播的那些行」;一场播过 24 小时,周期卡几小时后还要用它们,这份名单让清扫不把它们当垃圾。
	imageStore.register({
		name: IMAGE_REFERRERS.live,
		listRefs: async () =>
			liveTable
				.list()
				.flatMap((row) => [row.details.cover?.ref, row.details.creator?.avatar])
				.filter((ref): ref is ImageRef => ref !== undefined),
	});

	let pipeline: PipelineRuntime | null = null;
	let profileRefresh: ProfileRefreshHandle | null = null;

	/**
	 * 路由 + 目标启停的快照。列表端点要为**每一行**失败的历史问一次闸,而 ConfigStore 的
	 * 三个 getter 全是整份深拷贝 —— 一页 200 行全红时那是 600 份副本。随 `config-changed`
	 * 失效,惰性重建(为什么不能预建见 target-scope.ts 文件头)。
	 */
	const targetScope = createTargetScope({ configStore, bus });
	serviceCtx.onDispose(() => targetScope.dispose(), "stop");

	/**
	 * 重推的执行器。发送口**惰性**拿 `pipeline` —— 它是后挂的(见 AppRuntime 那段分期
	 * 说明),而这里已经要把 runner 交出去了;那张「正在补哪几行」的表必须只有一份。
	 *
	 * 发的是 `push.sendToTarget`:退避重试与每次重试前的 routing 复检都自带,而静音 /
	 * 免扰 / 特性总开关三道在它上游 —— 走这条路它们天然不参与(ADR-0017 决策 10-12)。
	 */
	const repushRunner = createRepushRunner({
		history: historyStore,
		repush: repushStore,
		send: async (targetId, payload, routing) => {
			if (!pipeline) return fail("unavailable", t("config.store.pipelineNotReady"));
			return pipeline.push.sendToTarget(targetId, payload, { routing });
		},
		routedTargets: (subscriptionId, feature) => targetScope.routedTargets(subscriptionId, feature),
		currentSubscriptionOf: (row) => targetScope.currentSubscriptionOf(row),
		targetEnabled: (targetId) => targetScope.targetEnabled(targetId),
		logger: serviceCtx.logger,
		serviceCtx,
	});

	return {
		bootstrap,
		hostRoot,
		dataRoot,
		serviceCtx,
		bus,
		keyProvider,
		integrationStore,
		// 缓存里留拼好的 `@font-face` 而不是 data URL —— 规则本身就把 data URL 包在
		// 里头,只留它就少留一整份几十兆的串。闲置到点自动放掉,见读取器内部说明。
		loadFontFace: createFontAssetReader(dataRoot, { transform: buildFontFace }),
		configStore,
		adapterRegistry,
		valueRedactor,
		sourceRegistry,
		linkResolvers,
		aiToolProviders,
		problems,
		historyStore,
		repushRunner,
		fansStore,
		statsStore,
		statsRecorder,
		isStatsEnabled: statsEnabled.isEnabled,
		uptimeStore,
		uptimeRecorder,
		subscriptionStateStore,
		imageStore,
		chatImages,
		profileImages,
		profileCache,
		profileReports,
		accountImages,
		postImages,
		imageFetcher,
		transitImages,
		historyImages,
		conversationStore,
		logStore,
		liveTable,
		get pipeline() {
			return pipeline;
		},
		attachPipeline(next: PipelineRuntime) {
			pipeline = next;
		},
		get profileRefresh() {
			return profileRefresh;
		},
		attachProfileRefresh(next: ProfileRefreshHandle) {
			profileRefresh = next;
		},
		dispose: (options) => serviceCtx.dispose(options),
	};
}
