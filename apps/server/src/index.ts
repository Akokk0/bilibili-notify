import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StatsOverviewResponse } from "@bilibili-notify/contract";
import {
	chatIdentityOf,
	type InboundGroupMessage,
	type InboundMeta,
	type InboundPrivateMessage,
	isExtensionEnabled,
	type NotificationPayload,
} from "@bilibili-notify/internal";
import { type ServerType, serve } from "@hono/node-server";
import type { Hono } from "hono";
import { createApp } from "./app.js";
import { shouldRefuseBareAuth } from "./auth/bare-auth-policy.js";
import { type AuthSystem, createAuthSystem } from "./auth/index.js";
import { createSessionCodec } from "./auth/session.js";
import { createWsTicketStore } from "./auth/ws-ticket.js";
import { createBackupService } from "./backup/service.js";
import { loadBootstrapConfig, resolveConfigPath } from "./config/loader.js";
import { type ChromeSource, persistChromeSource } from "./config/persist.js";
import { type ResolveWebDistDirInput, resolveWebDistDir } from "./config/web-dist.js";
import { createDevtools } from "./devtools/index.js";
import { extensionsRootIn } from "./extensions/discover.js";
import {
	EXTENSION_MAX_LOAD_FAILURES,
	type LoadedExtensions,
	loadExtensions,
} from "./extensions/loader.js";
import { createExtensionMounts } from "./extensions/mount.js";
import { createExtensionUpgrades } from "./extensions/upgrade.js";
import { startHistoryRetention } from "./history/retention.js";
import { startLogRetention } from "./logs/retention.js";
import { createLogSink } from "./logs/sink.js";
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
import { createLinkParser } from "./runtime/link-parser.js";
import { createLoginCommand } from "./runtime/login-command.js";
import { createMuteCommand } from "./runtime/mute-command.js";
import { resolveExpectedParent, startParentWatch } from "./runtime/parent-watch.js";
import { browserSubtreeRss } from "./runtime/process-tree.js";
import { createPuppeteerAdapter, type StandalonePuppeteer } from "./runtime/puppeteer.js";
import { createReportCommand } from "./runtime/report-command.js";
import { type ResourceMonitor, startResourceMonitor } from "./runtime/resource-monitor.js";
import { resolveRestartAbility, runningInContainer } from "./runtime/restart-ability.js";
import { createRoastCommandHandler } from "./runtime/roast-command.js";
import { createRoastDraftStore } from "./runtime/roast-draft-store.js";
import { createRoastScheduler } from "./runtime/roast-scheduler.js";
import { createStatusCommand } from "./runtime/status-command.js";
import { bindSubscriptionStore } from "./runtime/subscription-store.js";
import { createUpdateService } from "./update/service.js";
import {
	RELEASES_PAGE_URL,
	TRUSTED_UPDATE_KEYS,
	UPDATE_MANIFEST_URLS,
} from "./update/trusted-keys.js";
import { versionsRootIn } from "./update/versions-root.js";
import { createWsServer } from "./ws/server.js";
import type { LogEntry } from "./ws/types.js";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export interface StandaloneServerHandle {
	readonly host: string;
	readonly port: number;
	readonly url: string;
	close(reason?: string): Promise<void>;
}

