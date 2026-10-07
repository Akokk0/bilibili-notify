import { CookieJar, generateBrowserIdentity, HttpClient } from "@bilibili-notify/http";
import { buildFontFace } from "@bilibili-notify/image";
import { type ImageRef, type MessageBus, resolve } from "@bilibili-notify/internal";
import { createKeyProvider, type KeyProvider } from "@bilibili-notify/storage";
import { type ConversationStore, createConversationStore } from "../ai/conversation-store.js";
import { flushAssetLabelWrites } from "../assets/asset-store.js";
import {
	createGuardIcons,
	GUARD_ICON_REQUEST_HEADERS,
	type GuardIcons,
} from "../bilibili/live/guard-icons.js";
import { settingsSegment } from "../bilibili/settings.js";
import type { BootstrapConfig } from "../config/schema.js";
import { createSecretStore } from "../config/secret-store.js";
import { type ConfigStore, createConfigStore } from "../config/store.js";
import { createFollowersStore, type FollowersStore } from "../followers/store.js";
import { createRepushRunner, type RepushRunner } from "../history/repush-runner.js";
import { createRepushStore, listRepushImageRefs } from "../history/repush-store.js";
import { listHistoryImageRefs } from "../history/retention.js";
import { createHistoryStore, type HistoryStore } from "../history/store.js";
import { createImageFetcher } from "../images/image-fetcher.js";
import { IMAGE_REFERRERS } from "../images/image-referrers.js";
import {
	createImageStore,
	type ImageStore,
	type ImageWriter,
	imageRefOf,
} from "../images/image-store.js";
import { createLogStore, type LogStore } from "../logs/store.js";
import { flushSkinWrites } from "../skins/skin-store.js";
import { createStatsEnabled } from "../stats/enabled.js";
import { createStatsRecorder, type StatsRecorderHandle } from "../stats/recorder.js";
import { recordingSwitches, specialUserFlagsOf } from "../stats/recording-switches.js";
import { createStatsStore, type StatsStore } from "../stats/store.js";
import { createUptimeRecorder, type UptimeRecorder } from "../uptime/recorder.js";
import { createUptimeStore, type UptimeStore } from "../uptime/store.js";
import type { EnginesRuntime } from "./engines.js";
import { createExtensionLiveTable, type ExtensionLiveTable } from "./extension-live.js";
import type { FansPollerHandle } from "./fans-poller.js";
import { createFontAssetReader } from "./font-assets.js";
import { createNodeMessageBus } from "./message-bus.js";
import { bindReportedProfiles } from "./reported-profiles.js";
import { dataPath } from "./roots.js";
import { createNodeServiceContext, type NodeServiceContext } from "./service-context.js";
import { createSubRuntimeStore, type SubRuntimeStore } from "./sub-runtime-store.js";
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
	 * `bootstrap.cookieEncryptionKey`; reused by the cookie StorageManager and
	 * the config SecretStore so one `BN_COOKIE_KEY` protects everything and
	 * exactly one scrypt salt is persisted.
	 */
	keyProvider: KeyProvider;
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
	/** 统计采集。构造时只挂上总线、不碰盘;登录系统建好后 `bindLoginState` 回填 B 站登录读口,绑上才开始记 B 站的「在记」。 */
	statsRecorder: Pick<StatsRecorderHandle, "bindLoginState" | "compactRecording" | "clear">;
	/**
	 * 数据统计的总开关(`stats.enabled`)的缓存读口 —— 记录器入口用的就是它,B 站粉丝轮询(直接写粉丝仓、
	 * 绕开记录器)由 `index.ts` 从这里取去用。设置变了下一次读就是新值,不用重启。
	 */
	isStatsEnabled: () => boolean;
	/**
	 * Per-subscription runtime data (display cache + fans anchor), externalized
	 * out of the persisted `Subscription` config so FansPoller's per-tick
	 * `cachedProfile` writes no longer fan out as `config-changed:subscriptions`.
	 * Loaded alongside configStore; consumed by FansPoller / engines / the
	 * `/api/subscriptions` join.
	 */
	subRuntimeStore: SubRuntimeStore;
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
	 * 拓展订阅的头像往图库存图的口(ADR-0019 决策 49;头像进图库见 ADR-0022 决策 9 下 10-04「⑳ 开片」的 🔗):新建订阅
	 * 那条路与拓展「报资料更新」存头像,资料缓存里放回来的引用。这一家引用的是资料缓存里的 `avatar`
	 * (`subRuntimeStore.listImageRefs`),装配时登记。
	 */
	profileImages: ImageWriter;
	/**
	 * 拓展作品往图库存图的口(ADR-0021 决策 22 下 2026-10-05 的 🔗,㉑d):收到上报、出卡前把配图与视频封面(以及随事件
	 * 带来的作者头像)`put` 进图库,`Post` 里只放引用,出卡器按引用读图。作品是**在途数据、不落盘**,这一家没有引用可列
	 * (`listRefs` 恒空),存进去的图靠清扫的 24 小时宽限期活到卡片画完 —— 登记它的意义是拿到存图的口,不是留图。
	 */
	postImages: ImageWriter;
	/**
	 * 拓展直播往图库存图的口(ADR-0021 决策 22 / 24 下 2026-10-05 的 🔗,㉒c):出每张直播卡的那一刻把封面与事件带来的
	 * 作者头像 `put` 进图库,卡输入里只放引用,出图器按引用读图。这一家引用的是**在播表里的封面与事件头像**
	 * (`extensionLive.list()`):直播可以超过 24 小时、周期卡几小时后还要用它们,不能像作品那样只靠宽限期。
	 */
	liveImages: ImageWriter;
	/**
	 * 大航海三档的徽章图(3a-33):B 站这边运行时从静态站抓进图库,会员卡按档取图库引用。仓库与安装包里不放这些图。
	 * 这一家引用的是手里抓到的那几张(`guardIcons.refs()`),装配时登记成图库的「来源声明的图」。
	 */
	guardIcons: GuardIcons;
	/**
	 * 推送历史往图库存图的口:配图 `put`、拓展行的头像快照 `keep`(续期)。历史仓用它存图;这一家引用方登记的名单是
	 * 保留期内(水位线之后)的日文件里所有 `image` 与 `avatarSnapshot`(`listHistoryImageRefs`)。重推原件是另一家引用方
	 * (`listRepushImageRefs`),各登记各的 —— 拿到的是同一个口,这里只暴露历史这一份。
	 */
	historyImages: ImageWriter;
	/**
	 * 女仆 AI 聊天的会话记录(dashboard 聊天侧栏「最近」的数据源)。刻意与
	 * engines 解耦 —— AI 没配好时会话照样能建能列,页面才有地方摆「去把 key
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
	 * 拓展订阅的在播表(ADR-0019 决策 12 / 57 / 61):首页「正在直播」里拓展那几行。只听总线(上报、
	 * 订阅增删改、拓展停了),所以与 StatsRecorder 一样在这里就起;`/api/live/listening` 读它。
	 */
	extensionLive: ExtensionLiveTable;
	/**
	 * Engine layer: PushRouter + DynamicEngine + LiveEngine + Dispatcher.
	 *
	 * `null` until {@link attachEngines} is called. The auth system has to come
	 * up first (engines need a started Api), so the bootstrap split is:
	 *
	 *   1. createAppRuntime(bootstrap) — produces ConfigStore + HistoryStore
	 *   2. keyProvider.getKey() — eagerly loads/creates the at-rest secrets key
	 *   3. configStore.load()
	 *   4. createAuthSystem(...) — produces Api
	 *   5. attachEngines(runtime, { api, adapters }) — fills `engines`
	 *   6. createApp(runtime, ...) — mounts routes
	 */
	engines: EnginesRuntime | null;
	attachEngines(engines: EnginesRuntime): void;
	/**
	 * FansPoller handle (cron 跟 globals.app.fansCron 刷新每个 enabled sub 的
	 * B 站 fans 数并 emit `fans-refreshed`)。`null` 直到 attachEngines 完成 + 启动
	 * 完成后由 index.ts 注入;Routes 通过 `runtime.fansPoller?.getLastEntries()` 读
	 * 最近一轮快照。
	 */
	fansPoller: FansPollerHandle | null;
	attachFansPoller(poller: FansPollerHandle): void;
	/** 关停:分段跑收尾钩子,预算见 `NodeServiceContext.dispose`。再调一次拿到的是同一次关停。 */
	dispose(options?: { timeoutMs?: number; flushReserveMs?: number }): Promise<void>;
}

