import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GenerationSourceKind } from "@bilibili-notify/contract";
import {
	BILIBILI_SOURCE_KEY,
	chatIdentityOf,
	type Disposable,
	fail,
	type InboundGroupMessage,
	type InboundMeta,
	type InboundPrivateMessage,
	isExtensionEnabled,
	type Logger,
	type NotificationPayload,
	ok,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import { createKeyProvider, type SweepReport, sweepTempFiles } from "@bilibili-notify/storage";
import { type ServerType, serve } from "@hono/node-server";
import { createApp, createCardSkinStore, createStartupApp } from "./app.js";
import { shouldRefuseBareAuth } from "./auth/bare-auth-policy.js";
import { createSessionCodec } from "./auth/session.js";
import { createWsTicketStore } from "./auth/ws-ticket.js";
import { createBackupService } from "./backup/service.js";
import { type AuthSystem, createAuthSystem } from "./bilibili/auth/index.js";
import { readCardSkinAssetDataUrl } from "./card-skins/asset-url.js";
import { createCardSkinFallbackLog } from "./card-skins/fallbacks.js";
import type { CardSkinStore } from "./card-skins/store.js";
import { BUILTIN_INTEGRATION_SETTINGS, composeBuiltinIntegrations } from "./compose.js";
import { loadBootstrapConfig, resolveConfigPath } from "./config/loader.js";
import { type ChromeSource, persistChromeSource } from "./config/persist.js";
import { type ResolveWebDistDirInput, resolveWebDistDir } from "./config/web-dist.js";
import { createDevtools, overridableApi } from "./devtools/index.js";
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
import { createReportDiscrepancyTable } from "./extensions/report-discrepancies.js";
import { createExtensionUpgrades } from "./extensions/upgrade.js";
import { startHistoryRetention } from "./history/retention.js";
import { imageRefDataUrl } from "./images/image-data-url.js";
import { createImageFetcher } from "./images/image-fetcher.js";
import { startLogRetention } from "./logs/retention.js";
import { createLogSink } from "./logs/sink.js";
import {
	MASTER_TARGET_SKIPPED_PATH,
	MIGRATION_REVISION,
	migrateZeroGeneration,
	readZeroGenerationKey,
	type ZeroMigrationResult,
	zeroGenerationExists,
} from "./migration/zero-generation.js";
import { createSecretCellsReader } from "./push/connection-settings.js";
import { APP_VERSION, STARTED_AT } from "./routes/health.js";
import { createStatsOverview, roastOverviewFetcher } from "./routes/stats.js";
import { type AppRuntime, createAppRuntime } from "./runtime/bootstrap.js";
import {
	type CommandDef,
	command,
	createCommandDispatcher,
	effectiveAliases,
} from "./runtime/command-dispatcher.js";
import { renderHelp } from "./runtime/command-help.js";
import { createEngines } from "./runtime/engines.js";
import { isEntrypoint } from "./runtime/entrypoint.js";
import { startFansPoller } from "./runtime/fans-poller.js";
import {
	listGenerationUsage,
	removeGeneration,
	sweepGenerationLeftovers,
} from "./runtime/generation-usage.js";
import {
	copyKeyMaterial,
	createGeneration,
	FORMAT_VERSION,
	type GenerationSelection,
	markGenerationActive,
	selectGeneration,
	takePendingGeneration,
	writePendingGeneration,
} from "./runtime/generations.js";
import { createLinkParser } from "./runtime/link-parser.js";
import { createLinkReplySender } from "./runtime/link-reply.js";
import { bindLogLevels } from "./runtime/log-levels.js";
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
import { createStatusCommand, readSourceHealth } from "./runtime/status-command.js";
import { createStorageUsage } from "./runtime/storage-usage.js";
import { pruneOrphanSubRuntime } from "./runtime/sub-runtime-store.js";
import { bindSubscriptionStore } from "./runtime/subscription-store.js";
import { createSystemNoticeStore } from "./runtime/system-notices.js";
import { startStatsCompaction } from "./stats/compaction.js";
import { bindStatsLoginState } from "./stats/login-binding.js";
import { readFailedVersions } from "./update/select-version-for-boot.js";
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

/** 主人要求的新代没开成:原因记进原来那一代的提示清单,交回记下的原因。 */
async function recordGenerationFailure(
	dir: string,
	source: GenerationSourceKind,
	error: unknown,
): Promise<string> {
	const message = error instanceof Error ? error.message : String(error);
	await createSystemNoticeStore({ dir, runningVersion: APP_VERSION }).append({
		kind: "generation-failed",
		source,
		message,
	});
	return message;
}

/**
 * 开空的一代(新装、全新开始)。全新开始把主密钥从原来那一代带过去(不登出);没开成就接着用原来那一代、原因记进它的
 * 提示清单,不让整个开机失败。新装没有原来那一代,照旧抛。
 */
async function openEmptyGeneration(
	selection: Extract<GenerationSelection, { kind: "create" }>,
): Promise<{ generation: GenerationSelection; failure?: string }> {
	const { current } = selection;
	try {
		await createGeneration(selection, {
			formatVersion: FORMAT_VERSION,
			migrationRevision: MIGRATION_REVISION,
			createdBy: APP_VERSION,
			fill: async (partialDir) => {
				if (current) await copyKeyMaterial(current.dir, partialDir);
			},
		});
		return { generation: { kind: "use", seq: selection.seq, dir: selection.dir } };
	} catch (error) {
		if (!current) throw error;
		await markGenerationActive(current.dir);
		const failure = await recordGenerationFailure(current.dir, "empty", error);
		return { generation: { kind: "use", seq: current.seq, dir: current.dir }, failure };
	}
}

export async function startServer(options: StartServerOptions = {}): Promise<ServerHandle> {
	const env = options.env ?? process.env;
	const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
	const bootstrap = loadBootstrapConfig({ argv: options.argv, env });
	// 这时运行时还没建,宿主根就直接取配置键(建好之后一律读 `runtime.hostRoot`)。
	const hostRoot = bootstrap.dataDir;
	// 主人要求开的新代(全新开始 / 从旧代重新迁移,⑧):面板写下的一次性标记,取一次就删。
	const pending = await takePendingGeneration(hostRoot);
	// 选这次开机用哪一代(ADR-0022 决策 1–3),只读盘。宿主根上 0.x 的文件是第 0 代,一个字节都不动。
	const selection = await selectGeneration({
		hostRoot,
		formatVersion: FORMAT_VERSION,
		migrationRevision: MIGRATION_REVISION,
		zeroGenerationExists: await zeroGenerationExists(hostRoot),
		pending,
	});
	// 开机清扫:收掉上个进程被杀留下的临时文件与暂存目录。**必须赶在任何写入之前** —— 它认不出哪些
	// 临时文件是这个进程正在写的(Docker 里每次开机 pid 常常一样,靠不住),而存储与日志落盘都从
	// 下面的 createAppRuntime 起,所以放在它前面;logger 此刻还没有,结果先留着,等它起来再记一行。
	// 读不动 / 清不掉的地方清扫自己跳过、记进报告;万一它整个抛了也不挡开机:留下的只是些垃圾。
	// 整棵扫宿主根的 versions/ 和要用的那一代:第 0 代与别的旧代都是备份,内部不碰;要开的新代这时还不存在。
	// 另外只扫 generations/ 与宿主根「这一层」里删代删到一半的残骸(见 sweepGenerationLeftovers)。
	const bootSweep = await sweepBootRoots(
		[hostPath(hostRoot, "versions"), ...(selection.kind === "use" ? [selection.dir] : [])],
		hostRoot,
	).then(
		(report) => ({ report }) as const,
		(error: unknown) => ({ error }) as const,
	);
	// 用到已有的一代就记一笔最后使用时间(只给系统页显示)。排在清扫之后:原子写会先落临时文件。
	if (selection.kind === "use") await markGenerationActive(selection.dir);
	// 要求从第 0 代迁、第 0 代却已经不在了:选代当没要求,接着用原来那一代,告诉主人为什么。
	const declined =
		pending && selection.kind === "use"
			? await recordGenerationFailure(
					selection.dir,
					pending.kind,
					"第 0 代(0.x 的数据)已经不在了,没法从它重新迁移",
				)
			: undefined;
	// 空的一代(新装、全新开始)当场开:什么都不用搬,不必等到 listen 之后。
	const opened =
		selection.kind === "create" && selection.source.kind === "empty"
			? await openEmptyGeneration(selection)
			: { generation: selection };
	const generation: GenerationSelection = opened.generation;
	// 主人要求的新代没开成的原因(已经记进原来那一代的提示清单);logger 这会儿还没建,下面再记日志。
	const generationFailure = declined ?? opened.failure;
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
	let processHandlerCleanup: (() => void) | undefined;
	let shutdownPromise: Promise<void> | null = null;
	let listeningPort = bootstrap.server.port;

	runtime = createAppRuntime(
		bootstrap,
		{ dataRoot: generation.dir },
		{ integrationSettings: BUILTIN_INTEGRATION_SETTINGS },
	);
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

	// 当前跑的这份载荷的版本 —— 启动时算过一次的那个常量,别再向上找一遍 package.json。
	const payloadVersion = APP_VERSION;
	// 构建产物的入口恒为 `.mjs`;只有 tsx 直跑源码时才是 `.ts`。devtools 那道门与
	// 「能不能重启」是同一个事实,算一次两处用。
	const sourceRun = import.meta.url.endsWith(".ts");
	// 按下重启还回不回得来 —— 判的是外面有没有人拉,与「是不是开发版」不是一回事。
	const restartAbility = resolveRestartAbility({
		parentPid: env.BN_PARENT_PID,
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

	try {
		log.info(
			`starting bilibili-notify server: host=${bootstrap.server.host} port=${bootstrap.server.port} dataDir=${bootstrap.dataDir} logLevel=${bootstrap.logLevel}`,
		);
		log.info(
			generation.kind === "use"
				? `[data] 用第 ${generation.seq} 代:${generation.dir}`
				: `[data] 这次开机要从第 0 代迁出第 ${generation.seq} 代:${generation.dir}`,
		);
		if (generationFailure) {
			log.error(`[data] 主人要求开的新代没开成,接着用第 ${generation.seq} 代:${generationFailure}`);
		}
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
		// Authorization 头,改用 `POST /api/ws/ticket` 换短时 token,再用 `?ticket=`
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
		// material (the same key infra the integration stores use — passphrase-derived from
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
			try {
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
			} catch (error) {
				// 首次迁移(与开发期重迁)没有可退回的那一代,和别的开机失败一样抛出去。
				const { current } = generation;
				if (!current) throw error;
				// 主人要求的那一代没开成(⑧):原因记进原来那一代;正常退出,被拉起来时标记已经用掉、接着用原来那一代。
				// 抛出去的话 boot.mjs 会退回预装的那一版 —— 应用内升上来的桌面用户会被送回 0.x。没人拉的话只能抛。
				const message = await recordGenerationFailure(current.dir, generation.source.kind, error);
				log.error(
					`[data] 主人要求开的第 ${generation.seq} 代没开成,原来的第 ${current.seq} 代还在:${message}`,
				);
				if (!restartAbility.can) throw error;
				await stopAndExit("requested generation failed");
				throw error;
			}
			startupMessage = "BN 正在启动,稍等一下";
			log.info(
				`[data] 第 ${generation.seq} 代迁好了:搬了 ${report?.transfers.length ?? 0} 个文件,第 0 代原样留着当备份`,
			);
			if (report && report.skipped.length > 0) {
				log.info(
					`[data] 没带过来的:${report.skipped.map((s) => `${s.path}(${s.reason})`).join("、")}`,
				);
			}
			await createSystemNoticeStore({ dir: generation.dir, runningVersion: APP_VERSION }).append({
				kind: "migrated",
				cardSkinsDropped: report?.skipped.some((s) => s.path === "card-skins") ?? false,
				masterTargetCleared:
					report?.skipped.some((s) => s.path === MASTER_TARGET_SKIPPED_PATH) ?? false,
			});
		}

		// 开机之后要告诉主人的事(⑧)记在用着的那一代里。启动器判死过比我新的版本,各记一条「X 起不来」。
		const noticeStore = createSystemNoticeStore({
			dir: generation.dir,
			runningVersion: APP_VERSION,
		});
		await noticeStore.recordRollbacks(readFailedVersions(versionsRootIn(runtime.hostRoot)));

		// Load the at-rest secrets key during startup, not on the first settings write.
		// Without this eager touch, zero-auth local runs only hit the key lazily when
		// SecretStore.save() is first needed (e.g. changing a setting that holds a secret), making
		// the normal "主密钥加载成功" log look like it was caused by that setting.
		await runtime.keyProvider.getKey();
		// 运行记录从这一刻算起:数据那一代已经就位,引擎还没起(ADR-0022 决策 2 —— 建运行时那会儿不许碰盘)。
		runtime.uptimeRecorder.start();
		// Load on-disk runtime config (config/settings/core.json, config/subscriptions.json, config/targets.json).
		// Seeds defaults on first boot. Failure here is fatal — we don't want to start serving HTTP
		// against a corrupt or unreadable state dir.
		await runtime.configStore.load();
		// 日志等级表接到上下文上(当场推一次、之后 `level` / `levels` 变了再推):放在配置读完之后,
		// 之后造的日志器(登录系统、引擎装配)起步就是设置里那一格。
		const logLevels = bindLogLevels({
			serviceCtx: runtime.serviceCtx,
			configStore: runtime.configStore,
		});
		runtime.serviceCtx.onDispose(() => logLevels.dispose(), "stop");
		// Per-sub runtime data (cachedProfile / fansBaseline). Independent file,
		// absent / malformed → empty (non-fatal: it's a regenerable display cache).
		await runtime.subRuntimeStore.load();

		// Stage 2.4: assemble the auth stack (integration stores → Api → LoginFlow). Bus
		// emissions made by LoginFlow flow into the WS `auth` channel via stage 2.3 wiring.
		try {
			authSystem = await createAuthSystem({
				serviceCtx: runtime.serviceCtx,
				bus: runtime.bus,
				integrationStore: runtime.integrationStore,
				// 账号头像存进图库的口在运行时里;登录检查的间隔由 B 站来源读设置、经 `setHealthCheckMs` 挂上。
				accountImages: runtime.accountImages,
			});
		} catch (err) {
			// Fatal: without the integration stores / Api the dashboard can't function.
			log.error("auth system init failed", err);
			throw err;
		}
		runtime.serviceCtx.onDispose(() => authSystem?.dispose(), "stop");
		// 统计的「B 站在跑」= 登录有效:读口回填给记录器(它建在运行时里、比登录系统早;数据那一代已经就位,
		// 到这里才开始记,ADR-0022 决策 2 —— 建运行时那会儿不许碰盘)。每次现读状态,不靠事件记。
		// `confirming`(开机没确认、等手机确认)不算登录,与从前判「已登录」一致。
		bindStatsLoginState(runtime.statsRecorder, authSystem.auth);

		// Lazy puppeteer-core launch — only constructed when chromePath or a remote
		// chromeEndpoint is set. Browser spawns/connects on first use (cards/preview
		// OR engine card render), not at boot. Built before createEngines so live +
		// dynamic can share the same ImageRenderer instance as /api/cards/preview.
		const chromeIdleTimeoutMs =
			bootstrap.chromeIdleSeconds === undefined ? undefined : bootstrap.chromeIdleSeconds * 1000;
		// 启动实际生效的来源(endpoint 赢过 path),供 GET /api/cards/renderer 展示与同源幂等判断。
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
		//   2. The built-in platform adapters are constructed inside `composeBuiltinIntegrations`
		//      and registered (registration starts them) just before the engines
		//      (`builtins.registerAdapters`).
		//   3. createEngines() builds Dispatcher → PushRouter → LiveEngine and registers
		//      serviceCtx.onDispose for graceful shutdown; the built-in post source is registered
		//      right after it (`builtins.registerSources`).
		subBinding = bindSubscriptionStore({ bus: runtime.bus, configStore: runtime.configStore });
		runtime.serviceCtx.onDispose(() => subBinding?.dispose(), "stop");
		// Boot-time orphan sweep: drop sub-runtime entries whose subscription no
		// longer exists (deleted while the server was down). FansPoller's
		// subscription-changed listener handles deletions made while running.
		await pruneOrphanSubRuntime(runtime.subRuntimeStore, subBinding.store);
		// 拓展订阅的头像在图库里、资料缓存里放引用(ADR-0019 决策 49):资料条目丢了,头像就不再有人引用,
		// 由图库清扫收走,这里不用另外扫头像。头像不进备份(与资料缓存同一口径):恢复之后等拓展下一次报资料再来。
		// 入站的转发口。指令处理器要等 engines / 调度器建好才有,所以这里先留两个
		// 可后填的引用 —— adapter 建得比它们早。
		//
		// 两个 adapter 都在自己那层把帧归一化成平台中立的形状,汇合点是同一个。
		let onInboundPrivate: ((msg: InboundPrivateMessage, meta: InboundMeta) => void) | undefined;
		let onInboundGroup: ((msg: InboundGroupMessage, meta: InboundMeta) => void) | undefined;
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
		// 出口住在一张**活的注册表**里:内置这几个在 `createEngines` 之前登记(登记即 `start`,见下),
		// 拓展注册进来的后到、拨开关还会走(ADR-0012 决策 29)。消费方在分发那一刻问它要,不存快照。
		// 表在 `createAppRuntime` 里就建好了(配置仓保存连接时要按在场适配器的规则验 settings),这里只登记。
		const adapterRegistry = runtime.adapterRegistry;
		// 「连接配置动过了」的订阅:内置适配器与拓展装载器共用这一个。⛔ bus 不给它们:宿主替它们订,
		// 只把「动过了」这件事转过去。
		const onConnectionsChanged = (fn: () => void): Disposable =>
			runtime.bus.on("config-changed", ({ scope }) => {
				if (scope !== "connections") return;
				// 总线是普通的事件发射器:一个回调同步抛了,排在它后面的监听(引擎刷新链接策略那个)会被跳过。
				try {
					fn();
				} catch (err) {
					log.error(`连接变更的回调抛了: ${err instanceof Error ? err.message : String(err)}`);
				}
			});

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
			return chatIdentityOf(
				runtime.configStore.getTargets().find((x) => x.id === id),
				runtime.configStore.getConnections(),
			);
		};

		// devtools:门是载荷版本号(开发版才给,alpha 也不给)。给的话往下传的都是装饰过的:
		// 更新路由拿到的能被注入假状态,adapter 拿到的包着截流闸,api 套着 Proxy —— 真服务 /
		// 真 adapter / 真 api 一行不动。
		// `subBinding` 是个会在关停时清掉的 let,闭包里收不窄;先把 store 取出来。
		const subStore = subBinding.store;
		// 🚧 过渡接线:壳留在入口(核心 `devtools/index.js` 按 `devtools-isolation` 只许入口引;
		// 引擎、路由也要它们的 `.api`)。B 站那组场景要往引擎的 `api` 与路由的登录系统上盖方法,
		// 所以这两层 Proxy 在这里建,引擎与路由拿的是它们的 `.api`;生产里 `overridableApi` 是桩,
		// 原样透传。B 站那组场景的认领在 `compose.ts`。
		const devApi = overridableApi(authSystem.api);
		const devAuth = overridableApi(authSystem.auth);
		// B 站的作品图与直播封面(3a-34):出卡前经 B 站接口那个请求客户端(同一套 cookie 与身份)抓进图库,
		// 引用方是 `postImages` 这一家(名单恒空,靠新图的宽限期活到卡片画完)。引擎与链接预览共用这一个。
		// 建在 `compose.ts` 之前:来源要用它,依赖一次给齐(构造时不做任何事)。
		const postImageFetcher = createImageFetcher({
			http: authSystem.api.http,
			images: runtime.postImages,
		});
		const builtins = composeBuiltinIntegrations({
			api: devApi,
			auth: devAuth,
			integration: authSystem.integration,
			// 来源挂的是壳的 `.api`(登记表与 `/api/sources/:sourceKey/auth` 读到的就是它,开发场景才盖得到);
			// 统计与引擎装配读的是真对象。
			sourceAuth: devAuth.api,
			bus: runtime.bus,
			setHealthCheckMs: (ms) => authSystem?.setHealthCheckMs(ms),
			subscriptions: subStore,
			subscriptionRuntime: runtime.subRuntimeStore,
			imageFetcher: postImageFetcher,
			setTimeout: (fn, ms) => runtime.serviceCtx.setTimeout(fn, ms),
			// 大航海徽章图在 `compose.ts` 里造:登记进图库「来源声明的图」,造好当场交回运行时(引擎与卡片路由读它)。
			imageStore: runtime.imageStore,
			attachGuardIcons: (icons) => runtime.attachGuardIcons(icons),
			// 下面几样都是引擎建好之后才有的,现取 —— devtools 建得比引擎早。
			live: () => engines?.live,
			fans: () => runtime.fansPoller ?? undefined,
			// `authSystem` 是个会在关停时清掉的 let;这一刻它一定在(上面刚建的)。
			healthCheck: () =>
				authSystem && {
					healthCheckNow: () => authSystem?.healthCheckNow() ?? Promise.resolve(false),
				},
			// 三个内置适配器在 `compose.ts` 里造(核心只有它能 import `platforms/`)。入站出口是上面留好的
			// 可后填引用,现转。
			serviceCtx: runtime.serviceCtx,
			onInboundPrivate: (msg, meta) => onInboundPrivate?.(msg, meta),
			onInboundGroup: (msg, meta) => onInboundGroup?.(msg, meta),
			adapterRegistry,
			integrationStore: runtime.integrationStore,
			connections: () => runtime.configStore.getConnections(),
			onConnectionsChanged,
		});
		const devtools = createDevtools({
			// 过了 devtools 那道门才调:门没开,B 站的工厂一次都不会被调用(也就不会挂上直播连接的观察钩子)。
			// 构建时 `createBiliDevtools` 另有恒空的桩。
			provide: (devtoolsProviders) => builtins.provideDevtools(devtoolsProviders),
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
			// 下面几样都是引擎建好之后才有的,现取 —— devtools 建得比引擎早。
			inbound: () => ({ private: onInboundPrivate, group: onInboundGroup }),
			commands: () => ({
				prefix: runtime.configStore.getGlobals().commands.prefix,
				master: masterIdentity(),
			}),
			connectionConfigs: () => runtime.configStore.getConnections(),
			extensionSettings: (id) => runtime.configStore.getExtensionSettings(id),
			targets: () => runtime.configStore.getTargets(),
			bus: runtime.bus,
			puppeteer: () => puppeteer,
			mute: () => engines?.muteState,
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
		// 首个 `/api/cards/skins*` / 预览 / 工坊请求会在**请求路径上**把整个皮肤目录再读一遍。
		// 真正的代价不是那点 I/O:`init()` 开头一句 `index.clear()`,之后一串 await 才填满,
		// 而出图那头 `get(id)` 是**同步**读同一个实例的索引 —— 这个窗口里撞上一次推送就回落
		// 默认皮肤并记一笔 fallback(2026-09-19 审查)。
		cardSkinStore = createCardSkinStore(runtime.dataRoot);
		await cardSkinStore.ensureReady();
		for (const w of cardSkinStore.warnings()) log.warn(`[card-skin] ${w}`);
		const cardSkinFallbacks = createCardSkinFallbackLog({ logger: { warn: (m) => log.warn(m) } });
		const skins = cardSkinStore;

		// 拓展详情页的「上报出入」(ADR-0019 决策 60):ctx 那个出口与拓展直播的计时器(周期推送跳过的那一轮,
		// 决策 61)写进来,拓展列表那一口读出去。只在内存。记了新的 → bus → WS `state` 频道 → 面板让拓展表
		// 失效(按拓展合并过)。建在引擎之前:引擎里的计时器也往里记。
		const reportDiscrepancies = createReportDiscrepancyTable({
			onChanged: (id) =>
				runtime.bus.emit("extension-report-discrepancies-changed", { extensionId: id }),
		});
		runtime.serviceCtx.onDispose(() => reportDiscrepancies.dispose(), "stop");

		// 内置适配器登记即启动 —— 就在 `createEngines` 之前,启动时刻与从前引擎开机对账那一刻一致。
		// 关停钩子也登记在引擎之前:同一段里后登记的先跑,引擎先收、适配器后停。
		const builtinAdapters = await builtins.registerAdapters();
		runtime.serviceCtx.onDispose(() => builtinAdapters.dispose(), "stop");

		engines = createEngines({
			serviceCtx: runtime.serviceCtx,
			dataRoot: runtime.dataRoot,
			// 全进程唯一那个字体读取口 —— 预览路由经 RouteDeps.runtime 取的是同一个。
			loadFontFace: runtime.loadFontFace,
			api: devApi.api,
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
			// 叫法、声明的事件。同上,装载器晚一步建起来,所以都现取。
			extensionSources: {
				running: (id) =>
					loadedExtensions?.list().some((one) => one.id === id && one.state === "running") ?? false,
				postNoun: (id) => {
					const entry = loadedExtensions?.list().find((one) => one.id === id);
					return entry?.manifest && manifestSubscriptionView(entry.manifest)?.display.postNoun;
				},
				events: (id) => {
					const entry = loadedExtensions?.list().find((one) => one.id === id);
					return entry?.manifest && manifestSubscriptionView(entry.manifest)?.events;
				},
			},
			// 拓展作品卡是 `Post`(㉑d):配图 / 封面 / 事件带来的头像经 `postImages` 存进图库,出图器出卡前
			// 经 `resolveImageRef` 把引用换成 data URL。两头缺一头,症状都是作品卡上一张图都没有。
			postImages: runtime.postImages,
			// 拓展直播卡同理(㉒c):封面与事件头像经 `liveImages` 存进图库,出图器经同一个 `resolveImageRef` 取回。
			liveImages: runtime.liveImages,
			// 大航海徽章图标(3a-33):开机抓、上舰卡按档取;引用方「来源声明的图」在 bootstrap 里登记。
			guardIcons: runtime.guardIcons,
			imageFetcher: postImageFetcher,
			resolveImageRef: imageRefDataUrl(runtime.imageStore),
			// AI 点评看只有图库引用的图(拓展作品)时核心要量字节数,读口回字节与类型。
			readImage: (ref) => runtime.imageStore.read(ref),
			// 拓展直播的最新状态与女仆查直播状态(ADR-0019 决策 57 / 64)都从在播表取。
			extensionLive: runtime.extensionLive,
			onReportDiscrepancy: (discrepancy) => reportDiscrepancies.record(discrepancy),
			auth: authSystem.auth,
			configStore: runtime.configStore,
			historyStore: runtime.historyStore,
			subscriptionStore: subBinding.store,
			subRuntimeStore: runtime.subRuntimeStore,
			bus: runtime.bus,
			adapters,
			// 开发版的推送截流接在派发器调适配器那一处;生产 `devtools` 是 null,不传。
			interceptSend: devtools?.interceptSend,
			puppeteer,
			cardSkins: {
				get: (id) => skins.get(id) ?? undefined,
				asset: (skinId, name) => readCardSkinAssetDataUrl(skins, skinId, name),
				onFallback: (info) => cardSkinFallbacks.record(info),
			},
			sources: runtime.sourceRegistry,
			problems: runtime.problems,
			// 直播引擎由 createEngines 造、早于来源登记:B 站的分层上报器只能经入口递进去(3b 直播并进来源时撤掉)。
			biliProblems: builtins.bilibili.problems,
		});
		// 内置来源(B 站)由 `compose.ts` 造并登记,登记即 start;关停时引擎自己先停它再关作品入口。
		await builtins.registerSources(engines);
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
			memoryLogEnabled: () => runtime.configStore.getGlobals().logging.memoryLog.enabled,
			probes: [
				() => {
					const s = engines?.live.danmakuStats();
					return s ? `弹幕 ${s.rooms} 房/${s.words} 词/${s.senders} 人` : "";
				},
			],
		});

		// 孤儿自检:只有桌面版 launcher 会传 BN_PARENT_PID,Docker / 直接跑都不受影响。
		// launcher 被强杀时不会带走我们,不自己盯着就会变成占着数据目录的孤儿。
		const expectedParent = resolveExpectedParent(env.BN_PARENT_PID);
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
			images: runtime.imageStore,
			logger: log,
		});

		// 统计的压缩(粉丝样本与「在记」的账):开机一次、之后每 6 小时一次(ADR-0027 决策 15)。数据那一代已就位才到这里,
		// 与上面的历史保留是各自的活。
		startStatsCompaction({
			serviceCtx: runtime.serviceCtx,
			store: runtime.fansStore,
			recorder: runtime.statsRecorder,
			logger: log,
		});

		// Daily retention pass for the log archive (globals.logging.retentionDays).
		startLogRetention({
			serviceCtx: runtime.serviceCtx,
			store: runtime.configStore,
			hostRoot: runtime.hostRoot,
			logger: log,
		});

		// 启动 FansPoller — cron 跟 globals.profileRefreshCron,每个 enabled sub
		// 拉一次 B 站 fans 数,写时序 jsonl + emit `fans-refreshed`。
		const fansPoller = startFansPoller({
			bus: runtime.bus,
			logger: log,
			configStore: runtime.configStore,
			subscriptionStore: subBinding.store,
			subRuntimeStore: runtime.subRuntimeStore,
			fansStore: runtime.fansStore,
			api: authSystem.api,
			// B 站订阅的头像抓进图库(3a-35):首见种资料与开机冷刷用,引用方是订阅资料这一家。
			images: createImageFetcher({ http: authSystem.api.http, images: runtime.profileImages }),
			serviceCtx: runtime.serviceCtx,
			isStatsEnabled: runtime.isStatsEnabled,
		});
		runtime.attachFansPoller(fansPoller);
		runtime.serviceCtx.onDispose(() => fansPoller.dispose(), "stop");

		// ── 定时锐评 ──────────────────────────────────────────────────────────
		// 草稿库 → 调度器 → 审批指令,按依赖顺序建;取数与主人私聊两个口子是回填的
		// (engines 上面刚建好,统计的取数函数在下面先建、交给 createApp 共用)。
		const roastDrafts = createRoastDraftStore({ dataRoot: runtime.dataRoot, logger: log });
		await roastDrafts.load();
		runtime.serviceCtx.onDispose(() => roastDrafts.close(), "flush");

		// 取数函数只建一个,同时交给调度器与 createApp:手动锐评、面板、定时锐评三处吃同一份 30 秒缓存。
		const statsOverview = createStatsOverview({ runtime, store: runtime.configStore });
		/** 服务端主动私聊主人(定时锐评、过期提醒)。发不出去由调用方各自兜住(不让它拖垮流程)。 */
		const tellMasterPayload = async (payload: string | NotificationPayload): Promise<void> => {
			const r = await engines?.push.notifyMaster(payload);
			if (r && !r.ok) log.warn(`[master] 通知主人没送到: ${r.message}`);
		};
		// 审批预览要发的是渲染好的那一份(出图就发图),所以另有 payload 版;文字版只是它的字符串入参。
		const tellMaster = (text: string): Promise<void> => tellMasterPayload(text);

		const roastScheduler = createRoastScheduler({
			deps: { runtime, store: runtime.configStore },
			drafts: roastDrafts,
			logger: log,
			// 与手动锐评**同一个取数函数**(同一份缓存),直接调用。
			fetchOverview: roastOverviewFetcher(statsOverview, { runtime }),
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
		});

		// 自引用:帮助要列出「包括它自己在内」的全部指令,所以先建表再往里塞。
		//
		// **所有 push 必须排在下面 createCommandDispatcher 之前** —— 它在构造时就把
		// 指令表编译好(解析签名、排触发词)。之后再 push 的指令会出现在帮助里,
		// 却永远不响应,而帮助里看得见恰恰让人不往这上面想。
		const commands: CommandDef[] = [];
		commands.push(
			command({
				name: "help",
				aliases: ["帮助", "?"],
				signature: "[name:string|指令名]",
				description: "看看能敲哪些指令",
				example: "mute",
				// values.name 由签名推出来,是 string | undefined —— 不用断言、不用 typeof。
				// 报错里显示的是「指令名」那个显示名,不是 name。
				run: async (values, { reply }) => {
					// 前缀与别名都**现读**:主人改完前缀,帮助恰恰是他第一个会看的东西,
					// 而列出一批已经被他改掉的别名等于教他敲没反应的词。
					const cfg = runtime.configStore.getGlobals().commands;
					const entries = commands.map((c) => ({
						...c,
						aliases: effectiveAliases(c, cfg.aliases),
					}));
					await reply(renderHelp(entries, cfg.prefix, values.name));
					// 查不到的指令名也是正常的回答(`renderHelp` 指路),不算办不成。
					return ok();
				},
			}),
		);
		// 静音的闸装在 push 里(见 engines.ts),这里只是改状态的入口。
		commands.push(createMuteCommand({ muteState: engines.muteState }));
		commands.push(
			createStatusCommand({
				probe: () => ({
					// 登录态交中立的 `AuthState`,一行人话由 `status` 指令按状态拼(`renderStatus`)。
					login: authSystem?.auth.state(),
					sources: readSourceHealth(runtime.sourceRegistry.list(), log),
					// 没装 Chrome 就没有渲染队列。
					renderQueue: puppeteer?.renderQueueDepth() ?? 0,
					connections: runtime.configStore
						.getConnections()
						.filter((a) => a.enabled)
						// **没探测过 / 探不了 ≠ 断了**。webhook 这类平台压根不支持探测,probeState 是
						// 没有或 `unsupported`;当成断线的话主人会永远看见一条假报警。
						.map((a) => ({ name: a.name, ok: a.probeState?.status !== "unreachable" })),
					mutedUntil: engines?.muteState.mutedUntil() ?? 0,
				}),
			}),
		);
		commands.push(
			createReportCommand({
				logger: log,
				// 审批开着时,草稿连同「回复 y <id>」由调度器自己私聊出去,指令层不再补一句。
				run: (days) => roastScheduler.runBoardOnce(days),
			}),
		);
		commands.push(
			createLoginCommand({
				logger: log,
				begin: async () => authSystem?.auth.beginLogin() ?? fail("unavailable", "登录系统还没起来"),
				state: () => authSystem?.auth.state() ?? { status: "logged-out" },
			}),
		);

		// `engines` 是个会被热重载赋值的 let,闭包里 TS 收不窄;这一刻它一定在(上面刚建的)。
		const runtimeEngines = engines;
		const commandDispatcher = createCommandDispatcher({
			logger: log,
			masterIdentity,
			// 指令的回话回到发指令的那个私聊(来的那条连接 + 发信人),不是主人目标那条。
			sendToAddress: (connectionId, session, payload) =>
				runtimeEngines.sendToAddress(connectionId, session, payload),
			config: () => runtime.configStore.getGlobals().commands,
			commands,
			// 审批的 y/n 作为第二道门 —— 有待审草稿时才认,没有时它只是个普通字母。
			confirmation: roastCommands.confirmation,
		});

		// 群里贴视频链接 → 回一张卡。回到来源群不走推送目标表:用收到这条消息的那条连接
		// 经派发器的 `sendToAddress` 直接发(群不必配成推送目标,主人定的:机器人在的所有群都算)。
		const linkParser = createLinkParser({
			logger: log,
			// 开关与呈现都从引擎拿:随 config-changed 刷新的快照,呈现规则与推送的动态卡同源。
			config: () => runtimeEngines.linkParsing(),
			policyFor: (key) => runtimeEngines.linkPolicyFor(key),
			api: runtimeEngines.api,
			// 图片卡的视频封面出卡前抓进图库(与推送的动态卡同一个抓图服务)。
			imageFetcher: postImageFetcher,
			renderer: () => runtimeEngines.imageRenderer,
			presentation: () => runtimeEngines.linkCardPresentation(),
			// 能力走 dispatcher 那条连接寻址(健康探测与 /api/connections/capabilities 用的是同一份),
			// 别在接线层再手写一条 —— 两条路会各自漂。
			capabilities: ({ connectionId }) => runtimeEngines.connectionCapabilities(connectionId),
			probeCapabilities: ({ connectionId }) =>
				runtimeEngines.probeConnectionCapabilities(connectionId),
			send: createLinkReplySender(runtimeEngines),
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
		// 连接 settings 里哪些格是密钥:适配器 schema 上的标记 + 拓展声明的键。下发打码与备份脱敏吃同一份。
		// 拓展的声明**现取** —— 拓展会被拨开关加载 / 卸载,而备份服务比装载早一步建起来;表里没有 = 问不出来
		// (一个都没跑起来时每条拓展连接的 settings 整片当密钥)。
		const connectionSecrets = createSecretCellsReader(adapterRegistry, (adapterKey) =>
			loadedExtensions?.secretConfigCodes().get(adapterKey),
		);
		const backupService = authSystem
			? createBackupService({
					configStore: runtime.configStore,
					integrationSecrets: runtime.integrationStore,
					connectionSecrets,
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
			// 每个拓展的日志:标签是它的 id、等级跟设置里 `logging.levels.<id>` 那一格(没写跟总等级)。
			loggerOf: (id) => runtime.serviceCtx.forSubsystem(id, id).logger,
			// 每个拓展装载前按 id 开自己的 state / secrets 存储,收摊后关。
			integrationStore: runtime.integrationStore,
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
			onConnectionsChanged,
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
			onReportDiscrepancy: (discrepancy) => reportDiscrepancies.record(discrepancy),
			// 拓展自己那份设置住它自己的文件(`config/settings/extensions/<id>.json`);是不是自己这一份动了由 ctx
			// 比内容判 —— 改动那一档(`integration-settings`)是各集成共用的。
			settings: (id) => runtime.configStore.getExtensionSettings(id),
			// 设置文件不是合法 JSON 的拓展只停它自己;原因在仓里,重存才清。
			settingsIssue: (id) => runtime.configStore.extensionSettingsIssue(id),
			onSettingsChanged: (fn) =>
				runtime.bus.on("config-changed", ({ scope }) => {
					if (scope === "integration-settings") fn();
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

		// 旧版本数据的列表 / 删除与存储占用里「旧版本数据」那一行共用这份参数。
		const generationUsage = {
			hostRoot: runtime.hostRoot,
			currentSeq: generation.seq,
			formatVersion: FORMAT_VERSION,
			now: () => Date.now(),
		};
		const app = createApp(runtime, {
			...appShell,
			// 显式给一份:`authSystem.api` 是数据属性,取出来的是没装饰过的那个,卡片预览
			// 就会绕过 devtools 的 api 覆盖(假直播时预览渲染的还是真房间)。
			api: devApi.api,
			backupService,
			connectionSecrets,
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
			extensions: {
				mounts: extensionMounts,
				loaded: () => loadedExtensions?.list() ?? [],
				status: (id) => loadedExtensions?.status(id),
				bots: (id) => loadedExtensions?.bots(id),
				runAction: async (id, name) => loadedExtensions?.runAction(id, name),
				// 新建订阅时的解析门(ADR-0019 决策 52):没在跑 / 不是订阅源时装载器回 undefined → 404。
				lookup: async (id, query) => loadedExtensions?.lookup(id, query),
				// 跑着的那份交过的 zod —— 写设置时再过一道(ADR-0019 决策 35)。
				settingsSchemas: (id) => loadedExtensions?.settingsSchemas(id),
				// 列表那一行带上它的「上报出入」,卸载时清掉那一段(决策 60)。
				reportDiscrepancies,
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
					// 卸载时连它存的状态与密钥一起清。
					integrationStore: runtime.integrationStore,
					changeDisk: (write) => (loadedExtensions ? loadedExtensions.changeDisk(write) : write()),
					restartAbility,
				},
				// devtools 给的话是装饰过的那份:「拓展有更新」在它身上造(见 devtools/marketplace-injection.ts)。
				marketplace: devtools?.marketplace ?? marketplace,
			},
			// 注册表交给路由:别名冲突检查与 `GET /api/commands` 都照它来,
			// 面板上那张指令卡片不必再手写一份清单。
			commands,
			statsOverview,
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
				notices: noticeStore,
				requestGeneration: (source) => writePendingGeneration(runtime.hostRoot, { kind: source }),
				zeroGenerationExists: () => zeroGenerationExists(runtime.hostRoot),
				// 旧版本数据的列表与删除(㉙c):能不能删由 generation-usage 判,删的活登记进 track(关停等它)。
				generations: {
					list: () => listGenerationUsage(generationUsage),
					remove: (seq: number) =>
						removeGeneration(
							{ ...generationUsage, track: (task) => runtime.serviceCtx.track(task) },
							seq,
						),
				},
				// 存储占用(㉙d):用量表、四类整类清空、手动清一次图库。每类删什么、经哪条写队在 storage-usage;
				// 清理与清扫登记进 track(关停等它)。粉丝轮询开机之后才有,所以现取。
				storage: createStorageUsage({
					dataRoot: runtime.dataRoot,
					hostRoot: runtime.hostRoot,
					imageStore: runtime.imageStore,
					listGenerations: () => listGenerationUsage(generationUsage),
					statsRecorder: runtime.statsRecorder,
					subRuntime: runtime.subRuntimeStore,
					fansPoller: () => runtime.fansPoller,
					invalidateStatsOverview: () => statsOverview.invalidate(),
					historyStore: runtime.historyStore,
					conversationStore: runtime.conversationStore,
					logger: log,
					now: () => new Date(),
					track: (task) => runtime.serviceCtx.track(task),
				}),
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
async function sweepBootRoots(roots: readonly string[], hostRoot: string): Promise<SweepReport> {
	const merged: SweepReport = { removed: [], restored: [], skipped: [] };
	const reports: SweepReport[] = [];
	for (const root of roots) reports.push(await sweepTempFiles(root));
	reports.push(await sweepGenerationLeftovers(hostRoot));
	for (const report of reports) {
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