export interface StartStandaloneServerOptions {
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

export async function startStandaloneServer(
	options: StartStandaloneServerOptions = {},
): Promise<StandaloneServerHandle> {
	const env = options.env ?? process.env;
	const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
	const bootstrap = loadBootstrapConfig({ argv: options.argv, env });
	let runtime: AppRuntime | undefined;
	let authSystem: AuthSystem | undefined;
	let puppeteer: StandalonePuppeteer | null = null;
	let subBinding: ReturnType<typeof bindSubscriptionStore> | undefined;
	let engines: ReturnType<typeof createEngines> | undefined;
	let wsTicketStore: ReturnType<typeof createWsTicketStore> | null | undefined;
	let server: ServerType | undefined;
	let wsServer: ReturnType<typeof createWsServer> | undefined;
	let resourceMonitor: ResourceMonitor | undefined;
	let loadedExtensions: LoadedExtensions | undefined;
	let previousLogHook: ((entry: LogEntry) => void) | undefined;
	// QQ 官方机器人网关捞到的群/C2C openid 落进这张共享发现表(不落盘),既喂 adapter
	// 也喂 /api/qq/sessions 路由的面板选择器。一个进程一份。
	const qqSessionRegistry = createQQSessionRegistry();
	let processHandlerCleanup: (() => void) | undefined;
	let shutdownPromise: Promise<void> | null = null;
	let listeningPort = bootstrap.server.port;

	runtime = createAppRuntime(bootstrap);
	const log = runtime.serviceCtx.logger;

	const close = async (reason = "shutdown"): Promise<void> => {
		if (shutdownPromise) return shutdownPromise;
		shutdownPromise = (async () => {
			log.info(`received ${reason}, shutting down…`);
			try {
				processHandlerCleanup?.();
				processHandlerCleanup = undefined;
				runtime?.serviceCtx.setLogHook(previousLogHook);
				wsServer?.dispose();
				// 拓展先收:它注册的定时器 / 端点都挂在自己那面 ctx 上,收在核心之前
				// 才不会在核心已经拆了之后还被回调进去。
				await loadedExtensions?.dispose();
				wsTicketStore?.dispose();
				subBinding?.dispose();
				engines?.dispose();
				if (puppeteer) await puppeteer.dispose();
				authSystem?.dispose();
				await closeHttpServer(server, shutdownTimeoutMs, (msg) => log.warn(msg));
				await runtime?.dispose();
			} catch (err) {
				log.error("error during shutdown", err);
				throw err;
			}
		})();
		return shutdownPromise;
	};

	try {
		log.info(
			`starting bilibili-notify standalone server: host=${bootstrap.server.host} port=${bootstrap.server.port} dataDir=${bootstrap.dataDir} logLevel=${bootstrap.logLevel}`,
		);

		// Load the at-rest secrets key during startup, not on the first settings write.
		// Without this eager touch, zero-auth local runs only hit the key lazily when
		// SecretStore.save() is first needed (e.g. changing rules.restartPush), making
		// the normal "主密钥加载成功" log look like it was caused by that setting.
		await runtime.keyProvider.getKey();

		// Load on-disk runtime config (state/globals.json, state/subscriptions.json, state/targets.json).
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
		// Boot-time orphan sweep: drop sub-runtime entries whose subscription no
		// longer exists (deleted while the server was down). FansPoller's
		// subscription-changed listener handles deletions made while running.
		await runtime.subRuntimeStore.prune(subBinding.store.list().map((s) => s.id));
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
				// close() 是 rethrow 的。停机里某一处 dispose 抛了也得退 0:这时进程反正
				// 要没了,非 0 只会让编排系统当成崩溃去退避重启。
				log.error(
					`${reason}: graceful close failed, exiting anyway: ${err instanceof Error ? err.message : String(err)}`,
				);
			} finally {
				process.exit(0);
			}
		};
		const updateService = createUpdateService({
			currentVersion: payloadVersion,
			// boot.mjs 在加载这份载荷之前摆进来的(见 src/boot.ts)。直接跑
			// index.mjs 时(dev / 老镜像)拿不到 —— 那就当自己就是地板,
			// 「没得退」,而不是瞎猜一个版本号。
			imageVersion: normalizeOptionalEnv(env.BN_IMAGE_VERSION) ?? payloadVersion,
			// 和 boot.mjs 那侧(update/versions-root.ts)算的是同一个目录 —— 这段路径
			// 只写一处,写岔了两边都不报错,症状是「升完了重启还是旧版本」。
			versionsRoot: versionsRootIn(bootstrap.dataDir),
			nodeMajor: Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10),
			trustedKeys: TRUSTED_UPDATE_KEYS,
			manifestUrls: UPDATE_MANIFEST_URLS,
			releasesPageUrl: RELEASES_PAGE_URL,
			// 每次现读:用户在面板上改完渠道 / 加速前缀,下一次检查就该按新的来。
			readSettings: () => runtime.configStore.getGlobals().update,
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
			adapters: adapterRegistry,
			// 开发版装拓展那条路(见 devtools/scenarios/extensions.ts)。仓里那个目录只在
			// 源码运行时够得着,而 devtools 本来就只在那种构建里存在 —— 两道门是同一道。
			extensions: {
				repoDir: resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "extensions"),
				installRoot: extensionsRootIn(bootstrap.dataDir),
				loaded: () => loadedExtensions,
			},
			// 「假装一条桥连上来」要连回自己身上。走 127.0.0.1 而不是 bootstrap 里那个 host:
			// 那格常是 `0.0.0.0`(监听通配),拿它当目的地连不上。
			address: () => (listeningPort ? `127.0.0.1:${listeningPort}` : undefined),
			historyStore: runtime.historyStore,
			api: authSystem.api,
			// 场景挑订阅:配置里的订阅 + 运行时解析出的房号(与 room-session 拿的是同一份)。
			subs: () =>
				subStore.list().map((sub) => ({
					id: sub.id,
					uid: sub.uid,
					name: sub.name ?? runtime.subRuntimeStore.get(sub.id)?.cachedProfile?.name ?? sub.uid,
					enabled: sub.enabled,
					roomId: runtime.subRuntimeStore.get(sub.id)?.roomId,
					specialUsers: sub.specialUsers.map((u) => u.uid),
					avatar: runtime.subRuntimeStore.get(sub.id)?.cachedProfile?.avatar,
				})),
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
		engines = createEngines({
			serviceCtx: runtime.serviceCtx,
			// 全进程唯一那个字体读取口 —— 预览路由经 RouteDeps.runtime 取的是同一个。
			loadFontFace: runtime.loadFontFace,
			api: devtools?.api ?? authSystem.api,
			quietHoursNow: devtools?.quietHoursNow,
			loginFlow: authSystem.flow,
			configStore: runtime.configStore,
			historyStore: runtime.historyStore,
			subscriptionStore: subBinding.store,
			subRuntimeStore: runtime.subRuntimeStore,
			bus: runtime.bus,
			adapters,
			puppeteer,
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
			logger: log,
		});