/**
 * Glues a parsed bootstrap config + a fresh NodeServiceContext + NodeMessageBus + ConfigStore
 * into a single object. Higher layers (Hono routes, engines, sinks) consume this.
 *
 * Stage 2.1 keeps this minimal — no engines, no API client, no dispatcher. Those wire in stage 2.2+.
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
	/** 抓大航海徽章图用的请求客户端。测试换成不联网的。 */
	guardIconHttp?: Pick<HttpClient, "fetch">;
}

export function createAppRuntime(
	bootstrap: BootstrapConfig,
	roots: AppRuntimeRoots,
	deps: AppRuntimeDeps = {},
): AppRuntime {
	const serviceCtx = createNodeServiceContext({
		name: "core",
		level: bootstrap.logLevel,
	});
	const bus = createNodeMessageBus();
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
		serviceCtx.logger.info(
			"[secrets] 已启用注入密钥（BN_COOKIE_KEY）→ cookie / AI apiKey 使用 AES-256-GCM 静态加密",
		);
	} else {
		// 通用「仅混淆」告警已由 createKeyProvider 统一发出;这里只补服务端
		// 专属的可执行指引(设置 BN_COOKIE_KEY)。
		serviceCtx.logger.warn(
			"[secrets] 生产部署请设置环境变量 BN_COOKIE_KEY（生成命令：openssl rand -base64 32），" +
				"设置后自动启用 AES-256-GCM 真静态加密。",
		);
	}

	const secretStore = createSecretStore({
		filePath: dataPath(dataRoot, "secrets", "config-secrets.enc"),
		keyProvider,
		logger: serviceCtx.logger,
	});
	// 各集成的设置在这里登记(今天只有 B 站;3a 起挪到组装根,与集成的登记放在一起)。
	const configStore = createConfigStore({
		bootstrap,
		dataRoot,
		bus,
		serviceCtx,
		secretStore,
		integrationSettings: [settingsSegment],
	});
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
	// Recorder 只订阅总线、不碰引擎,所以在这里就能起 —— 不必等 attachEngines。
	// 早起一点反而更稳:引擎一开始 emit 就有人接着,不会漏掉启动瞬间的事件。
	//
	// 拓展那一支(ADR-0020 S3)也在这里挂上:它听订阅上报与 `extension-live-session`(场次在引擎里建)。
	// 数据统计总开关(`stats.enabled`):一个缓存布尔,设置变了作废。记录器入口与粉丝轮询共用这一个。
	const statsEnabled = createStatsEnabled({ bus, getGlobals: () => configStore.getGlobals() });
	const statsRecorder = createStatsRecorder({
		bus,
		store: statsStore,
		fans: fansStore,
		isEnabled: statsEnabled.isEnabled,
		// 拓展报的粉丝数不密过 B 站粉丝轮询(ADR-0020 决策 8);现取,面板改了 cron 下一条就跟着变。
		fansCron: () => configStore.getGlobals().app.fansCron,
		logger: serviceCtx.logger,
		// 按 uid 找订阅 id、判拓展订阅启用着没有、两格「在记」条件(启用着 ∧ 作品开关 / 直播类开关,取有效值)。
		// 读的是配置仓,开机时它在引擎发出第一条事件之前就载好了。
		subscriptions: () => {
			const { defaults } = configStore.getGlobals();
			return configStore.getSubscriptions().map((sub) => {
				const switches = recordingSwitches(
					resolve(sub, defaults).features,
					specialUserFlagsOf(sub),
				);
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
		// (拓展收摊、引擎拆)就结束了、下播帧已经交出去;closeOpenSessions 等到它们也落地才返回,
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
	const subRuntimeStore = createSubRuntimeStore({
		dataRoot,
		logger: serviceCtx.logger,
	});
	serviceCtx.onDispose(() => subRuntimeStore.close(), "flush");
	// 订阅资料是图库的一家引用方:拓展订阅的头像由资料缓存交名单,清扫据此留下还在资料里的图。订阅被删之后
	// 资料缓存里没了这一条,头像就不再被引用、由清扫收走 —— 没有「删订阅顺手删头像文件」这一步。
	const profileImages = imageStore.register({
		name: IMAGE_REFERRERS.profiles,
		listRefs: () => subRuntimeStore.listImageRefs(),
	});
	// 拓展报的资料更新 → 资料缓存 + 图库里的头像(ADR-0019 决策 7 / 49 / 62)。只听总线,所以在这儿就能起,
	// 不必等订阅仓那座桥(它在 index.ts 建,晚于这里,发的是同一条总线)。
	const reportedProfiles = bindReportedProfiles({
		bus,
		subRuntime: subRuntimeStore,
		images: profileImages,
		subscriptionIds: () => configStore.getSubscriptions().map((sub) => sub.id),
		logger: serviceCtx.logger,
	});
	serviceCtx.onDispose(() => reportedProfiles.dispose(), "stop");
	// 🔴 顺序承重:它往图库与资料缓存仓写,所以这条必须登记在那两家的 close 之后 —— 同段后登记的先跑,
	// 它先把在途的那条写完,那两家才关门;反过来的话在途那条的写会被拒、这次资料更新就丢了。
	serviceCtx.onDispose(() => reportedProfiles.close(), "flush");
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
	// 拓展作品是图库的一家引用方,但它**没有东西可列**:作品是在途数据(收到上报 → 出卡 → 推送),不落盘,图只在
	// 出卡那一刻要用。所以名单恒空,图全靠新图 24 小时的宽限期活到卡片画完;卡画完、没有哪家引用(历史行的配图是
	// 推送时另存的一份,头像抄的是资料缓存里的引用),下一轮清扫就收走。名单不会因为「列不出」而抛 —— 空就是空。
	const postImages = imageStore.register({
		name: IMAGE_REFERRERS.posts,
		listRefs: async () => [],
	});
	// 来源声明的图是图库的一家引用方:大航海徽章图运行时抓进图库(3a-33),名单是手里抓到的那几张。
	// 抓不到的时候名单为空、卡上的徽章块自己收起。请求客户端是自带的一个(不借 B 站接口那个:抓静态图不用登录态、
	// 也不该把它的 cookie 带出去),用完在 drain 段关掉它攒的连接。
	let guardIconHttp = deps.guardIconHttp;
	if (!guardIconHttp) {
		const http = new HttpClient({
			jar: new CookieJar(),
			identity: generateBrowserIdentity(),
			headers: GUARD_ICON_REQUEST_HEADERS,
		});
		serviceCtx.onDispose(() => http.dispose(), "drain");
		guardIconHttp = http;
	}
	const sourceDeclaredImages = imageStore.register({
		name: IMAGE_REFERRERS.sourceDeclared,
		listRefs: async () => guardIcons.refs(),
	});
	const guardIcons = createGuardIcons({
		images: createImageFetcher({ http: guardIconHttp, images: sourceDeclaredImages }),
		logger: serviceCtx.logger,
	});
	const logStore = createLogStore({
		hostRoot,
		serviceCtx,
		logger: serviceCtx.logger,
	});
	// 拓展订阅的在播表:只听总线,早起不漏拓展开机第一轮报上来的直播状态(拓展在 index.ts 里装载,
	// 晚于这里)。合并那一发走 serviceCtx 的定时器,关机时一起清。
	const extensionLive = createExtensionLiveTable({ bus, timers: serviceCtx });
	serviceCtx.onDispose(() => extensionLive.dispose(), "stop");
	// 拓展直播是图库的一家引用方:在播表里的封面与事件带来的头像(都是字节,`imageRefOf` 算得出它们存进图库后的引用)。
	// 在播表只在内存,所以名单是「此刻在播的那些行」;一场播过 24 小时,周期卡出卡时也会再存一遍,这份名单让清扫
	// 在两次出卡之间也不把它们当垃圾。算不出引用(图库不收的图)的跳过。
	const liveImages = imageStore.register({
		name: IMAGE_REFERRERS.extensionLive,
		listRefs: async () =>
			extensionLive
				.list()
				.flatMap((row) => [row.cover, row.author?.avatar])
				.flatMap((bytes) => (bytes === undefined ? [] : [imageRefOf(bytes)]))
				.filter((ref): ref is ImageRef => ref !== undefined),
	});

	let engines: EnginesRuntime | null = null;
	let fansPoller: FansPollerHandle | null = null;

	/**
	 * 路由 + 目标启停的快照。列表端点要为**每一行**失败的历史问一次闸,而 ConfigStore 的
	 * 三个 getter 全是整份深拷贝 —— 一页 200 行全红时那是 600 份副本。随 `config-changed`
	 * 失效,惰性重建(为什么不能预建见 target-scope.ts 文件头)。
	 */
	const targetScope = createTargetScope({ configStore, bus });
	serviceCtx.onDispose(() => targetScope.dispose(), "stop");

	/**
	 * 重推的执行器。发送口**惰性**拿 `engines` —— 它是后挂的(见 AppRuntime 那段分期
	 * 说明),而这里已经要把 runner 交出去了;那张「正在补哪几行」的表必须只有一份。
	 *
	 * 发的是 `push.sendToTarget`:退避重试与每次重试前的 routing 复检都自带,而静音 /
	 * 免扰 / 特性总开关三道在它上游 —— 走这条路它们天然不参与(ADR-0017 决策 10-12)。
	 */
	const repushRunner = createRepushRunner({
		history: historyStore,
		repush: repushStore,
		send: async (targetId, payload, routing) => {
			if (!engines) return { ok: false, latencyMs: 0, err: "推送引擎还没起来，稍后再试" };
			return engines.push.sendToTarget(targetId, payload, { routing });
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
		// 缓存里留拼好的 `@font-face` 而不是 data URL —— 规则本身就把 data URL 包在
		// 里头,只留它就少留一整份几十兆的串。闲置到点自动放掉,见读取器内部说明。
		loadFontFace: createFontAssetReader(dataRoot, { transform: buildFontFace }),
		configStore,
		historyStore,
		repushRunner,
		fansStore,
		statsStore,
		statsRecorder,
		isStatsEnabled: statsEnabled.isEnabled,
		uptimeStore,
		uptimeRecorder,
		subRuntimeStore,
		imageStore,
		chatImages,
		profileImages,
		postImages,
		liveImages,
		guardIcons,
		historyImages,
		conversationStore,
		logStore,
		extensionLive,
		get engines() {
			return engines;
		},
		attachEngines(next: EnginesRuntime) {
			engines = next;
		},
		get fansPoller() {
			return fansPoller;
		},
		attachFansPoller(next: FansPollerHandle) {
			fansPoller = next;
		},
		dispose: (options) => serviceCtx.dispose(options),
	};
}
