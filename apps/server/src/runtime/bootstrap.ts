import { join } from "node:path";
import { buildFontFace } from "@bilibili-notify/image";
import type { MessageBus } from "@bilibili-notify/internal";
import { createKeyProvider, type KeyProvider } from "@bilibili-notify/storage";
import { type ConversationStore, createConversationStore } from "../ai/conversation-store.js";
import type { BootstrapConfig } from "../config/schema.js";
import { createSecretStore } from "../config/secret-store.js";
import { type ConfigStore, createConfigStore } from "../config/store.js";
import { createFansStore, type FansStore } from "../fans/store.js";
import { createHistoryStore, type HistoryStore } from "../history/store.js";
import { createLogStore, type LogStore } from "../logs/store.js";
import { createStatsRecorder } from "../stats/recorder.js";
import { createStatsStore, type StatsStore } from "../stats/store.js";
import type { EnginesRuntime } from "./engines.js";
import type { FansPollerHandle } from "./fans-poller.js";
import { createFontAssetReader } from "./font-assets.js";
import { createNodeMessageBus } from "./message-bus.js";
import { createNodeServiceContext, type NodeServiceContext } from "./service-context.js";
import { createSubRuntimeStore, type SubRuntimeStore } from "./sub-runtime-store.js";

export interface AppRuntime {
	bootstrap: BootstrapConfig;
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
	/** Tear down everything (timers, onDispose hooks). Idempotent. */
	dispose(): Promise<void>;
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

	// Shared at-rest encryption key. Injected passphrase (BN_COOKIE_KEY) →
	// scrypt-derived key, never written to disk = real protection. Absent →
	// co-located random key file (obfuscation only; loud warning below).
	const secretsDir = join(bootstrap.dataDir, "secrets");
	const keyProvider = createKeyProvider({
		passphrase: bootstrap.cookieEncryptionKey,
		keyPath: join(secretsDir, "master.key"),
		saltPath: join(secretsDir, "kdf.salt"),
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
		filePath: join(secretsDir, "config-secrets.enc"),
		keyProvider,
		logger: serviceCtx.logger,
	});
	const configStore = createConfigStore({ bootstrap, bus, serviceCtx, secretStore });
	const historyStore = createHistoryStore({
		dataDir: bootstrap.dataDir,
		bus,
		logger: serviceCtx.logger,
	});
	const fansStore = createFansStore({
		dataDir: bootstrap.dataDir,
		logger: serviceCtx.logger,
	});
	const statsStore = createStatsStore({
		dataDir: bootstrap.dataDir,
		logger: serviceCtx.logger,
	});
	// Recorder 只订阅总线、不碰引擎,所以在这里就能起 —— 不必等 attachEngines。
	// 早起一点反而更稳:引擎一开始 emit 就有人接着,不会漏掉启动瞬间的事件。
	const statsRecorder = createStatsRecorder({
		bus,
		store: statsStore,
		logger: serviceCtx.logger,
	});
	serviceCtx.onDispose(async () => {
		// 先给在播的场次补下播帧,再解绑 —— 顺序反了就没人记得谁还在播。
		// dispose() 会 await 这个钩子,所以写盘赶得及在进程退出前完成。
		await statsRecorder.closeOpenSessions();
		statsRecorder.dispose();
	});
	const subRuntimeStore = createSubRuntimeStore({
		dataDir: bootstrap.dataDir,
		logger: serviceCtx.logger,
	});
	const conversationStore = createConversationStore({
		dataDir: bootstrap.dataDir,
		logger: serviceCtx.logger,
	});
	const logStore = createLogStore({
		dataDir: bootstrap.dataDir,
		serviceCtx,
		logger: serviceCtx.logger,
	});

	let engines: EnginesRuntime | null = null;
	let fansPoller: FansPollerHandle | null = null;

	return {
		bootstrap,
		serviceCtx,
		bus,
		keyProvider,
		// 缓存里留拼好的 `@font-face` 而不是 data URL —— 规则本身就把 data URL 包在
		// 里头,只留它就少留一整份几十兆的串。闲置到点自动放掉,见读取器内部说明。
		loadFontFace: createFontAssetReader(bootstrap.dataDir, { transform: buildFontFace }),
		configStore,
		historyStore,
		fansStore,
		statsStore,
		subRuntimeStore,
		conversationStore,
		logStore,
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
		dispose: () => serviceCtx.dispose(),
	};
}