		// Daily retention pass for the log archive (globals.app.logRetentionDays).
		startLogRetention({
			serviceCtx: runtime.serviceCtx,
			store: runtime.configStore,
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
		runtime.serviceCtx.onDispose(() => fansPoller.dispose());

		// ── 定时锐评 ──────────────────────────────────────────────────────────
		// 草稿库 → 调度器 → 审批指令,按依赖顺序建;取数与主人私聊两个口子是回填的
		// (statsRoute 要等 createApp,engines 上面刚建好)。
		const roastDrafts = createRoastDraftStore({ dataDir: bootstrap.dataDir, logger: log });
		await roastDrafts.load();

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
		onInboundPrivate = (msg, meta) => void commandDispatcher.handleMessage(msg, meta);
		onInboundGroup = (msg, meta) =>
			void linkParser.handleMessage({
				...msg,
				platform: meta.platform,
				connectionId: meta.connectionId,
			});

		roastScheduler.start();
		runtime.bus.on("config-changed", (scope) => {
			// 全局那条(roastSchedule)与 per-UP 那些(subscriptions)各自都可能增删改。
			if (scope === "globals" || scope === "subscriptions") roastScheduler.reconcile();
			// 别名进了触发词表,得重建;前缀与总开关是现读的,不用管。
			// reconcile 自己吞异常 —— 这里是总线回调,抛出去会被 unhandledRejection
			// 处理器变成一次进程退出。
			if (scope === "globals") commandDispatcher.reconcile();
		});
		runtime.serviceCtx.onDispose(() => roastScheduler.stop());

		// 过期草稿:每小时清一轮,清掉的**告诉主人一声**。悄悄消失的话他只会以为
		// 这期又没发 —— 那正是这个功能要消除的沉默。
		runtime.serviceCtx.setInterval(
			() => {
				void roastDrafts
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
					});
			},
			60 * 60 * 1000,
		);

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

