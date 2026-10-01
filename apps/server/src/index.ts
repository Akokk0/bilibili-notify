import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StatsOverviewResponse } from "@bilibili-notify/contract";
import {
	BILIBILI_SOURCE_KEY,
	chatIdentityOf,
	type InboundGroupMessage,
	type InboundMeta,
	type InboundPrivateMessage,
	isExtensionEnabled,
	type Logger,
	type NotificationPayload,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import { createKeyProvider, type SweepReport, sweepTempFiles } from "@bilibili-notify/storage";
import { type ServerType, serve } from "@hono/node-server";
import type { Hono } from "hono";
import { createApp, createCardSkinStore, createStartupApp } from "./app.js";
import { shouldRefuseBareAuth } from "./auth/bare-auth-policy.js";
import { type AuthSystem, createAuthSystem } from "./auth/index.js";
import { createSessionCodec } from "./auth/session.js";
import { createWsTicketStore } from "./auth/ws-ticket.js";
import { createBackupService } from "./backup/service.js";
import { readCardSkinAssetDataUrl } from "./card-skins/asset-url.js";
import { createCardSkinFallbackLog } from "./card-skins/fallbacks.js";
import type { CardSkinStore } from "./card-skins/store.js";
import { loadBootstrapConfig, resolveConfigPath } from "./config/loader.js";
import { type ChromeSource, persistChromeSource } from "./config/persist.js";
import { type ResolveWebDistDirInput, resolveWebDistDir } from "./config/web-dist.js";
import { createDevtools } from "./devtools/index.js";
import { manifestSubscriptionView } from "./extensions/context.js";
import { extensionsRootIn } from "./extensions/discover.js";
import {
	EXTENSION_MAX_LOAD_FAILURES,
	entryIdentity,
	type LoadedExtensions,
	loadExtensions,
} from "./extensions/loader.js";
import { createMarketplace } from "./extensions/marketplace.js";
import { createExtensionMounts } from "./extensions/mount.js";
import { createReportProblemLog } from "./extensions/report-problems.js";
import { createExtensionUpgrades } from "./extensions/upgrade.js";
import { startHistoryRetention } from "./history/retention.js";
import { startLogRetention } from "./logs/retention.js";
import { createLogSink } from "./logs/sink.js";
import {
	MIGRATION_REVISION,
	migrateZeroGeneration,
	readZeroGenerationKey,
	type ZeroMigrationResult,
	zeroGenerationExists,
} from "./migration/zero-generation.js";
import { adapterForConnection } from "./platforms/dispatch.js";
import { createOnebotAdapter } from "./platforms/onebot.js";
import { createQQOfficialAdapter, createQQSessionRegistry } from "./platforms/qq-official.js";
import { createAdapterRegistry } from "./platforms/registry.js";
import { createWebhookAdapter } from "./platforms/webhook.js";
import { APP_VERSION, STARTED_AT } from "./routes/health.js";
import { type AppRuntime, createAppRuntime } from "./runtime/bootstrap.js";
import {
	type CommandSpec,
	command,
	createCommandDispatcher,
	effectiveAliases,
} from "./runtime/command-dispatcher.js";
import { renderHelp } from "./runtime/command-help.js";
import { createEngines } from "./runtime/engines.js";
import { isEntrypoint } from "./runtime/entrypoint.js";
import { startFansPoller } from "./runtime/fans-poller.js";
import {
	createGeneration,
	FORMAT_VERSION,
	type GenerationSelection,
	selectGeneration,
} from "./runtime/generations.js";
import { createLinkParser } from "./runtime/link-parser.js";
import { createLoginCommand } from "./runtime/login-command.js";
import { createMuteCommand } from "./runtime/mute-command.js";
import { resolveExpectedParent, startParentWatch } from "./runtime/parent-watch.js";
import { browserSubtreeRss } from "./runtime/process-tree.js";
import { createPuppeteerAdapter, type PuppeteerAdapter } from "./runtime/puppeteer.js";
import { createReportCommand } from "./runtime/report-command.js";
import { type ResourceMonitor, startResourceMonitor } from "./runtime/resource-monitor.js";
import { resolveRestartAbility, runningInContainer } from "./runtime/restart-ability.js";
import { createRoastCommandHandler } from "./runtime/roast-command.js";
import { createRoastDraftStore } from "./runtime/roast-draft-store.js";
import { createRoastScheduler } from "./runtime/roast-scheduler.js";
import { dataPath, hostPath } from "./runtime/roots.js";
import { createStatusCommand } from "./runtime/status-command.js";
import { pruneOrphanSubRuntime } from "./runtime/sub-runtime-store.js";
import { bindSubscriptionStore } from "./runtime/subscription-store.js";
import { createUpdateService } from "./update/service.js";
import {
	EXTENSION_MARKETPLACE_URL,
	RELEASES_PAGE_URL,
	TRUSTED_UPDATE_KEYS,
	UPDATE_MANIFEST_URLS,
} from "./update/trusted-keys.js";
import { versionsRootIn } from "./update/versions-root.js";
import { createLogChannel } from "./ws/log-channel.js";
import { createWsServer } from "./ws/server.js";

/**
 * 关停总预算。桌面壳与 Docker 默认都等 10 秒再硬杀,留 2 秒余量(compose 样例写了 `stop_grace_period`)。
 * 预算按比例分,测试传的小预算也照这个比例:HTTP 排空最多占 30%,`flush` 之前的等待至少给它留 25%。
 */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 8_000;
const HTTP_DRAIN_SHARE = 0.3;
const FLUSH_RESERVE_SHARE = 0.25;

export interface ServerHandle {
	readonly host: string;
	readonly port: number;
	readonly url: string;
	close(reason?: string): Promise<void>;
}

export interface StartServerOptions {
	argv?: readonly string[];
	env?: NodeJS.ProcessEnv;
	installProcessHandlers?: boolean;
	shutdownTimeoutMs?: number;
	/**
	 * 当前这份载荷的入口 URL,dashboard 静态资源按它就近解析
	 * (见 `config/web-dist.ts`)。只有测试需要传 —— 真实运行永远是本模块自己。
	 */
	bundleUrl?: string;
}

export async function startServer(options: StartServerOptions = {}): Promise<ServerHandle> {
	const env = options.env ?? process.env;
	const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
	const bootstrap = loadBootstrapConfig({ argv: options.argv, env });
	// 这时运行时还没建,宿主根就直接取配置键(建好之后一律读 `runtime.hostRoot`)。
	const hostRoot = bootstrap.dataDir;
	// 选这次开机用哪一代(ADR-0022 决策 1–3),只读盘。宿主根上 0.x 的文件是第 0 代,一个字节都不动。
	const selection = await selectGeneration({
		hostRoot,
		formatVersion: FORMAT_VERSION,
		migrationRevision: MIGRATION_REVISION,
		zeroGenerationExists: await zeroGenerationExists(hostRoot),
	});
	// 开机清扫:收掉上个进程被杀留下的临时文件与暂存目录。**必须赶在任何写入之前** —— 它认不出哪些
	// 临时文件是这个进程正在写的(Docker 里每次开机 pid 常常一样,靠不住),而存储与日志落盘都从
	// 下面的 createAppRuntime 起,所以放在它前面;logger 此刻还没有,结果先留着,等它起来再记一行。
	// 读不动 / 清不掉的地方清扫自己跳过、记进报告;万一它整个抛了也不挡开机:留下的只是些垃圾。
	// 只扫宿主根的 versions/ 和要用的那一代:第 0 代与别的旧代都是备份,不碰;要开的新代这时还不存在。
	const bootSweep = await sweepBootRoots([
		hostPath(hostRoot, "versions"),
		...(selection.kind === "use" ? [selection.dir] : []),
	]).then(
		(report) => ({ report }) as const,
		(error: unknown) => ({ error }) as const,
	);
	// 空的一代(新装)当场开:什么都不用搬,不必等到 listen 之后。
	const generation: GenerationSelection =
		selection.kind === "create" && selection.source.kind === "empty"
			? await createGeneration(selection, {
					formatVersion: FORMAT_VERSION,
					migrationRevision: MIGRATION_REVISION,
					createdBy: APP_VERSION,
					fill: async () => {},
				}).then(() => ({ kind: "use", seq: selection.seq, dir: selection.dir }) as const)
			: selection;
	let runtime: AppRuntime | undefined;
	let authSystem: AuthSystem | undefined;
	let puppeteer: PuppeteerAdapter | null = null;
	let subBinding: ReturnType<typeof bindSubscriptionStore> | undefined;
	let engines: ReturnType<typeof createEngines> | undefined;
	let cardSkinStore: CardSkinStore | undefined;
	let wsTicketStore: ReturnType<typeof createWsTicketStore> | null | undefined;
	let server: ServerType | undefined;
	let wsServer: ReturnType<typeof createWsServer> | undefined;
	let resourceMonitor: ResourceMonitor | undefined;
	let loadedExtensions: LoadedExtensions | undefined;
	// QQ 官方机器人网关捞到的群/C2C openid 落进这张共享发现表(不落盘),既喂 adapter
	// 也喂 /api/qq/sessions 路由的面板选择器。一个进程一份。
	const qqSessionRegistry = createQQSessionRegistry();
	let processHandlerCleanup: (() => void) | undefined;
	let shutdownPromise: Promise<void> | null = null;
	let listeningPort = bootstrap.server.port;

	runtime = createAppRuntime(bootstrap, { dataRoot: generation.dir });
	const log = runtime.serviceCtx.logger;
	// 日志从运行时建好那一刻起就进归档与 WS 的环形缓冲:开机那一段(以后的迁移)出了事也查得到。
	// 环形缓冲先建好,WS 起来时交给它。
	const logChannel = createLogChannel();
	runtime.serviceCtx.setLogHook(createLogSink({ ring: logChannel, store: runtime.logStore }));

	const close = async (reason = "shutdown"): Promise<void> => {
		if (shutdownPromise) return shutdownPromise;
		shutdownPromise = (async () => {
			log.info(`received ${reason}, shutting down…`);
			// 各部件装配时就把自己的收尾登记进了 serviceCtx 的那一段(DisposePhase),这里只给预算。
			// 一个钩子抛错只记一条、不连累后面的 —— 统计补帧、日志落盘以前会被前面一处抛错整个跳过。
			// 日志 hook 一直挂着,关停期的日志照样进归档;归档自己在最后一段落盘。
			await runtime?.dispose({
				timeoutMs: shutdownTimeoutMs,
				flushReserveMs: shutdownTimeoutMs * FLUSH_RESERVE_SHARE,
			});
			// 处理器挂到收完才摘:关停期间再来的信号与未捕获错误由它们接住、只记一笔,不按默认动作杀进程。
			processHandlerCleanup?.();
			processHandlerCleanup = undefined;
		})();
		return shutdownPromise;
	};

	try {
		log.info(
			`starting bilibili-notify server: host=${bootstrap.server.host} port=${bootstrap.server.port} dataDir=${bootstrap.dataDir} logLevel=${bootstrap.logLevel}`,
		);
		log.info(
			generation.kind === "use"
				? `[data] 用第 ${generation.seq} 代:${generation.dir}`
				: `[data] 这次开机要从第 0 代迁出第 ${generation.seq} 代:${generation.dir}`,
		);
		if ("error" in bootSweep) {
			log.warn(
				`[storage] 开机清扫没做完(${bootSweep.error instanceof Error ? bootSweep.error.message : String(bootSweep.error)})—— 上次留下的临时文件可能还在,不影响启动`,
			);
		} else {
			const swept = describeBootSweep(bootSweep.report, runtime.hostRoot);
			if (swept.cleaned) log.info(swept.cleaned);
			if (swept.skipped) log.warn(swept.skipped);
		}

		// Dashboard 鉴权策略:监听 loopback 时允许 bare(本地 dev / 反代后端);否则
		// fail-closed 拒绝启动,避免裸暴露公网。绕过开关是 BN_ALLOW_NO_AUTH=1 — 留给
		// 明确知道自己在做什么的运维(例如已经在 nginx 层做了 IP 白名单 / mTLS)。
		// 决策本身在 auth/bare-auth-policy.ts 做纯函数测试。
		const basicAuthCredentials = bootstrap.auth?.basicAuth;
		const host = bootstrap.server.host;
		const allowNoAuth = env.BN_ALLOW_NO_AUTH === "1";
		const desktopToken = normalizeOptionalEnv(env.BN_DESKTOP_TOKEN);
		const allowedOrigins = mergeAllowedOrigins(
			bootstrap.auth?.allowedOrigins,
			normalizeOptionalEnv(env.BN_DESKTOP_ALLOWED_ORIGIN),
		);
		if (!basicAuthCredentials) {
			if (shouldRefuseBareAuth({ host, hasBasicAuth: false, allowNoAuth })) {
				const message = `auth not configured but listening on ${host} (non-loopback). 拒绝启动以避免裸暴露。请设置 auth.basicAuth.{username,password} 或 BN_DASHBOARD_USER/BN_DASHBOARD_PASS;或者把 server.host 改为 127.0.0.1 / BN_HOST=127.0.0.1;或者用 BN_ALLOW_NO_AUTH=1 强制允许(自担风险)。`;
				log.error(message);
				throw new Error(message);
			}
			log.warn(
				`auth not configured, dashboard exposed without auth (host=${host}${allowNoAuth ? " allow_no_auth=1" : ""})`,
			);
		}
		if (allowedOrigins.length === 0 && !desktopToken) {
			log.warn(
				"auth.allowedOrigins not configured, WebSocket Origin check disabled (any browser origin may upgrade)",
			);
		}

		const webDist = await resolveEffectiveWebDistDir({
			configured: bootstrap.webDistDir,
			envValue: normalizeOptionalEnv(env.BN_WEB_DIST),
			bundleUrl: options.bundleUrl ?? import.meta.url,
		});
		const effectiveWebDistDir = webDist.dir;
		// 两条告警都只对 B 模型(容器)说 —— 桌面壳是拿 `--web-dist` 指着自己安装目录
		// 里那份资源起 sidecar 的,那是设计,不是配错,不该每次启动都被念一遍。
		const isBootstrapFileModel = Boolean(normalizeOptionalEnv(env.BN_CONFIG));
		if (webDist.source === "explicit" && isBootstrapFileModel) {
			// 钉死一个绝对路径 = 前端不再跟着载荷走。在线升级之后这里仍指着旧那份,
			// 症状是「升完了界面没变 / 某个新功能点了没反应」,而且服务端一声不吭。
			log.warn(
				`webDistDir is pinned to ${webDist.dir}; dashboard assets will NOT follow in-app updates. 想让它跟着升级走,就把 webDistDir(或 BN_WEB_DIST)删掉。`,
			);
		} else if (webDist.source === "disabled" && isBootstrapFileModel) {
			log.warn(
				`dashboard static assets disabled: ${webDist.payloadDir}/index.html was not found. Dashboard GET / will return 404;载荷似乎不完整,建议重拉镜像或重装。`,
			);
		}
		if (effectiveWebDistDir) {
			log.info(`serving dashboard static assets from ${effectiveWebDistDir}`);
		}
		// WS ticket store:仅当 basicAuth 启用时才需要。前端 WebSocket 无法附带
		// Authorization 头,改用 `POST /api/auth/ws-ticket` 换短时 token,再用 `?ticket=`
		// 完成 WS upgrade,避免把真实凭证拼进 URL 落进反代日志。
		wsTicketStore = basicAuthCredentials ? createWsTicketStore() : null;
		runtime.serviceCtx.onDispose(() => wsTicketStore?.dispose(), "stop");

		// 会话签名的密钥。这一代已经在,就是它自己那把。要从第 0 代迁的话这一代还没搭:只读地取第 0 代那把
		// (迁移逐字节搬过去,是同一把),第 0 代一个字节都不许动;第 0 代里没有(手删过)就在 `.partial` 里
		// 造一把,迁移不会盖掉它。还没改名的正式路径碰不得:那里一有东西,迁完改名就撞上。
		const { keyProvider } = runtime;
		const sessionKeyMaterial = async (): Promise<Buffer> => {
			if (generation.kind === "use") return keyProvider.getKey();
			const zeroKey = await readZeroGenerationKey(hostRoot, bootstrap.cookieEncryptionKey);
			if (zeroKey.kind === "ok") return zeroKey.key;
			return createKeyProvider({
				passphrase: bootstrap.cookieEncryptionKey,
				keyPath: dataPath(generation.partialDir, "secrets", "master.key"),
				saltPath: dataPath(generation.partialDir, "secrets", "kdf.salt"),
				logger: log,
			}).getKey();
		};

		// Dashboard session codec. Signing key = HKDF over the runtime's stable key
		// material (the same key infra StorageManager uses — passphrase-derived from
		// BN_COOKIE_KEY when set, else the persisted random master.key), so cookies
		// survive a restart without a new required config knob. Built only when auth
		// is configured; the credential fingerprint is folded into the HKDF salt so
		// rotating the dashboard password invalidates every old cookie.
		const sessionCodec = basicAuthCredentials
			? createSessionCodec({
					keyMaterial: await sessionKeyMaterial(),
					creds: basicAuthCredentials,
				})
			: undefined;

		// 开机先 listen,再读数据(ADR-0022 决策 2 与它下面的 🔗):数据与引擎起来之前由开机那一段的
		// app 应答 —— 健康检查照答,别的接口 503 `unavailable`,鉴权闸与完整的 app 是同一套。桌面壳 30 秒
		// 等的就是健康检查;启动入口本身仍等全部起来才返回,数据段抛错时 boot.mjs 还能当场退回预装的那一版。
		const appShell = {
			staticDir: effectiveWebDistDir,
			desktopToken,
			basicAuthCredentials,
			sessionCodec,
			allowedOrigins,
		};
		let startupMessage =
			generation.kind === "create" ? "BN 正在搬家,稍等一下" : "BN 正在启动,稍等一下";
		let currentApp = createStartupApp(runtime, {
			...appShell,
			message: () => startupMessage,
		});
		await new Promise<void>((resolveServe) => {
			server = serve(
				{
					fetch: (request, env) => currentApp.fetch(request, env),
					hostname: bootstrap.server.host,
					port: bootstrap.server.port,
				},
				(info) => {
					listeningPort = info.port;
					log.info(`listening on http://${info.address}:${info.port}`);
					resolveServe();
				},
			);
		});
		// 排空登记紧跟着 listen:数据段一抛错,关停就得把这个端口放掉 —— boot.mjs 要在同一进程里
		// 起预装的那一版,端口还占着的话它连 listen 都做不到。WS 这时还没建,排空时现取。
		runtime.serviceCtx.onDispose(
			() => drainHttp(server, wsServer, shutdownTimeoutMs * HTTP_DRAIN_SHARE, log),
			"drain",
		);

		// 要开新代的话在这里迁(ADR-0022 决策 2):listen 之后、读数据之前。迁移期间别的接口回 503,
		// 话里带进度;迁移抛错就和别的开机失败一样关掉 HTTP 再抛,boot.mjs 退回预装的那一版。
		if (generation.kind === "create") {
			let report: ZeroMigrationResult | undefined;
			await createGeneration(generation, {
				formatVersion: FORMAT_VERSION,
				migrationRevision: MIGRATION_REVISION,
				createdBy: APP_VERSION,
				fill: async (partialDir) => {
					report = await migrateZeroGeneration({
						zeroRoot: hostRoot,
						targetDir: partialDir,
						passphrase: bootstrap.cookieEncryptionKey,
						onProgress: ({ done, total, label }) => {
							startupMessage = `BN 正在搬家(${done}/${total}):${label}`;
						},
					});
				},
			});
			startupMessage = "BN 正在启动,稍等一下";
			log.info(
				`[data] 第 ${generation.seq} 代迁好了:搬了 ${report?.transfers.length ?? 0} 个文件,第 0 代原样留着当备份`,
			);
			if (report && report.skipped.length > 0) {
				log.info(
					`[data] 没带过来的:${report.skipped.map((s) => `${s.path}(${s.reason})`).join("、")}`,
				);
			}
		}

		// Load the at-rest secrets key during startup, not on the first settings write.
		// Without this eager touch, zero-auth local runs only hit the key lazily when
		// SecretStore.save() is first needed (e.g. changing rules.restartPush), making
		// the normal "主密钥加载成功" log look like it was caused by that setting.
		await runtime.keyProvider.getKey();
		// 统计采集从这一刻算起:数据那一代已经就位,引擎还没起(ADR-0022 决策 2 —— 建运行时那会儿
		// 不许碰盘)。
		runtime.statsRecorder.start();

		// Load on-disk runtime config (config/settings/core.json, config/subscriptions.json, config/targets.json).
		// Seeds defaults on first boot. Failure here is fatal — we don't want to start serving HTTP
		// against a corrupt or unreadable state dir.
		await runtime.configStore.load();
		// Per-sub runtime data (cachedProfile / fansBaseline). Independent file,
		// absent / malformed → empty (non-fatal: it's a regenerable display cache).
		await runtime.subRuntimeStore.load();

		// Stage 2.4: assemble the auth stack (StorageManager → BilibiliAPI → LoginFlow). Bus
		// emissions made by LoginFlow flow into the WS `auth` channel via stage 2.3 wiring.
		try {
			authSystem = await createAuthSystem({
				serviceCtx: runtime.serviceCtx,
				bus: runtime.bus,
				bootstrap,
				dataRoot: runtime.dataRoot,
				keyProvider: runtime.keyProvider,
				// 从 globals.app.healthCheckMinutes 计算初始 ms;后续 config-changed
				// 会通过 engines.ts 调 flow.setHealthCheckMs 热更。
				healthCheckMs: runtime.configStore.getGlobals().app.healthCheckMinutes * 60_000,
			});
		} catch (err) {
			// Fatal: without StorageManager / BilibiliAPI the dashboard can't function.
			log.error("auth system init failed", err);
			throw err;
		}
		runtime.serviceCtx.onDispose(() => authSystem?.dispose(), "stop");

		// Lazy puppeteer-core launch — only constructed when chromePath or a remote
		// chromeEndpoint is set. Browser spawns/connects on first use (cards/preview
		// OR engine card render), not at boot. Built before createEngines so live +
		// dynamic can share the same ImageRenderer instance as /api/cards/preview.
		const chromeIdleTimeoutMs =
			bootstrap.chromeIdleSeconds === undefined ? undefined : bootstrap.chromeIdleSeconds * 1000;
		// 启动实际生效的来源(endpoint 赢过 path),供 /render-source 展示与同源幂等判断。
		const chromeSource: ChromeSource | undefined = bootstrap.chromeEndpoint
			? { chromeEndpoint: bootstrap.chromeEndpoint }
			: bootstrap.chromePath
				? { chromePath: bootstrap.chromePath }
				: undefined;
		// 浏览器排在最后一段:HTTP 排空期间在途的出图请求还要用它。热启用会换掉 `puppeteer`,所以现取。
		runtime.serviceCtx.onDispose(() => puppeteer?.dispose());
		if (chromeSource) {
			puppeteer = createPuppeteerAdapter({
				chromePath: bootstrap.chromePath,
				chromeEndpoint: bootstrap.chromeEndpoint,
				idleTimeoutMs: chromeIdleTimeoutMs,
				logger: log,
			});
		} else {
			log.warn(
				"chromePath / chromeEndpoint 均未配置，卡片图片渲染将退化为文字推送（设置 BN_CHROME_PATH、BN_CHROME_ENDPOINT 或 yaml 对应字段后启用）",
			);
		}

		// Engine layer (Stage 4 P0). The order matters:
		//   1. SubscriptionStore binding mirrors the file-backed config into an
		//      in-memory store + emits subscription-changed on diffs.
		//   2. Platform adapters are constructed from logger; they hold no state.
		//   3. createEngines() builds Sink → BilibiliPush → DynamicEngine + LiveEngine
		//      and registers serviceCtx.onDispose for graceful shutdown.
		subBinding = bindSubscriptionStore({ bus: runtime.bus, configStore: runtime.configStore });
		runtime.serviceCtx.onDispose(() => subBinding?.dispose(), "stop");
		// Boot-time orphan sweep: drop sub-runtime entries whose subscription no
		// longer exists (deleted while the server was down). FansPoller's
		// subscription-changed listener handles deletions made while running.
		await pruneOrphanSubRuntime(runtime.subRuntimeStore, subBinding.store);
		// 拓展订阅的头像文件同理(ADR-0019 决策 49),保留名单同样是两支的全部 id。扫不动不致命:
		// 最多多留几个孤儿文件,下次开机再扫。
		// 头像不进备份(决策 49,与资料缓存同一口径):恢复之后等拓展下一次报资料再来。
		await runtime.subAvatarStore
			.sweep(subBinding.store.list().map((s) => s.id))
			.catch((err) => log.warn(`[sub-avatar] 开机清扫失败: ${String(err)}`));
		// 入站的转发口。指令处理器要等 engines / 调度器建好才有,所以这里先留两个
		// 可后填的引用 —— adapter 建得比它们早。
		//
		// 两个 adapter 都在自己那层把帧归一化成平台中立的形状,汇合点是同一个。
		let onInboundPrivate: ((msg: InboundPrivateMessage, meta: InboundMeta) => void) | undefined;
		let onInboundGroup: ((msg: InboundGroupMessage, meta: InboundMeta) => void) | undefined;
		// 当前跑的这份载荷的版本 —— 启动时算过一次的那个常量,别再向上找一遍 package.json。
		const payloadVersion = APP_VERSION;
		// 构建产物的入口恒为 `.mjs`;只有 tsx 直跑源码时才是 `.ts`。devtools 那道门与
		// 「能不能重启」是同一个事实,算一次两处用。
		const sourceRun = import.meta.url.endsWith(".ts");
		// 按下重启还回不回得来 —— 判的是外面有没有人拉,与「是不是开发版」不是一回事。
		const restartAbility = resolveRestartAbility({
			parentPid: process.env.BN_PARENT_PID,
			sourceRun,
			inContainer: runningInContainer(),
		});

		/**
		 * 优雅停机 + 退 0,等外面那位把它拉起来 —— 应用更新与「重启一下」共用这一段。
		 *
		 * **退出码必须是 0**:非 0 会被编排系统当成崩溃,退避重启甚至进 CrashLoopBackOff;
		 * 桌面外壳那边同样只认 0(见 sidecar_exit_disposition),非 0 会摊出一张崩溃页。
		 */
		const stopAndExit = async (reason: string): Promise<void> => {
			try {
				await close(reason);
			} catch (err) {
				// close() 自己不抛(钩子各自兜错),这里只是兜底。真抛了也得退 0:这时进程反正
				// 要没了,非 0 只会让编排系统当成崩溃去退避重启。
				log.error(
					`${reason}: graceful close failed, exiting anyway: ${err instanceof Error ? err.message : String(err)}`,
				);
			} finally {
				process.exit(0);
			}
		};
		// **唯一那个装载根**(`<dataRoot>/extensions/`)。市场、装载器、面板上传装包、开发版
		// devtools 认的是同一个目录 —— 算四遍等于给「拓展装在哪」留了四个改错的机会。
		const extensionsRoot = extensionsRootIn(runtime.dataRoot);
		// 拓展市场(ADR-0013):官方源与自主升级共用同一对信任公钥与同一份加速前缀;没有公钥的
		// 构建(fork 出去自己构建的)就没有官方源,第三方源照用。
		const marketplace = createMarketplace({
			root: extensionsRoot,
			official:
				TRUSTED_UPDATE_KEYS.length > 0
					? { url: EXTENSION_MARKETPLACE_URL, trustedKeys: TRUSTED_UPDATE_KEYS }
					: undefined,
			sources: () => runtime.configStore.getGlobals().marketplace.sources,
			mirrors: () => runtime.configStore.getGlobals().update.mirrors,
			prerelease: () => runtime.configStore.getGlobals().update.channel === "prerelease",
			installed: () =>
				loadedExtensions
					?.list()
					.map((entry) => ({ id: entry.id, version: entryIdentity(entry)?.version })) ?? [],
			// 装载器比市场晚一步建起来;还没有它的那一瞬(开机途中)没人会按「装」,直接写就是。
			changeDisk: (write) => (loadedExtensions ? loadedExtensions.changeDisk(write) : write()),
			logger: log,
		});
		const updateService = createUpdateService({
			currentVersion: payloadVersion,
			// boot.mjs 在加载这份载荷之前摆进来的(见 src/boot.ts)。直接跑
			// index.mjs 时(dev / 老镜像)拿不到 —— 那就当自己就是地板,
			// 「没得退」,而不是瞎猜一个版本号。
			imageVersion: normalizeOptionalEnv(env.BN_IMAGE_VERSION) ?? payloadVersion,
			// 和 boot.mjs 那侧(update/versions-root.ts)算的是同一个目录 —— 这段路径
			// 只写一处,写岔了两边都不报错,症状是「升完了重启还是旧版本」。
			versionsRoot: versionsRootIn(runtime.hostRoot),
			nodeMajor: Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10),
			trustedKeys: TRUSTED_UPDATE_KEYS,
			manifestUrls: UPDATE_MANIFEST_URLS,
			releasesPageUrl: RELEASES_PAGE_URL,
			// 每次现读:用户在面板上改完渠道 / 加速前缀,下一次检查就该按新的来。
			readSettings: () => runtime.configStore.getGlobals().update,
			serviceCtx: runtime.serviceCtx,
		});
		const rawAdapters = [
			createOnebotAdapter({
				logger: log,
				serviceCtx: runtime.serviceCtx,
				onInboundPrivate: (msg, meta) => onInboundPrivate?.(msg, meta),
				onInboundGroup: (msg, meta) => onInboundGroup?.(msg, meta),
			}),
			createQQOfficialAdapter({
				logger: log,
				serviceCtx: runtime.serviceCtx,
				registry: qqSessionRegistry,
				onInboundPrivate: (msg, meta) => onInboundPrivate?.(msg, meta),
				onInboundGroup: (msg, meta) => onInboundGroup?.(msg, meta),
			}),
			createWebhookAdapter({ logger: log }),
		];
		// 出口从此住在一张**活的注册表**里:内置这几个开机就在,拓展注册进来的后到、
		// 拨开关还会走(ADR-0012 决策 29)。消费方在分发那一刻问它要,不存快照。
		const adapterRegistry = createAdapterRegistry(rawAdapters);

		// 主人是「谁」—— 平台 + 地址(+ 是哪个 bot 看到的)三坐标,不是一个裸字符串。
		// onebot 的 user_id 与官机的 C2C openid 是两个命名空间,撞上就等于认错人;
		// 从前那句「绝不能跨平台比对」只写在注释里,真正兜着它的是「一条连接只驮一个
		// 平台」这个前提。取不到(没配 / 配的是群目标 / 地址还没填)就返回 undefined,
		// 于是谁都不认。
		//
		// 审批与指令分发共用同一个来源:各写一份迟早有一边判得不一样。
		const masterIdentity = () => {
			const id = runtime.configStore.getGlobals().master.targetId;
			if (!id) return undefined;
			return chatIdentityOf(runtime.configStore.getTargets().find((x) => x.id === id));
		};

		// devtools:门是载荷版本号(开发版才给,alpha 也不给)。给的话往下传的都是装饰过的:
		// 更新路由拿到的能被注入假状态,adapter 拿到的包着截流闸,api 套着 Proxy —— 真服务 /
		// 真 adapter / 真 api 一行不动。
		// `subBinding` 是个会在关停时清掉的 let,闭包里收不窄;先把 store 取出来。
		const subStore = subBinding.store;
		const devtools = createDevtools({
			payloadVersion,
			sourceRun,
			updateService,
			// 「拓展有更新」装饰的是它:列表与装都从包好的那份过,市场本体一行不动。
			marketplace,
			adapters: adapterRegistry,
			// 开发版装拓展那条路(见 devtools/scenarios/extensions.ts)。仓里那个目录只在
			// 源码运行时够得着,而 devtools 本来就只在那种构建里存在 —— 两道门是同一道。
			extensions: {
				repoDir: resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "extensions"),
				installRoot: extensionsRoot,
				loaded: () => loadedExtensions,
			},
			// 「假装一条桥连上来」要连回自己身上。走 127.0.0.1 而不是 bootstrap 里那个 host:
			// 那格常是 `0.0.0.0`(监听通配),拿它当目的地连不上。
			address: () => (listeningPort ? `127.0.0.1:${listeningPort}` : undefined),
			historyStore: runtime.historyStore,
			api: authSystem.api,
			// 场景挑订阅:配置里的订阅 + 运行时解析出的房号(与 room-session 拿的是同一份)。
			// 只挑 B 站订阅:这些场景造的是 B 站的直播 / 动态事件(ADR-0019 决策 12)。
			subs: () =>
				subStore
					.list()
					.filter((sub) => subscriptionIdentityOf(sub).sourceKey === BILIBILI_SOURCE_KEY)
					.map((sub) => {
						const uid = subscriptionIdentityOf(sub).externalId;
						return {
							id: sub.id,
							uid,
							name: runtime.subRuntimeStore.get(sub.id)?.cachedProfile?.name ?? uid,
							enabled: sub.enabled,
							roomId: runtime.subRuntimeStore.get(sub.id)?.roomId,
							specialUsers: sub.specialUsers.map((u) => u.uid),
							avatar: runtime.subRuntimeStore.get(sub.id)?.cachedProfile?.avatar,
						};
					}),
			// 下面几样都是引擎建好之后才有的,现取 —— devtools 建得比引擎早。
			dynamic: () => engines?.dynamic,
			inbound: () => ({ private: onInboundPrivate, group: onInboundGroup }),
			commands: () => ({
				prefix: runtime.configStore.getGlobals().commands.prefix,
				master: masterIdentity(),
			}),
			connectionConfigs: () => runtime.configStore.getConnections(),
			globals: () => runtime.configStore.getGlobals(),
			targets: () => runtime.configStore.getTargets(),
			bus: runtime.bus,
			authSystem,
			puppeteer: () => puppeteer,
			live: () => engines?.live,
			mute: () => engines?.muteState,
			fansPoller: () => runtime.fansPoller ?? undefined,
			// `authSystem` 是个会在关停时清掉的 let;这一刻它一定在(上面刚建的)。
			loginFlow: () => authSystem?.flow,
		});
		if (devtools) log.info("devtools enabled (dev build): /api/dev is mounted");
		const adapters = devtools?.adapters ?? adapterRegistry;

		// ---------- 卡片皮肤库(ADR-0014)----------
		// **全进程唯一一家店**:出图(engines 的 ImageRenderer)、面板的皮肤库路由、卡片
		// 预览三处问的都是它。各建一家的话,面板装了新皮肤而推送还在用开机那一刻的索引,
		// 症状还是静默的(装包成功、出图不变)。
		//
		// 顺序是:`configStore.load()`(上面早就跑过)→ 建店 + `init()` 读盘 → 才把 `get`
		// 交给引擎。(开机一次性的「旧版式 → 皮肤」迁移已整个退役,见 ADR-0014 决策 17
		// 的 2026-09-18 🔗:没选过皮肤的一律用出厂默认。)
		//
		// ⚠️ 走 `ensureReady()` 而不是裸 `init()`:`ensureReady` 是 `this.ready ??= this.init()`,
		// 而 `init()` 自己**不设** `this.ready` —— 裸调它开机是读了盘,但那把锁还空着,于是
		// 首个 `/api/card-skins*` / 预览 / 工坊请求会在**请求路径上**把整个皮肤目录再读一遍。
		// 真正的代价不是那点 I/O:`init()` 开头一句 `index.clear()`,之后一串 await 才填满,
		// 而出图那头 `get(id)` 是**同步**读同一个实例的索引 —— 这个窗口里撞上一次推送就回落
		// 默认皮肤并记一笔 fallback(2026-09-19 审查)。
		cardSkinStore = createCardSkinStore(runtime.dataRoot);
		await cardSkinStore.ensureReady();
		for (const w of cardSkinStore.warnings()) log.warn(`[card-skin] ${w}`);
		const cardSkinFallbacks = createCardSkinFallbackLog({ logger: { warn: (m) => log.warn(m) } });
		const skins = cardSkinStore;

		// 拓展详情页的「上报问题」(ADR-0019 决策 60):ctx 那个出口与拓展直播的计时器(周期推送跳过的那一轮,
		// 决策 61)写进来,拓展列表那一口读出去。只在内存。记了新的 → bus → WS `state` 频道 → 面板让拓展表
		// 失效(按拓展合并过)。建在引擎之前:引擎里的计时器也往里记。
		const reportProblems = createReportProblemLog({
			onChanged: (id) => runtime.bus.emit("extension-report-problems-changed", { extensionId: id }),
		});
		runtime.serviceCtx.onDispose(() => reportProblems.dispose(), "stop");

		engines = createEngines({
			serviceCtx: runtime.serviceCtx,
			dataRoot: runtime.dataRoot,
			// 全进程唯一那个字体读取口 —— 预览路由经 RouteDeps.runtime 取的是同一个。
			loadFontFace: runtime.loadFontFace,
			api: devtools?.api ?? authSystem.api,
			quietHoursNow: devtools?.quietHoursNow,
			// 女仆查订阅时拓展订阅的平台名(ADR-0019 决策 64):清单里订阅源的叫法 → 拓展名。装载器比
			// 引擎晚一步建起来,所以现取;取不到就交 undefined,视图退拓展 id(同面板,决策 10)。
			extensionPlatformLabel: (id) => {
				const entry = loadedExtensions?.list().find((one) => one.id === id);
				if (!entry) return undefined;
				const view = entry.manifest && manifestSubscriptionView(entry.manifest);
				return view?.display.label ?? entryIdentity(entry)?.name;
			},
			// 拓展订阅推送要现取的几样(ADR-0019 决策 54 / 61 / 70):拓展在不在跑、清单里平台对作品的
			// 叫法、存下的头像文件。同上,装载器晚一步建起来,所以都现取。
			extensionSources: {
				running: (id) =>
					loadedExtensions?.list().some((one) => one.id === id && one.state === "running") ?? false,
				postNoun: (id) => {
					const entry = loadedExtensions?.list().find((one) => one.id === id);
					return entry?.manifest && manifestSubscriptionView(entry.manifest)?.display.postNoun;
				},
				readAvatar: (id) => runtime.subAvatarStore.read(id),
			},
			// 拓展直播的最新状态与女仆查直播状态(ADR-0019 决策 57 / 64)都从在播表取。
			extensionLive: runtime.extensionLive,
			extensionReportProblem: (problem) => reportProblems.record(problem),
			loginFlow: authSystem.flow,
			configStore: runtime.configStore,
			historyStore: runtime.historyStore,
			subscriptionStore: subBinding.store,
			subRuntimeStore: runtime.subRuntimeStore,
			bus: runtime.bus,
			adapters,
			puppeteer,
			cardSkins: {
				get: (id) => skins.get(id) ?? undefined,
				asset: (skinId, name) => readCardSkinAssetDataUrl(skins, skinId, name),
				onFallback: (info) => cardSkinFallbacks.record(info),
			},
		});
		runtime.attachEngines(engines);

		// 资源采样:概览页「系统资源」卡的数据源,也是内存自检那行日志的出处。
		// 挂在 engines 之后,好把弹幕收集器的规模一起报出来 —— 那是引擎里唯一
		// 一处随「弹幕量 × 在播时长」无界增长的结构,堆涨时第一个该看它。
		resourceMonitor = startResourceMonitor({
			serviceCtx: runtime.serviceCtx,
			// 开发版才有:堆读数可被 devtools 换掉,占比 / warn / 曲线全照真的算一遍。
			readers: devtools ? { memoryUsage: devtools.memoryUsage } : undefined,
			// 浏览器那一行:`puppeteer` 是可换的(系统页改 chrome 来源会热换一个新适配器),
			// 所以每次现问那个变量,别把当下这一个捕进闭包。
			browser: {
				info: () => puppeteer?.browserProcess() ?? { state: "none", pid: null },
				subtreeRss: (pid) => browserSubtreeRss(pid),
			},
			// 每 tick 现问,系统页拨一下开关立刻生效,不用重启也不用另接 config-changed。
			memoryLogEnabled: () => runtime.configStore.getGlobals().app.memoryLog,
			probes: [
				() => {
					const s = engines?.live.danmakuStats();
					return s ? `弹幕 ${s.rooms} 房/${s.words} 词/${s.senders} 人` : "";
				},
			],
		});

		// 孤儿自检:只有桌面版 launcher 会传 BN_PARENT_PID,Docker / 直接跑都不受影响。
		// launcher 被强杀时不会带走我们,不自己盯着就会变成占着数据目录的孤儿。
		const expectedParent = resolveExpectedParent(process.env.BN_PARENT_PID);
		if (expectedParent !== null) {
			startParentWatch({
				expectedParent,
				onOrphaned: () => {
					log.warn("launcher 进程已消失,sidecar 主动退出,避免变成孤儿占住数据目录");
					// 走 SIGTERM 而不是直接 exit —— 复用已装好的优雅关停路径,
					// 别在这里另起一条收尾逻辑。
					process.kill(process.pid, "SIGTERM");
				},
				schedule: (fn, ms) => {
					runtime.serviceCtx.setInterval(fn, ms);
				},
			});
		}

		// Daily retention pass for history jsonl files.
		startHistoryRetention({
			serviceCtx: runtime.serviceCtx,
			store: runtime.configStore,
			dataRoot: runtime.dataRoot,
			logger: log,
		});

		// Daily retention pass for the log archive (globals.app.logRetentionDays).
		startLogRetention({
			serviceCtx: runtime.serviceCtx,
			store: runtime.configStore,
			hostRoot: runtime.hostRoot,
			logger: log,
		});

		// 启动 FansPoller — cron 跟 globals.app.dynamicCron,每个 enabled sub
		// 拉一次 B 站 fans 数,写时序 jsonl + emit `fans-refreshed`。
		const fansPoller = startFansPoller({
			bus: runtime.bus,
			logger: log,
			configStore: runtime.configStore,
			subscriptionStore: subBinding.store,
			subRuntimeStore: runtime.subRuntimeStore,
			fansStore: runtime.fansStore,
			api: authSystem.api,
			serviceCtx: runtime.serviceCtx,
		});
		runtime.attachFansPoller(fansPoller);
		runtime.serviceCtx.onDispose(() => fansPoller.dispose(), "stop");

		// ── 定时锐评 ──────────────────────────────────────────────────────────
		// 草稿库 → 调度器 → 审批指令,按依赖顺序建;取数与主人私聊两个口子是回填的
		// (statsRoute 要等 createApp,engines 上面刚建好)。
		const roastDrafts = createRoastDraftStore({ dataRoot: runtime.dataRoot, logger: log });
		await roastDrafts.load();
		runtime.serviceCtx.onDispose(() => roastDrafts.close(), "flush");

		let statsRoute: Hono | null = null;
		/** 私聊主人。发不出去由调用方各自兜住(调度器与指令处理器都不让它拖垮流程)。 */
		const tellMaster = async (text: string): Promise<void> => {
			await engines?.push.sendPrivateMsg(text);
		};
		// 审批预览要发的是渲染好的那一份(出图就发图),所以走 payload 版而不是
		// sendPrivateMsg —— 后者只收字符串。
		const tellMasterPayload = async (payload: NotificationPayload): Promise<void> => {
			await engines?.push.sendToMaster(payload);
		};

		const roastScheduler = createRoastScheduler({
			deps: { runtime, store: runtime.configStore },
			drafts: roastDrafts,
			logger: log,
			// 与手动锐评**同一条路径**:内部代理一次 stats 子路由的 /overview。
			// 子路由上没有鉴权中间件(鉴权在父 app 的 /api/*),而调度器与 route
			// handler 同属鉴权边界内的进程内代码 —— 走父 app 反而会被自己 401。
			fetchOverview: async (days, tz) => {
				if (!statsRoute) return null;
				const res = await statsRoute.request(`/overview?days=${days}&tz=${tz}`);
				if (!res.ok) return null;
				try {
					return (await res.json()) as StatsOverviewResponse;
				} catch {
					return null;
				}
			},
			tellMaster,
			tellMasterPayload,
		});

		// 主人在他那条私聊通道上的身份 —— 只有这个 id 敲的指令算数。
		//
		const roastCommands = createRoastCommandHandler({
			drafts: roastDrafts,
			logger: log,
			masterIdentity,
			deliver: (draft) => roastScheduler.deliverApproved(draft),
			reply: tellMaster,
		});

		// 自引用:帮助要列出「包括它自己在内」的全部指令,所以先建表再往里塞。
		//
		// **所有 push 必须排在下面 createCommandDispatcher 之前** —— 它在构造时就把
		// 指令表编译好(解析签名、排触发词)。之后再 push 的指令会出现在帮助里,
		// 却永远不响应,而帮助里看得见恰恰让人不往这上面想。
		const commands: CommandSpec[] = [];
		commands.push(
			command({
				name: "help",
				aliases: ["帮助", "?"],
				signature: "[name:string|指令名]",
				description: "看看能敲哪些指令",
				example: "mute",
				// values.name 由签名推出来,是 string | undefined —— 不用断言、不用 typeof。
				// 报错里显示的是「指令名」那个显示名,不是 name。
				run: async (values) => {
					// 前缀与别名都**现读**:主人改完前缀,帮助恰恰是他第一个会看的东西,
					// 而列出一批已经被他改掉的别名等于教他敲没反应的词。
					const cfg = runtime.configStore.getGlobals().commands;
					const entries = commands.map((c) => ({
						...c,
						aliases: effectiveAliases(c, cfg.aliases),
					}));
					await tellMaster(renderHelp(entries, cfg.prefix, values.name));
				},
			}),
		);
		// 静音的闸装在 push 里(见 engines.ts),这里只是改状态的入口。
		commands.push(createMuteCommand({ muteState: engines.muteState, reply: tellMaster }));
		commands.push(
			createStatusCommand({
				reply: tellMaster,
				probe: () => ({
					// 登录态直接用 LoginFlow 那句人话(「已登录」/「账号登录已失效…」)——
					// 在这儿把 status 码再翻译一遍,就是第二份会跟它跑偏的文案。
					login: authSystem?.status().msg ?? "还没起来",
					lastFetchAt: engines?.dynamic.lastFetchAt(),
					// 没装 Chrome 就没有渲染队列。
					renderQueue: puppeteer?.renderQueueDepth() ?? 0,
					connections: runtime.configStore
						.getConnections()
						.filter((a) => a.enabled)
						// **没探测过 ≠ 断了**。webhook 这类平台压根不支持探测,testStatus
						// 永远是 undefined;当成断线的话主人会永远看见一条假报警。
						.map((a) => ({ name: a.name, ok: a.testStatus?.ok ?? true })),
					mutedUntil: engines?.muteState.mutedUntil() ?? 0,
				}),
			}),
		);
		commands.push(
			createReportCommand({
				logger: log,
				reply: tellMaster,
				// 审批开着时,草稿连同「回复 y <id>」由调度器自己私聊出去,指令层不再补一句。
				run: (days) => roastScheduler.runBoardOnce(days),
			}),
		);
		commands.push(
			createLoginCommand({
				logger: log,
				reply: tellMaster,
				begin: () => authSystem?.beginLogin() ?? Promise.resolve(),
				snapshot: () => authSystem?.status() ?? { status: 0, msg: "登录系统还没起来" },
				// **走 sendToMaster 而不是普通推送**:它强制私聊,onebot adapter 在拿不到
				// userId 时直接报错而不会回落到群。二维码进群等于公开征集「谁来当我的
				// B 站账号」。这里还要把「没送到」如实带回去 —— 见 login-command.ts。
				sendQr: async (buffer) => {
					// LoginFlow 的 renderQr 走 qrcode 包的 toDataURL,产物恒为 PNG。
					const r = await engines?.push.sendToMaster({
						kind: "image",
						image: { buffer, mime: "image/png" },
					});
					return r?.ok === true;
				},
			}),
		);

		const commandDispatcher = createCommandDispatcher({
			logger: log,
			masterIdentity,
			reply: tellMaster,
			config: () => runtime.configStore.getGlobals().commands,
			commands,
			// 审批的 y/n 作为第二道门 —— 有待审草稿时才认,没有时它只是个普通字母。
			confirmation: roastCommands.confirmation,
		});

		// 群里贴视频链接 → 回一张卡。回到来源群不走推送目标表:用收到这条消息的那个
		// 那条连接直接发,群不必配成推送目标(主人定的:机器人在的所有群都算)。
		// OneBot 的 groupId 是群号,官机的是群 openid —— 临时目标按平台各造各的。
		// `engines` 是个会被热重载赋值的 let,闭包里 TS 收不窄;这一刻它一定在(上面刚建的)。
		const runtimeEngines = engines;
		// 回到来源群用的是收到那一帧的那条连接:配置里那条 + 认领它的那个 adapter,两者都在
		// 才发得出。**按连接找 adapter,不按消息里报的平台名找** —— 拓展驮进来的连接后面
		// 挂着 telegram 时平台报的是 telegram,而认领它的 adapter 按的是拓展 id。
		const replyRoute = (connectionId: string) => {
			const connection = runtime.configStore.getConnections().find((a) => a.id === connectionId);
			if (!connection) return null;
			const platformAdapter = adapterForConnection(adapters.list(), connection);
			return platformAdapter ? { connection, platformAdapter } : null;
		};
		const linkParser = createLinkParser({
			logger: log,
			// 开关与呈现都从引擎拿:随 config-changed 刷新的快照,呈现规则与推送的动态卡同源。
			config: () => runtimeEngines.linkParsing(),
			policyFor: (key) => runtimeEngines.linkPolicyFor(key),
			api: runtimeEngines.api,
			renderer: () => runtimeEngines.imageRenderer,
			presentation: () => runtimeEngines.linkCardPresentation(),
			// 能力走 sink 那条连接寻址(健康探测与 /api/connections/capabilities 用的是同一份),
			// 别在接线层再手写一条 —— 两条路会各自漂。
			capabilities: ({ connectionId }) => runtimeEngines.connectionCapabilities(connectionId),
			probeCapabilities: ({ connectionId }) =>
				runtimeEngines.probeConnectionCapabilities(connectionId),
			send: async ({ platform, connectionId, groupId }, payload) => {
				const route = replyRoute(connectionId);
				if (!route) {
					return {
						ok: false,
						latencyMs: 0,
						err: `connection not found: connectionId=${connectionId}`,
					};
				}
				const { connection, platformAdapter } = route;
				const common = {
					id: `link-reply:${groupId}`,
					name: "链接解析回复",
					connectionId,
					kind: "session" as const,
					scope: "group" as const,
					enabled: true,
				};
				// 地址收成一格之后这里不再按平台分岔:群目标的地址就是群号 / 群 openid。
				// 用哪个 bot 回由连接说了算 —— 一条连接就是一个 bot,桥那一支也一样。
				return platformAdapter.send(connection, { ...common, platform, address: groupId }, payload);
			},
		});

		// adapter 们交出来的是同一个形状:私聊进指令分发,群进链接解析。「从哪儿来」全在
		// `meta` 里 —— 平台曾经由接线层另传一个参数补上,那是把同一件事说了两遍,而且那个
		// 参数是闭集,桥后面挂着的平台塞不进去。
		//
		// 处理一条入站消息是发出去不等的后台活(回指令、出卡片、落草稿都在里面),登记进 track:关停等它
		// 收尾,各写道才关门。两个入口自己吞了大部分失败,这里再接一道 —— 以前这两条连 catch 都没有。
		onInboundPrivate = (msg, meta) => {
			runtime.serviceCtx.track(
				commandDispatcher.handleMessage(msg, meta).catch((err) => {
					log.warn(
						`[command] 私聊消息处理出错: ${err instanceof Error ? err.message : String(err)}`,
					);
				}),
			);
		};
		onInboundGroup = (msg, meta) => {
			runtime.serviceCtx.track(
				linkParser
					.handleMessage({
						...msg,
						platform: meta.platform,
						connectionId: meta.connectionId,
					})
					.catch((err) => {
						log.warn(`[link] 群消息处理出错: ${err instanceof Error ? err.message : String(err)}`);
					}),
			);
		};

		roastScheduler.start();
		runtime.bus.on("config-changed", ({ scope }) => {
			// 全局那条(roastSchedule)与 per-UP 那些(subscriptions)各自都可能增删改。
			if (scope === "globals" || scope === "subscriptions") roastScheduler.reconcile();
			// 别名进了触发词表,得重建;前缀与总开关是现读的,不用管。
			// reconcile 自己吞异常 —— 这里是总线回调,抛出去会被 unhandledRejection
			// 处理器变成一次进程退出。
			if (scope === "globals") commandDispatcher.reconcile();
		});
		runtime.serviceCtx.onDispose(() => roastScheduler.stop(), "stop");

		// 过期草稿:每小时清一轮,清掉的**告诉主人一声**。悄悄消失的话他只会以为
		// 这期又没发 —— 那正是这个功能要消除的沉默。
		runtime.serviceCtx.setInterval(
			() => {
				// 清扫写草稿库,登记进 track:关停等它写完,草稿库才关门。
				runtime.serviceCtx.track(
					roastDrafts
						.sweep()
						.then(async (dead) => {
							for (const d of dead) {
								await tellMaster(`编号 ${d.id} 的锐评超过 48 小时没有回复，已经作废了～`);
							}
						})
						.catch((err) => {
							log.warn(
								`[roast-draft] 过期清理失败: ${err instanceof Error ? err.message : String(err)}`,
							);
						}),
				);
			},
			60 * 60 * 1000,
		);

		// 运行时 chromePath 写回目标:仅 B 模型(显式 BN_CONFIG)有单一可写文件;
		// legacy/disabled 返回 null → 热启用仍生效但不持久化(改配置走 env / 手编辑)。
		const configPath = resolveConfigPath({ env });
		const backupService = authSystem
			? createBackupService({
					configStore: runtime.configStore,
					cookieStore: authSystem.storage.cookieStore,
					onCookiesRestored: () => authSystem?.reloadCookiesFromStore(),
					// 拓展声明成密钥的 config 键,按 id 分格。**现取** —— 拓展会被拨开关加载 /
					// 卸载,而且备份服务比装载早一步建起来。空表 = 一个都没跑起来 = 每条拓展
					// 连接的 config 整片当密钥(见 sanitize 的 ExtensionSecretCodes)。
					extensionSecretCodes: () => loadedExtensions?.secretConfigCodes() ?? new Map(),
				})
			: undefined;

		// 拓展装载。**在 createApp 之前**:总入口要随 app 一起挂上,而拓展在 `activate`
		// 里注册的路由是往那张活表里写的,先后都行 —— 但名单要在路由建起来时就拿得到。
		const extensionMounts = createExtensionMounts({ logger: log });
		const extensionUpgrades = createExtensionUpgrades();
		loadedExtensions = await loadExtensions({
			// **一个根**:拓展是装进来的(市场下载 / 主人手放 / 开发版由 devtools 链进来),
			// 本体一个都不带。见 `extensions/discover.ts` 文件头。
			root: extensionsRoot,
			host: runtime.serviceCtx,
			mounts: extensionMounts,
			// 现读配置:开关是主人在面板上按的,不是开机那一刻的快照。
			isEnabled: (id) => isExtensionEnabled(runtime.configStore.getGlobals(), id),
			maxFailures: EXTENSION_MAX_LOAD_FAILURES,
			// 拓展拿它报给对家看(桥在 `welcome` 帧里告诉插件 BN 是哪一版)。
			hostVersion: payloadVersion,
			// 拓展注册的推送源进的是**没包装过**那份注册表 —— dev 下 devtools 那层视图
			// 会在 `list()` 时现包(见 devtools/index.ts)。
			adapters: adapterRegistry,
			connections: () => runtime.configStore.getConnections(),
			connection: (connectionId) => runtime.configStore.getConnection(connectionId),
			// ⛔ bus 不给拓展:宿主替它订,只把「动过了」这件事转过去。
			onConnectionsChanged: (fn) =>
				runtime.bus.on("config-changed", ({ scope }) => {
					if (scope === "connections") fn();
				}),
			// 订阅源拓展读自己名下的订阅(ADR-0019 决策 52):只递拓展那一支,归属由 ctx 按 id 筛。
			subscriptions: () =>
				runtime.configStore
					.getSubscriptions()
					.filter((sub) => subscriptionIdentityOf(sub).sourceKey !== BILIBILI_SOURCE_KEY)
					.map((sub) => {
						const identity = subscriptionIdentityOf(sub);
						return {
							id: sub.id,
							extensionId: identity.sourceKey,
							externalId: identity.externalId,
							enabled: sub.enabled,
						};
					}),
			onSubscriptionsChanged: (fn) =>
				runtime.bus.on("config-changed", ({ scope }) => {
					if (scope === "subscriptions") fn();
				}),
			// 订阅源报上来、核过、对上了订阅的一条 → bus(ADR-0019 决策 7 / 62)。出卡、存资料、首页在播都从
			// bus 上接;这一趟不等它们,拓展那头在这一下之后就 resolve。
			onSubscriptionReport: (delivery) => runtime.bus.emit("subscription-reported", delivery),
			// 丢格与整条拒(决策 60)。ctx 已经记过日志;叫面板重取的那一声由记录自己发。
			onSubscriptionReportProblem: (problem) => reportProblems.record(problem),
			// 拓展自己那份设置住 globals;是不是自己这一格动了由 ctx 比内容判。
			settings: (id) => runtime.configStore.getGlobals().extensions[id]?.settings,
			onSettingsChanged: (fn) =>
				runtime.bus.on("config-changed", ({ scope }) => {
					if (scope === "globals") fn();
				}),
			// 拓展喊「面板数据变了」→ bus → WS `state` 频道 → 面板按 id 失效缓存(不用切页)。
			onStatusChanged: (id) => runtime.bus.emit("extension-status-changed", { extensionId: id }),
			// 拓展不在跑了(停用 / 卸载 / 换代码 / 加载失败 / 关机)→ bus;替它记着的在播状态据此作废
			// (ADR-0019 决策 61),在播表从那里接。
			onStopped: (id) => runtime.bus.emit("extension-stopped", { extensionId: id }),
			inbound: {
				onInboundPrivate: (msg, meta) => onInboundPrivate?.(msg, meta),
				onInboundGroup: (msg, meta) => onInboundGroup?.(msg, meta),
			},
			upgrades: extensionUpgrades,
		});
		// 拓展登记得晚,同一段里就先收:它注册的定时器 / 端点都挂在自己那面 ctx 上,收在核心之前
		// 才不会在核心已经拆了之后还被回调进去。
		runtime.serviceCtx.onDispose(() => loadedExtensions?.dispose(), "stop");
		// 起来的那些装载器自己记过了(版本、代码指纹、软链落点,热装与换代码同一句);这里只把
		// 开机时没起来的说出来。
		for (const entry of loadedExtensions.list()) {
			if (entry.state !== "running" && entry.state !== "disabled")
				log.warn(
					`[ext] ${entry.id} 没加载(${entry.state})${entry.detail ? `:${entry.detail}` : ""}`,
				);
		}

		// 拨开关即热装卸(决策 10)。`sync()` 自己吞异常、自己排队,这里只负责把「全局配置
		// 动过了」转过去 —— 它认的是开关**变没变**,别的全局设置存一百次也不会惊动拓展。
		const extensions = loadedExtensions;
		runtime.bus.on("config-changed", ({ scope }) => {
			// 装卸拓展落盘、起停它的定时器:登记进 track,关停等这一趟装卸做完。
			if (scope === "globals") {
				runtime.serviceCtx.track(
					extensions.sync().catch((err) => {
						log.warn(`[ext] 同步拓展开关失败: ${err instanceof Error ? err.message : String(err)}`);
					}),
				);
			}
		});

		const app = createApp(runtime, {
			...appShell,
			// devtools 给的话是套了 Proxy 的那份:`status()` 可注入假登录态,别的原样。
			authSystem: devtools?.authSystem ?? authSystem,
			// 显式给一份:`authSystem.api` 是数据属性,取出来的是没装饰过的那个,卡片预览
			// 就会绕过 devtools 的 api 覆盖(假直播时预览渲染的还是真房间)。
			api: devtools?.api ?? authSystem.api,
			backupService,
			cardSkins: {
				store: skins,
				fallbacks: () => cardSkinFallbacks.list(),
				clearFallbacks: () => cardSkinFallbacks.clear(),
			},
			puppeteer,
			persistChromeSource: configPath
				? (source: ChromeSource) => persistChromeSource(configPath, source)
				: undefined,
			// 热启用成功后把新 puppeteer 接回全局引用,使进程退出时 dispose 能关掉它。
			onPuppeteerEnabled: (next) => {
				puppeteer = next;
			},
			chromeIdleTimeoutMs,
			chromeSource,
			wsTicketStore,
			qqSessionRegistry,
			extensions: {
				mounts: extensionMounts,
				loaded: () => loadedExtensions?.list() ?? [],
				status: (id) => loadedExtensions?.status(id),
				pushSource: (id) => loadedExtensions?.pushSource(id),
				bots: (id) => loadedExtensions?.bots(id),
				runAction: async (id, name) => loadedExtensions?.runAction(id, name),
				// 新建订阅时的解析门(ADR-0019 决策 52):没在跑 / 不是订阅源时装载器回 undefined → 404。
				lookup: async (id, query) => loadedExtensions?.lookup(id, query),
				// 跑着的那份交过的 zod —— 写设置时再过一道(ADR-0019 决策 35)。
				settingsSchemas: (id) => loadedExtensions?.settingsSchemas(id),
				// 列表那一行带上它的「上报问题」,卸载时清掉那一段(决策 60)。
				reportProblems,
				// 「只重载这个拓展」(决策 47):没有新版等着换上时装载器自己拒,那句话原样回面板。
				swap: async (id) => {
					await loadedExtensions?.swap(id);
				},
				// 拨完开关面板紧接着刷这一口:先把还没落地的那一下落实掉再报状态。
				settle: async () => {
					await loadedExtensions?.sync();
				},
				// 面板上传装拓展:落到唯一那个装载根,在装载器的队里写、写完当场重扫(新装的于是
				// 立刻跑起来;并发的开关 / 只重载看不见写了一半的目录)。
				install: {
					root: extensionsRoot,
					changeDisk: (write) => (loadedExtensions ? loadedExtensions.changeDisk(write) : write()),
					restartAbility,
				},
				// devtools 给的话是装饰过的那份:「拓展有更新」在它身上造(见 devtools/marketplace-injection.ts)。
				marketplace: devtools?.marketplace ?? marketplace,
			},
			// 注册表交给路由:别名冲突检查与 `GET /api/commands` 都照它来,
			// 面板上那张指令卡片不必再手写一份清单。
			commands,
			onStatsRoute: (route) => {
				statsRoute = route;
			},
			// 面板上的「试一次」—— 调的就是 cron 到点调的那两个函数,不是模拟。
			runRoastNow: (subscriptionId) =>
				subscriptionId ? roastScheduler.runSoloOnce(subscriptionId) : roastScheduler.runBoardOnce(),
			devtools: devtools?.route,
			update: {
				service: devtools?.updateService ?? updateService,
				// 与 /api/health 报的是同一个值:面板靠「startedAt 变了」认新进程。
				startedAt: STARTED_AT,
				// 应用 = 优雅停机 + 退 0,由进程管理器把新版本拉起来。**退出码必须是 0**:
				// 非 0 会被编排系统当成崩溃,退避重启甚至进 CrashLoopBackOff。
				applyUpdate: () => stopAndExit("update apply"),
			},
			// 「重启一下」走的是同一条路 —— 差别只在**为什么**关,不在怎么关。
			system: {
				ability: restartAbility,
				startedAt: STARTED_AT,
				version: payloadVersion,
				restart: () => stopAndExit("restart requested"),
			},
		});

		currentApp = app;

		// 拓展的 upgrade 分发与 WebSocket 都从这一刻起才收连接(`ws://<BN>/ext/<id>`、`/ws`):
		// 数据段做完之前,它们要的东西还不在。
		const httpServer = server as unknown as HttpServer;
		extensionUpgrades.attach(httpServer);
		wsServer = createWsServer({
			httpServer,
			bus: runtime.bus,
			serviceCtx: runtime.serviceCtx,
			resources: resourceMonitor,
			authRequired: !!basicAuthCredentials,
			wsTicketStore,
			allowedOrigins,
			desktopToken,
			logChannel,
		});

		const handle: ServerHandle = {
			host: bootstrap.server.host,
			get port() {
				return listeningPort;
			},
			get url() {
				return `http://${bootstrap.server.host}:${listeningPort}`;
			},
			close,
		};
		if (options.installProcessHandlers)
			processHandlerCleanup = installProcessHandlers(handle, log, shutdownTimeoutMs);
		return handle;
	} catch (err) {
		await close("startup failure").catch((shutdownErr) => {
			log.error("error during startup cleanup", shutdownErr);
		});
		throw err;
	}
}

