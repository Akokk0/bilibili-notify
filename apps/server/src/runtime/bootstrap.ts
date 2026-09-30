import { buildFontFace } from "@bilibili-notify/image";
import type { MessageBus } from "@bilibili-notify/internal";
import { createKeyProvider, type KeyProvider } from "@bilibili-notify/storage";
import { type ConversationStore, createConversationStore } from "../ai/conversation-store.js";
import { flushAssetLabelWrites } from "../assets/asset-store.js";
import type { BootstrapConfig } from "../config/schema.js";
import { createSecretStore } from "../config/secret-store.js";
import { type ConfigStore, createConfigStore } from "../config/store.js";
import { createFansStore, type FansStore } from "../fans/store.js";
import { createRepushRunner, type RepushRunner } from "../history/repush-runner.js";
import { createRepushStore } from "../history/repush-store.js";
import { createHistoryStore, type HistoryStore } from "../history/store.js";
import { createLogStore, type LogStore } from "../logs/store.js";
import { flushSkinWrites } from "../skins/skin-store.js";
import { createStatsRecorder } from "../stats/recorder.js";
import { createStatsStore, type StatsStore } from "../stats/store.js";
import type { EnginesRuntime } from "./engines.js";
import { createExtensionLiveTable, type ExtensionLiveTable } from "./extension-live.js";
import type { FansPollerHandle } from "./fans-poller.js";
import { createFontAssetReader } from "./font-assets.js";
import { createNodeMessageBus } from "./message-bus.js";
import { bindReportedProfiles } from "./reported-profiles.js";
import { dataPath } from "./roots.js";
import { createNodeServiceContext, type NodeServiceContext } from "./service-context.js";
import {
	bindSubAvatarCleanup,
	createSubAvatarStore,
	type SubAvatarStore,
} from "./sub-avatar-store.js";
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
	fansStore: FansStore;
	/**
	 * 「UP 产出」时序(动态事件 + 直播场次),数据统计 Tab 的数据源。写侧是
	 * StatsRecorder(订阅总线,随 runtime 一起起停),读侧是 `/api/stats`。
	 */
	statsStore: StatsStore;
	/**
	 * Per-subscription runtime data (display cache + fans anchor), externalized
	 * out of the persisted `Subscription` config so FansPoller's per-tick
	 * `cachedProfile` writes no longer fan out as `config-changed:subscriptions`.
	 * Loaded alongside configStore; consumed by FansPoller / engines / the
	 * `/api/subs` join.
	 */
	subRuntimeStore: SubRuntimeStore;
	/**
	 * 拓展订阅的头像文件(ADR-0019 决策 49):`<dataRoot>/avatars/<订阅 id>.<后缀>`。新建订阅那条路写、
	 * `GET /api/subs/:id/avatar` 读、开机清扫(`index.ts`);删订阅时跟着删(这里就听上了)。
	 */
	subAvatarStore: SubAvatarStore;
	/**
	 * 女仆 AI 聊天的会话记录(dashboard 聊天侧栏「最近」的数据源)。刻意与
	 * engines 解耦 —— AI 没配好时会话照样能建能列,页面才有地方摆「去把 key
	 * 填上」这句话。
	 */
	conversationStore: ConversationStore;
	/**
	 * jsonl-by-day log archive. Fed (post-redaction) by the log sink installed
	 * in index.ts; queried by the `/api/logs` route. No floor — level gating is
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
	 * Engine layer: BilibiliPush + DynamicEngine + LiveEngine + Sink.
	 *
	 * `null` until {@link attachEngines} is called. The auth system has to come
	 * up first (engines need a started BilibiliAPI), so the bootstrap split is:
	 *
	 *   1. createAppRuntime(bootstrap) — produces ConfigStore + HistoryStore
	 *   2. keyProvider.getKey() — eagerly loads/creates the at-rest secrets key
	 *   3. configStore.load()
	 *   4. createAuthSystem(...) — produces BilibiliAPI
	 *   5. attachEngines(runtime, { api, adapters }) — fills `engines`
	 *   6. createApp(runtime, ...) — mounts routes
	 */
	engines: EnginesRuntime | null;
	attachEngines(engines: EnginesRuntime): void;
	/**
	 * FansPoller handle (cron 跟 globals.app.dynamicCron 刷新每个 enabled sub 的
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
 * Stage 2.1 keeps this minimal — no engines, no API client, no sink. Those wire in stage 2.2+.
 */