		// Dashboard session codec. Signing key = HKDF over the runtime's stable key
		// material (the same key infra StorageManager uses — passphrase-derived from
		// BN_COOKIE_KEY when set, else the persisted random master.key), so cookies
		// survive a restart without a new required config knob. Built only when auth
		// is configured; the credential fingerprint is folded into the HKDF salt so
		// rotating the dashboard password invalidates every old cookie.
		const sessionCodec = basicAuthCredentials
			? createSessionCodec({
					keyMaterial: await runtime.keyProvider.getKey(),
					creds: basicAuthCredentials,
				})
			: undefined;

		// 运行时 chromePath 写回目标:仅 B 模型(显式 BN_CONFIG)有单一可写文件;
		// legacy/disabled 返回 null → 热启用仍生效但不持久化(改配置走 env / 手编辑)。
		const configPath = resolveConfigPath({ env });
		const backupService = authSystem
			? createBackupService({
					configStore: runtime.configStore,
					cookieStore: authSystem.storage.cookieStore,
					onCookiesRestored: () => authSystem?.reloadCookiesFromStore(),
					// 拓展声明成密钥的 config 键。**现取** —— 拓展会被拨开关加载 / 卸载,
					// 而且备份服务比装载早一步建起来。
					extraSecretKeys: () => loadedExtensions?.secretConfigCodes() ?? [],
				})
			: undefined;

		// 拓展装载。**在 createApp 之前**:总入口要随 app 一起挂上,而拓展在 `activate`
		// 里注册的路由是往那张活表里写的,先后都行 —— 但名单要在路由建起来时就拿得到。
		const extensionMounts = createExtensionMounts();
		const extensionUpgrades = createExtensionUpgrades();
		loadedExtensions = await loadExtensions({
			// **一个根**:拓展是装进来的(市场下载 / 主人手放 / 开发版由 devtools 链进来),
			// 本体一个都不带。见 `extensions/discover.ts` 文件头。
			root: extensionsRootIn(bootstrap.dataDir),
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
			// ⛔ bus 不给拓展:宿主替它订,只把「动过了」这件事转过去。
			onConnectionsChanged: (fn) =>
				runtime.bus.on("config-changed", (scope) => {
					if (scope === "connections") fn();
				}),
			// 拓展自己那份设置住 globals;是不是自己这一格动了由 ctx 比内容判。
			settings: (id) => runtime.configStore.getGlobals().extensions[id]?.settings,
			onSettingsChanged: (fn) =>
				runtime.bus.on("config-changed", (scope) => {
					if (scope === "globals") fn();
				}),
			// 拓展喊「面板数据变了」→ bus → WS `state` 频道 → 面板按 id 失效缓存(不用切页)。
			onStatusChanged: (id) => runtime.bus.emit("extension-status-changed", id),
			inbound: {
				onInboundPrivate: (msg, meta) => onInboundPrivate?.(msg, meta),
				onInboundGroup: (msg, meta) => onInboundGroup?.(msg, meta),
			},
			upgrades: extensionUpgrades,
		});
		for (const entry of loadedExtensions.list()) {
			if (entry.state === "running")
				// 软链那份把落点也印出来:开发版跑的其实是仓里的工作树,日志里看不出来的话
				// 「我改的那个到底跑没跑」还得再查一遍。
				log.info(`[ext] ${entry.id} 已加载${entry.linkedTo ? `(→ ${entry.linkedTo})` : ""}`);
			else if (entry.state !== "disabled")
				log.warn(
					`[ext] ${entry.id} 没加载(${entry.state})${entry.detail ? `:${entry.detail}` : ""}`,
				);
		}

		// 拨开关即热装卸(决策 10)。`sync()` 自己吞异常、自己排队,这里只负责把「全局配置
		// 动过了」转过去 —— 它认的是开关**变没变**,别的全局设置存一百次也不会惊动拓展。
		const extensions = loadedExtensions;
		runtime.bus.on("config-changed", (scope) => {
			if (scope === "globals") void extensions.sync();
		});