/**
 * 冻住的旧名。0.x 镜像与安装包里的 boot.mjs 不随应用内更新替换,它只认这个名字
 * (ADR-0005 决策 4):删了它,老镜像上的用户更新完就起不来。新的 boot.mjs 先调
 * `startServer`。旧名等下次换 Node 大版本那一版再删 —— 清单抬了 `requires.nodeMajor`,
 * 旧镜像会报「需要新镜像」、不会装上它。
 */
export const startStandaloneServer = startServer;

/**
 * {@link resolveWebDistDir} 之上再加一道存在性探测。
 *
 * 分两种来源区别对待:**用户点名的目录照单全收**(空着也是他的决定,我们不替他改主意);
 * **跟着载荷算出来的那个只是推断**,里面没有 `index.html` 就说明这份载荷根本没带前端 ——
 * 与其挂一个空壳目录让所有请求撞进 404,不如干脆不挂,日志里说清楚。
 */
async function resolveEffectiveWebDistDir(input: ResolveWebDistDirInput): Promise<
	| { dir: string; source: "explicit" | "payload" }
	// 只有这一档要说出「我们本来打算挂哪个目录」——而走到这里时它就是上面算出来的那个:
	// 用户点名的目录已经在上一行 return 了。
	| { dir?: undefined; source: "disabled"; payloadDir: string }