export function createAppRuntime(bootstrap: BootstrapConfig): AppRuntime {
	const serviceCtx = createNodeServiceContext({
		name: "core",
		level: bootstrap.logLevel,
	});
	const bus = createNodeMessageBus();
	const hostRoot = bootstrap.dataDir;
	// 第 0 代就是宿主根;数据代落地时换成选中的那一代。
	const dataRoot = hostRoot;

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
		// 通用「仅混淆」告警已由 createKeyProvider 统一发出;这里只补 standalone
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
	const configStore = createConfigStore({ bootstrap, dataRoot, bus, serviceCtx, secretStore });
	// 写道在 flush 段落盘并关门:此时 HTTP 已排空、各生产者已停,还在路上的配置写(如送达回调写回的目标可达性,
	// 那处发出去就不管)在这里等到落盘,关停返回之后 `state/` 不再变。
	serviceCtx.onDispose(() => configStore.close(), "flush");
	// 模块级的两条写道(皮肤门面、资产库的原名清单)住在同一个进程的所有实例之间,所以只 flush、不关门 ——
	// 关了它们,同一进程里下一个起的服务就写不进了。
	serviceCtx.onDispose(() => flushSkinWrites(), "flush");
	serviceCtx.onDispose(() => flushAssetLabelWrites(), "flush");
	// 重推原件(ADR-0017):历史仓每次落行 / 追加时顺手留一份没有损耗的原料。
	// 它没有内部状态,retention 那边按同一个 `historyRetentionDays` 自己建一个来淘汰。
	const repushStore = createRepushStore({
		dataRoot,
		logger: serviceCtx.logger,
	});
	const historyStore = createHistoryStore({
		dataRoot,
		bus,
		logger: serviceCtx.logger,
		repush: repushStore,
	});
	serviceCtx.onDispose(() => historyStore.close(), "flush");
	const fansStore = createFansStore({
		dataRoot,
		logger: serviceCtx.logger,
	});
	const statsStore = createStatsStore({
		dataRoot,
		logger: serviceCtx.logger,
	});
	// Recorder 只订阅总线、不碰引擎,所以在这里就能起 —— 不必等 attachEngines。
	// 早起一点反而更稳:引擎一开始 emit 就有人接着,不会漏掉启动瞬间的事件。
	//
	// 它在这里就挂上了,但只在引擎发事件时才写盘 —— 引擎在 index.ts 里建,晚于那边的开机迁移
	// (`migrateStatsFileKeys`),所以老的 `<uid>.jsonl` 一定先挪到订阅 id 名下,它才会往里写。
	//
	// 拓展那一支(ADR-0020 S3)也在这里挂上:它听订阅上报与 `extension-live-session`(场次在引擎里建)。
	const statsRecorder = createStatsRecorder({
		bus,
		store: statsStore,
		fans: fansStore,
		// 拓展报的粉丝数不密过 B 站粉丝轮询(ADR-0020 决策 8);现取,面板改了 cron 下一条就跟着变。
		fansCron: () => configStore.getGlobals().app.fansCron,
		logger: serviceCtx.logger,
		// 按 uid 找订阅 id、判拓展订阅启用着没有。读的是配置仓,开机时它在引擎发出第一条事件之前就载好了。
		subscriptions: () => configStore.getSubscriptions(),
	});
	serviceCtx.onDispose(async () => {
		// 排在 flush 段:生产者都停了、后台活都落定了,这时补的下播帧才是最后一帧。
		// 先给在播的场次补下播帧,再解绑 —— 顺序反了就没人记得谁还在播。
		// dispose() 会 await 这个钩子,所以写盘赶得及在进程退出前完成。拓展直播的场次在更早的关机步骤里
		// (拓展收摊、引擎拆)就结束了、下播帧已经交出去;closeOpenSessions 等到它们也落地才返回,
		// 且不会给它们补第二帧。
		await statsRecorder.closeOpenSessions();
		statsRecorder.dispose();
	}, "flush");
	const subRuntimeStore = createSubRuntimeStore({
		dataRoot,
		logger: serviceCtx.logger,
	});
	serviceCtx.onDispose(() => subRuntimeStore.close(), "flush");
	const subAvatarStore = createSubAvatarStore({
		dataRoot,
		logger: serviceCtx.logger,
	});
	serviceCtx.onDispose(() => subAvatarStore.close(), "flush");
	// 删订阅的路不止一条(面板删、恢复备份整份覆盖、级联),都汇到 `subscription-changed` 上 ——
	// 只听总线,所以在这儿就能起,不必等订阅仓那座桥(它在 index.ts 建,晚于这里,发的是同一条总线)。
	const subAvatarCleanup = bindSubAvatarCleanup({
		bus,
		avatars: subAvatarStore,
		logger: serviceCtx.logger,
		serviceCtx,
	});
	serviceCtx.onDispose(() => subAvatarCleanup.dispose(), "stop");
	// 拓展报的资料更新 → 资料缓存 + 头像文件(ADR-0019 决策 7 / 49 / 62)。同上只听总线。
	const reportedProfiles = bindReportedProfiles({
		bus,
		subRuntime: subRuntimeStore,
		avatars: subAvatarStore,
		subscriptionIds: () => configStore.getSubscriptions().map((sub) => sub.id),
		logger: serviceCtx.logger,
	});
	serviceCtx.onDispose(() => reportedProfiles.dispose(), "stop");
	// 🔴 顺序承重:它往头像仓与资料缓存仓写,所以这条必须登记在那两家的 close 之后 —— 同段后登记的先跑,
	// 它先把在途的那条写完,那两家才关门;反过来的话在途那条的写会被拒、这次资料更新就丢了。
	serviceCtx.onDispose(() => reportedProfiles.close(), "flush");
	const conversationStore = createConversationStore({
		dataRoot,
		logger: serviceCtx.logger,
	});
	serviceCtx.onDispose(() => conversationStore.close(), "flush");
	const logStore = createLogStore({
		hostRoot,
		serviceCtx,
		logger: serviceCtx.logger,
	});
	// 拓展订阅的在播表:只听总线,早起不漏拓展开机第一轮报上来的直播状态(拓展在 index.ts 里装载,
	// 晚于这里)。合并那一发走 serviceCtx 的定时器,关机时一起清。
	const extensionLive = createExtensionLiveTable({ bus, timers: serviceCtx });
	serviceCtx.onDispose(() => extensionLive.dispose(), "stop");

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
		subRuntimeStore,
		subAvatarStore,
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