		const app = createApp(runtime, {
			// devtools 给的话是套了 Proxy 的那份:`status()` 可注入假登录态,别的原样。
			authSystem: devtools?.authSystem ?? authSystem,
			// 显式给一份:`authSystem.api` 是数据属性,取出来的是没装饰过的那个,卡片预览
			// 就会绕过 devtools 的 api 覆盖(假直播时预览渲染的还是真房间)。
			api: devtools?.api ?? authSystem.api,
			backupService,
			basicAuthCredentials,
			sessionCodec,
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
			staticDir: effectiveWebDistDir,
			wsTicketStore,
			allowedOrigins,
			desktopToken,
			qqSessionRegistry,
			extensions: {
				mounts: extensionMounts,
				loaded: () => loadedExtensions?.list() ?? [],
				status: (id) => loadedExtensions?.status(id),
				descriptor: (id) => loadedExtensions?.descriptor(id),
				configFields: (id) => loadedExtensions?.configFields(id),
				bots: (id) => loadedExtensions?.bots(id),
				// 拨完开关面板紧接着刷这一口:先把还没落地的那一下落实掉再报状态。
				settle: async () => {
					await loadedExtensions?.sync();
				},
				// 面板上传装拓展:落到唯一那个装载根,装完当场重扫(新装的于是立刻跑起来)。
				install: {
					root: extensionsRootIn(bootstrap.dataDir),
					rescan: async () => {
						await loadedExtensions?.rescan();
					},
					restartAbility,
				},
			},
			// 注册表交给路由:别名冲突检查与 `GET /api/commands` 都照它来,
			// 面板上那张指令卡片不必再手写一份清单。
			commands,
			onStatsRoute: (route) => {
				statsRoute = route;
			},
			// 面板上的「试一次」—— 调的就是 cron 到点调的那两个函数,不是模拟。
			runRoastNow: (uid) => (uid ? roastScheduler.runSoloOnce(uid) : roastScheduler.runBoardOnce()),
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
		await new Promise<void>((resolveServe) => {
			server = serve(
				{
					fetch: app.fetch,
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

		// Mount WebSocket layer on top of the same HTTP server. Chicken-and-egg
		// resolution: the serviceCtx is built first (no log hook), the WS server's
		// log channel is then installed back onto the serviceCtx via setLogHook so
		// every subsequent `logger.<level>(...)` call also lands on the `log` channel.
		const httpServer = server as unknown as HttpServer;
		// 拓展的 upgrade 分发从这一刻起开始收连接(`ws://<BN>/ext/<id>`)。放在这儿而不是
		// 构造那会儿:HTTP server 要等 serve()。
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
		});
		// Single fan-out point: redact ONCE, then tee to the WS ring (live tail) +
		// the on-disk archive. Both receive exactly what passed the upstream fanOut
		// level gate (Tab == archive == console, per-module pino level).
		previousLogHook = runtime.serviceCtx.setLogHook(
			createLogSink({ ring: wsServer.logChannel, store: runtime.logStore }),
		);

		const handle: StandaloneServerHandle = {
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
			processHandlerCleanup = installProcessHandlers(handle, log.error);
		return handle;
	} catch (err) {
		await close("startup failure").catch((shutdownErr) => {
			log.error("error during startup cleanup", shutdownErr);
		});
		throw err;
	}
}

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

async function hasReadableIndexHtml(dir: string): Promise<boolean> {
	try {
		await access(join(dir, "index.html"), constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

async function closeHttpServer(
	server: ServerType | undefined,
	timeoutMs: number,
	onTimeout: (msg: string) => void,
): Promise<void> {
	if (!server) return;
	await new Promise<void>((resolveClose, rejectClose) => {
		let settled = false;
		const finish = (err?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (err) rejectClose(err);
			else resolveClose();
		};
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			onTimeout(`HTTP server close timed out after ${timeoutMs}ms; continuing shutdown`);
			resolveClose();
		}, timeoutMs);
		timer.unref?.();
		try {
			const close = server.close.bind(server) as (callback: (err?: Error) => void) => void;
			close(finish);
		} catch (err) {
			finish(err as Error);
		}
	});
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
	handle: StandaloneServerHandle,
	logError: (msg: string, ...args: unknown[]) => void,
): () => void {
	let exiting = false;
	const closeThenExit = (reason: string, code: number): void => {
		if (exiting) return;
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
	startStandaloneServer({ installProcessHandlers: true }).catch((err) => {
		console.error("fatal startup error", err);
		process.exit(1);
	});
}
