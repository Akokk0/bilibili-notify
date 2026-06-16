import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type ServerType, serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { shouldRefuseBareAuth } from "./auth/bare-auth-policy.js";
import { type AuthSystem, createAuthSystem } from "./auth/index.js";
import { createSessionCodec } from "./auth/session.js";
import { createWsTicketStore } from "./auth/ws-ticket.js";
import { loadBootstrapConfig, resolveConfigPath } from "./config/loader.js";
import { persistChromePath } from "./config/persist.js";
import { startHistoryRetention } from "./history/retention.js";
import { startLogRetention } from "./logs/retention.js";
import { createLogSink } from "./logs/sink.js";
import { createOnebotAdapter } from "./platforms/onebot.js";
import { createQQOfficialAdapter, createQQSessionRegistry } from "./platforms/qq-official.js";
import { createWebDashboardAdapter } from "./platforms/web-dashboard.js";
import { createWebhookAdapter } from "./platforms/webhook.js";
import { type AppRuntime, createAppRuntime } from "./runtime/bootstrap.js";
import { createEngines } from "./runtime/engines.js";
import { startFansPoller } from "./runtime/fans-poller.js";
import { createPuppeteerAdapter, type StandalonePuppeteer } from "./runtime/puppeteer.js";
import { bindSubscriptionStore } from "./runtime/subscription-store.js";
import { createWsServer } from "./ws/server.js";
import type { LogEntry } from "./ws/types.js";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const DEFAULT_WEB_DIST_DIR = "/app/web-dist";

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
	defaultWebDistDir?: string;
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

		// Lazy puppeteer-core launch — only constructed when chromePath is set.
		// Browser process spawns on first use (cards/preview OR engine card render),
		// not at boot. Built before createEngines so live + dynamic can share the
		// same ImageRenderer instance as /api/cards/preview.
		if (bootstrap.chromePath) {
			puppeteer = createPuppeteerAdapter({ chromePath: bootstrap.chromePath, logger: log });
		} else {
			log.warn(
				"chromePath 未配置，卡片图片渲染将退化为文字推送（设置 BN_CHROME_PATH 或 yaml chromePath 后启用）",
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
		// QQ 官方机器人:网关捞到的群/C2C openid 落进这张共享发现表(不落盘),
		// 后续 qq-sessions 路由读它供面板「先让机器人被@一次」选择器。
		const qqSessionRegistry = createQQSessionRegistry();
		const adapters = [
			createOnebotAdapter({ logger: log, serviceCtx: runtime.serviceCtx }),
			createQQOfficialAdapter({
				logger: log,
				serviceCtx: runtime.serviceCtx,
				registry: qqSessionRegistry,
			}),
			createWebhookAdapter({ logger: log }),
			createWebDashboardAdapter({ logger: log }),
		];
		engines = createEngines({
			serviceCtx: runtime.serviceCtx,
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

		const webDist = await resolveEffectiveWebDistDir({
			configured: bootstrap.webDistDir,
			envValue: normalizeOptionalEnv(env.BN_WEB_DIST),
			defaultDir: options.defaultWebDistDir ?? DEFAULT_WEB_DIST_DIR,
		});
		const effectiveWebDistDir = webDist.dir;
		if (webDist.source === "env") {
			log.warn(
				`bootstrap config missing webDistDir, using BN_WEB_DIST=${webDist.dir}. 请把 webDistDir: ${webDist.dir} 写入 /config/bn.config.yaml,或删除旧配置让容器重新生成。`,
			);
		} else if (webDist.source === "default") {
			log.warn(
				`bootstrap config missing webDistDir and BN_WEB_DIST is empty; found ${webDist.defaultDir}/index.html, using ${webDist.defaultDir}. 请把 webDistDir: ${webDist.defaultDir} 写入 /config/bn.config.yaml,或删除旧配置让容器重新生成。`,
			);
		} else if (webDist.source === "disabled" && normalizeOptionalEnv(env.BN_CONFIG)) {
			log.warn(
				`dashboard static assets disabled: bootstrap config missing webDistDir, BN_WEB_DIST is empty, and ${webDist.defaultDir}/index.html was not found. Dashboard GET / will return 404; 请把 webDistDir 写入 /config/bn.config.yaml,或删除旧配置让容器重新生成。`,
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
		const app = createApp(runtime, {
			authSystem,
			basicAuthCredentials,
			sessionCodec,
			puppeteer,
			persistChromePath: configPath
				? (chromePath: string) => persistChromePath(configPath, chromePath)
				: undefined,
			// 热启用成功后把新 puppeteer 接回全局引用,使进程退出时 dispose 能关掉它。
			onPuppeteerEnabled: (next) => {
				puppeteer = next;
			},
			staticDir: effectiveWebDistDir,
			wsTicketStore,
			allowedOrigins,
			desktopToken,
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
			store: runtime.configStore,
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

type WebDistDirSource = "config" | "env" | "default" | "disabled";

async function resolveEffectiveWebDistDir(options: {
	configured: string | undefined;
	envValue: string | undefined;
	defaultDir: string;
}): Promise<{ dir?: string; source: WebDistDirSource; defaultDir: string }> {
	if (options.configured) {
		return { dir: options.configured, source: "config", defaultDir: options.defaultDir };
	}
	if (options.envValue) {
		return { dir: options.envValue, source: "env", defaultDir: options.defaultDir };
	}
	if (await hasReadableIndexHtml(options.defaultDir)) {
		return { dir: options.defaultDir, source: "default", defaultDir: options.defaultDir };
	}
	return { source: "disabled", defaultDir: options.defaultDir };
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

function isEntrypoint(metaUrl: string): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	return metaUrl === pathToFileURL(resolve(entry)).href;
}

if (isEntrypoint(import.meta.url)) {
	startStandaloneServer({ installProcessHandlers: true }).catch((err) => {
		console.error("fatal startup error", err);
		process.exit(1);
	});
}