> {
	const { dir, source } = resolveWebDistDir(input);
	if (source === "explicit" || (await hasReadableIndexHtml(dir))) return { dir, source };
	return { source: "disabled", payloadDir: dir };
}

/**
 * 开机清扫的结果写成日志:清掉 / 挪回的一行 info,跳过的一行 warn;哪样都没有就不写(常态,不占日志)。
 */
/** 开机清扫几个根,报告合成一份。 */
async function sweepBootRoots(roots: readonly string[]): Promise<SweepReport> {
	const merged: SweepReport = { removed: [], restored: [], skipped: [] };
	for (const root of roots) {
		const report = await sweepTempFiles(root);
		merged.removed.push(...report.removed);
		merged.restored.push(...report.restored);
		merged.skipped.push(...report.skipped);
	}
	return merged;
}

function describeBootSweep(
	report: SweepReport,
	hostRoot: string,
): { cleaned: string | null; skipped: string | null } {
	const list = (paths: readonly string[]): string => {
		const shown = paths.slice(0, 5).map((path) => relative(hostRoot, path) || ".");
		return paths.length > shown.length ? `${shown.join("、")} 等` : shown.join("、");
	};
	const parts: string[] = [];
	if (report.removed.length > 0) {
		parts.push(`清掉 ${report.removed.length} 个临时文件 / 暂存目录(${list(report.removed)})`);
	}
	if (report.restored.length > 0) {
		parts.push(`把 ${report.restored.length} 个换到一半的目录挪回原位(${list(report.restored)})`);
	}
	const skipped = report.skipped;
	return {
		cleaned: parts.length > 0 ? `[storage] 开机清扫,上次进程没收拾完的:${parts.join(",")}` : null,
		skipped:
			skipped.length > 0
				? `[storage] 开机清扫没做完:${skipped.length} 处读不动或清不掉,跳过了(${list(skipped.map((s) => s.path))};第一处:${skipped[0]?.message})—— 那里上次留下的临时文件可能还在,不影响启动`
				: null,
	};
}

