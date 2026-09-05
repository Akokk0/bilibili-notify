import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { join } from "node:path";
import type { StatsOverviewResponse } from "@bilibili-notify/contract";
import type { NotificationPayload } from "@bilibili-notify/internal";
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
import { startHistoryRetention } from "./history/retention.js";
import { startLogRetention } from "./logs/retention.js";
import { createLogSink } from "./logs/sink.js";
import { createOnebotAdapter } from "./platforms/onebot.js";
import { createQQOfficialAdapter, createQQSessionRegistry } from "./platforms/qq-official.js";
import type { InboundGroupMessage, InboundMeta, InboundPrivateMessage } from "./platforms/types.js";
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
import { createLinkParser, type LinkSourcePlatform } from "./runtime/link-parser.js";
import { createLoginCommand } from "./runtime/login-command.js";
import { resolveProbeInterval, startMemoryProbe } from "./runtime/memory-probe.js";
import { createMuteCommand } from "./runtime/mute-command.js";
import { resolveExpectedParent, startParentWatch } from "./runtime/parent-watch.js";
import { createPuppeteerAdapter, type StandalonePuppeteer } from "./runtime/puppeteer.js";
import { createReportCommand } from "./runtime/report-command.js";
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
		let onInboundGroup:
			| ((platform: LinkSourcePlatform, msg: InboundGroupMessage, meta: InboundMeta) => void)
			| undefined;
		const adapters = [
			createOnebotAdapter({
				logger: log,
				serviceCtx: runtime.serviceCtx,
				onInboundPrivate: (msg, meta) => onInboundPrivate?.(msg, meta),
				onInboundGroup: (msg, meta) => onInboundGroup?.("onebot", msg, meta),
			}),
			createQQOfficialAdapter({
				logger: log,
				serviceCtx: runtime.serviceCtx,
				registry: qqSessionRegistry,
				onInboundPrivate: (msg, meta) => onInboundPrivate?.(msg, meta),
				onInboundGroup: (msg, meta) => onInboundGroup?.("qq-official", msg, meta),
			}),
			createWebhookAdapter({ logger: log }),
		];
		engines = createEngines({
			serviceCtx: runtime.serviceCtx,
			// 全进程唯一那个字体读取口 —— 预览路由经 RouteDeps.runtime 取的是同一个。
			loadFontFace: runtime.loadFontFace,
			api: authSystem.api,
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

		// 内存自检:默认 10 分钟一条,`BN_MEMORY_PROBE_SECONDS=0` 关掉。
		// 挂在 engines 之后,好把弹幕收集器的规模一起报出来 —— 那是引擎里唯一
		// 一处随「弹幕量 × 在播时长」无界增长的结构,堆涨时第一个该看它。
		startMemoryProbe({
			serviceCtx: runtime.serviceCtx,
			intervalSeconds: resolveProbeInterval(process.env.BN_MEMORY_PROBE_SECONDS),
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
		// 每个平台的「谁」长得不一样:onebot 是 user_id,qq-official 是 C2C 的
		// userOpenid。**绝不能跨平台比对** —— 两个命名空间里的字符串撞上就等于
		// 认错人。取不到(没配 / 群目标没有 userOpenid / 平台还没接入站)就返回
		// undefined,于是谁都不认。
		//
		// 审批与指令分发共用同一个来源:各写一份迟早有一边判得不一样。
		const masterUserId = () => {
			const id = runtime.configStore.getGlobals().master.targetId;
			if (!id) return undefined;
			const t = runtime.configStore.getTargets().find((x) => x.id === id);
			if (t?.platform === "onebot") return t.session.userId;
			if (t?.platform === "qq-official") return t.session.userOpenid;
			return undefined;
		};

		const roastCommands = createRoastCommandHandler({
			drafts: roastDrafts,
			logger: log,
			masterUserId,
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
					adapters: runtime.configStore
						.getAdapters()
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
			masterUserId,
			reply: tellMaster,
			config: () => runtime.configStore.getGlobals().commands,
			commands,
			// 审批的 y/n 作为第二道门 —— 有待审草稿时才认,没有时它只是个普通字母。
			confirmation: roastCommands.confirmation,
		});

		// 群里贴视频链接 → 回一张卡。回到来源群不走推送目标表:用收到这条消息的那个
		// adapter 直接发,群不必配成推送目标(主人定的:机器人在的所有群都算)。
		// OneBot 的 groupId 是群号,官机的是群 openid —— 临时目标按平台各造各的。
		// `engines` 是个会被热重载赋值的 let,闭包里 TS 收不窄;这一刻它一定在(上面刚建的)。
		const runtimeEngines = engines;
		// 回到来源群用的是收到那一帧的适配器:配置里那条 + 它所属平台的实现,两者都在才发得出。
		const replyRoute = (platform: LinkSourcePlatform, adapterId: string) => {
			const adapter = runtime.configStore.getAdapters().find((a) => a.id === adapterId);
			const platformAdapter = adapters.find((a) => a.platforms.includes(platform));
			return adapter && platformAdapter ? { adapter, platformAdapter } : null;
		};
		const linkParser = createLinkParser({
			logger: log,
			// 开关与呈现都从引擎拿:随 config-changed 刷新的快照,呈现规则与推送的动态卡同源。
			config: () => runtimeEngines.linkParsing(),
			policyFor: (key) => runtimeEngines.linkPolicyFor(key),
			api: runtimeEngines.api,
			renderer: () => runtimeEngines.imageRenderer,
			presentation: () => runtimeEngines.linkCardPresentation(),
			capabilities: ({ platform, adapterId }) => {
				const route = replyRoute(platform, adapterId);
				return route?.platformAdapter.capabilities?.(route.adapter);
			},
			probeCapabilities: async ({ platform, adapterId }) => {
				const route = replyRoute(platform, adapterId);
				return route?.platformAdapter.probeCapabilities?.(route.adapter);
			},
			send: async ({ platform, adapterId, groupId }, payload) => {
				const route = replyRoute(platform, adapterId);
				if (!route) {
					return { ok: false, latencyMs: 0, err: `adapter not found: adapterId=${adapterId}` };
				}
				const { adapter, platformAdapter } = route;
				const common = {
					id: `link-reply:${groupId}`,
					name: "链接解析回复",
					adapterId,
					scope: "group" as const,
					enabled: true,
				};
				return platformAdapter.send(
					adapter,
					platform === "onebot"
						? { ...common, platform: "onebot", session: { groupId } }
						: { ...common, platform: "qq-official", session: { groupOpenid: groupId } },
					payload,
				);
			},
		});

		// 两个 adapter 交出来的是同一个形状:私聊进指令分发,群进链接解析。哪个平台来的
		// 只有链接解析关心(回到来源群要按平台造目标),所以在这儿补上。
		onInboundPrivate = (msg) => void commandDispatcher.handleMessage(msg);
		onInboundGroup = (platform, msg, meta) =>
			void linkParser.handleMessage({ platform, adapterId: meta.adapterId, ...msg });

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

		// 当前跑的这份载荷的版本 —— 启动时算过一次的那个常量,别再向上找一遍 package.json。
		const payloadVersion = APP_VERSION;

		// 运行时 chromePath 写回目标:仅 B 模型(显式 BN_CONFIG)有单一可写文件;
		// legacy/disabled 返回 null → 热启用仍生效但不持久化(改配置走 env / 手编辑)。
		const configPath = resolveConfigPath({ env });
		const backupService = authSystem
			? createBackupService({
					configStore: runtime.configStore,
					cookieStore: authSystem.storage.cookieStore,
					onCookiesRestored: () => authSystem?.reloadCookiesFromStore(),
				})
			: undefined;

		const app = createApp(runtime, {
			authSystem,
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
			// 注册表交给路由:别名冲突检查与 `GET /api/commands` 都照它来,
			// 面板上那张指令卡片不必再手写一份清单。
			commands,
			onStatsRoute: (route) => {
				statsRoute = route;
			},
			// 面板上的「试一次」—— 调的就是 cron 到点调的那两个函数,不是模拟。
			runRoastNow: (uid) => (uid ? roastScheduler.runSoloOnce(uid) : roastScheduler.runBoardOnce()),
			update: {
				service: createUpdateService({
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
				}),
				// 与 /api/health 报的是同一个值:面板靠「startedAt 变了」认新进程。
				startedAt: STARTED_AT,
				// 应用 = 优雅停机 + 退 0,由进程管理器把新版本拉起来。**退出码必须是 0**:
				// 非 0 会被编排系统当成崩溃,退避重启甚至进 CrashLoopBackOff。
				applyUpdate: async () => {
					try {
						await close("update apply");
					} catch (err) {
						// close() 是 rethrow 的。停机里某一处 dispose 抛了也得退 0:这时进程
						// 反正要没了,非 0 只会让编排系统当成崩溃去退避重启。
						log.error(
							`update apply: graceful close failed, exiting anyway: ${err instanceof Error ? err.message : String(err)}`,
						);
					} finally {
						process.exit(0);
					}
				},
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
		wsServer = createWsServer({
			httpServer,
			bus: runtime.bus,
			serviceCtx: runtime.serviceCtx,
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
