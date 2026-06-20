import { join } from "node:path";
import type { MessageBus } from "@bilibili-notify/internal";
import { createKeyProvider, type KeyProvider } from "@bilibili-notify/storage";
import type { BootstrapConfig } from "../config/schema.js";
import { createSecretStore } from "../config/secret-store.js";
import { type ConfigStore, createConfigStore } from "../config/store.js";
import { createFansStore, type FansStore } from "../fans/store.js";
import { createHistoryStore, type HistoryStore } from "../history/store.js";
import { createLogStore, type LogStore } from "../logs/store.js";
import type { EnginesRuntime } from "./engines.js";
import type { FansPollerHandle } from "./fans-poller.js";
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
	configStore: ConfigStore;
	historyStore: HistoryStore;
	fansStore: FansStore;
	/**
	 * Per-subscription runtime data (display cache + fans anchor), externalized
	 * out of the persisted `Subscription` config so FansPoller's per-tick
	 * `cachedProfile` writes no longer fan out as `config-changed:subscriptions`.
	 * Loaded alongside configStore; consumed by FansPoller / engines / the
	 * `/api/subs` join.
	 */
	subRuntimeStore: SubRuntimeStore;
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
		name: "bilibili-notify",
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
	const subRuntimeStore = createSubRuntimeStore({
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
		configStore,
		historyStore,
		fansStore,
		subRuntimeStore,
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