async function hasReadableIndexHtml(dir: string): Promise<boolean> {
	try {
		await access(join(dir, "index.html"), constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * HTTP 排空:不再接新连接,空闲的 keep-alive 当场关,在途请求等它答完;WS 客户端先发关闭帧。
 * 到 `capMs` 还没关完的一律强断 —— 不回关闭帧的 WS 对端、挂着半截请求的连接,不断的话会把整个
 * 关停预算吃光。拓展自己挂的 upgrade 连接由拓展收摊时关,不归这里等。
 */
async function drainHttp(
	server: ServerType | undefined,
	wsServer: ReturnType<typeof createWsServer> | undefined,
	capMs: number,
	log: Logger,
): Promise<void> {
	wsServer?.dispose();
	if (!server) return;
	const http = server as unknown as HttpServer;
	const closed = new Promise<boolean>((resolve) => http.close(() => resolve(true)));
	http.closeIdleConnections();
	let timer: NodeJS.Timeout | undefined;
	const timedOut = new Promise<boolean>((resolve) => {
		timer = setTimeout(() => resolve(false), capMs);
		timer.unref?.();
	});
	const inTime = await Promise.race([closed, timedOut]);
	clearTimeout(timer);
	if (inTime) return;
	const droppedWs = wsServer?.terminate() ?? 0;
	http.closeAllConnections();
	log.warn(
		`[shutdown] HTTP 排空超过 ${Math.round(capMs)}ms,强制断开剩下的连接(其中 ${droppedWs} 个是没回关闭帧的 WS)`,
	);
}

function normalizeOptionalEnv(value: string | undefined): string | undefined {
	return value && value.length > 0 ? value : undefined;
}

function mergeAllowedOrigins(
	configured: readonly string[] | undefined,
	desktopOrigin: string | undefined,
): string[] {
	const origins = [...(configured ?? [])];
	if (desktopOrigin && !origins.includes(desktopOrigin)) origins.push(desktopOrigin);
	return origins;
}

function installProcessHandlers(
	handle: ServerHandle,
	log: Logger,
	shutdownTimeoutMs: number,
): () => void {
	const logError = log.error.bind(log);
	let exiting = false;
	const closeThenExit = (reason: string, code: number): void => {
		// 再来的信号(连按两次 Ctrl-C、外壳补一发 SIGTERM)与关停期的未捕获错误只记一笔:
		// 关停有总预算兜着,到点一定退;这时硬杀只会把正在落盘的写道截断。记 info 不记 warn:
		// `vp run dev:apps` 下按一次 Ctrl-C 服务端就收到两发(实测相隔几毫秒),这是常态。
		if (exiting) {
			log.info(
				`[shutdown] 收到 ${reason},已在收尾,最多 ${Math.ceil(shutdownTimeoutMs / 1000)} 秒后退出`,
			);
			return;
		}
		exiting = true;
		handle.close(reason).then(
			() => process.exit(code),
			(err) => {
				logError("shutdown failed", err);
				process.exit(1);
			},
		);
	};
	const onSigint = () => closeThenExit("SIGINT", 0);
	const onSigterm = () => closeThenExit("SIGTERM", 0);
	const onUncaughtException = (err: unknown) => {
		logError("uncaughtException", err);
		closeThenExit("uncaughtException", 1);
	};
	const onUnhandledRejection = (err: unknown) => {
		logError("unhandledRejection", err);
		closeThenExit("unhandledRejection", 1);
	};
	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigterm);
	process.on("uncaughtException", onUncaughtException);
	process.on("unhandledRejection", onUnhandledRejection);
	return () => {
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
		process.off("uncaughtException", onUncaughtException);
		process.off("unhandledRejection", onUnhandledRejection);
	};
}

if (isEntrypoint(import.meta.url)) {
	startServer({ installProcessHandlers: true }).catch((err) => {
		console.error("fatal startup error", err);
		process.exit(1);
	});
}
