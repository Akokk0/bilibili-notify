import type { Server as HttpServer } from "node:http";
import { type ServerType, serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { shouldRefuseBareAuth } from "./auth/bare-auth-policy.js";
import { type AuthSystem, createAuthSystem } from "./auth/index.js";
import { createWsTicketStore } from "./auth/ws-ticket.js";
import { loadBootstrapConfig } from "./config/loader.js";
import { startHistoryRetention } from "./history/retention.js";
import { startLogRetention } from "./logs/retention.js";
import { createLogSink } from "./logs/sink.js";
import { createOnebotAdapter } from "./platforms/onebot.js";
import { createWebDashboardAdapter } from "./platforms/web-dashboard.js";
import { createWebhookAdapter } from "./platforms/webhook.js";
import { createAppRuntime } from "./runtime/bootstrap.js";
import { createEngines } from "./runtime/engines.js";
import { startFansPoller } from "./runtime/fans-poller.js";
import { createPuppeteerAdapter, type StandalonePuppeteer } from "./runtime/puppeteer.js";
import { bindSubscriptionStore } from "./runtime/subscription-store.js";
import { createWsServer } from "./ws/server.js";

async function main(): Promise<void> {
	const bootstrap = loadBootstrapConfig();
	const runtime = createAppRuntime(bootstrap);
	const log = runtime.serviceCtx.logger;

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
	let authSystem: AuthSystem | undefined;
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
	const allowNoAuth = process.env.BN_ALLOW_NO_AUTH === "1";
	if (!basicAuthCredentials) {
		if (shouldRefuseBareAuth({ host, hasBasicAuth: false, allowNoAuth })) {
			log.error(
				`auth not configured but listening on ${host} (non-loopback). 拒绝启动以避免裸暴露。请设置 auth.basicAuth.{username,password} 或 BN_DASHBOARD_USER/BN_DASHBOARD_PASS;或者把 server.host 改为 127.0.0.1 / BN_HOST=127.0.0.1;或者用 BN_ALLOW_NO_AUTH=1 强制允许(自担风险)。`,
			);
			process.exit(1);
		}
		log.warn(
			`auth not configured, dashboard exposed without auth (host=${host}${allowNoAuth ? " allow_no_auth=1" : ""})`,
		);
	}
	if (!bootstrap.auth?.allowedOrigins || bootstrap.auth.allowedOrigins.length === 0) {
		log.warn(
			"auth.allowedOrigins not configured, WebSocket Origin check disabled (any browser origin may upgrade)",
		);
	}

	// Lazy puppeteer-core launch — only constructed when chromePath is set.
	// Browser process spawns on first use (cards/preview OR engine card render),
	// not at boot. Built before createEngines so live + dynamic can share the
	// same ImageRenderer instance as /api/cards/preview.
	let puppeteer: StandalonePuppeteer | null = null;
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
	const subBinding = bindSubscriptionStore({ bus: runtime.bus, configStore: runtime.configStore });
	// Boot-time orphan sweep: drop sub-runtime entries whose subscription no
	// longer exists (deleted while the server was down). FansPoller's
	// subscription-changed listener handles deletions made while running.
	await runtime.subRuntimeStore.prune(subBinding.store.list().map((s) => s.id));
	const adapters = [
		createOnebotAdapter({ logger: log }),
		createWebhookAdapter({ logger: log }),
		createWebDashboardAdapter({ logger: log }),
	];
	const engines = createEngines({
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

	if (bootstrap.webDistDir) {
		log.info(`serving dashboard static assets from ${bootstrap.webDistDir}`);
	}
	// WS ticket store:仅当 basicAuth 启用时才需要。前端 WebSocket 无法附带
	// Authorization 头,改用 `POST /api/auth/ws-ticket` 换短时 token,再用 `?ticket=`
	// 完成 WS upgrade,避免把真实凭证拼进 URL 落进反代日志。
	const wsTicketStore = basicAuthCredentials ? createWsTicketStore() : null;
	const app = createApp(runtime, {
		authSystem,
		basicAuthCredentials,
		puppeteer,
		staticDir: bootstrap.webDistDir,
		wsTicketStore,
	});
	let server: ServerType | undefined;
	await new Promise<void>((resolve) => {
		server = serve(
			{
				fetch: app.fetch,
				hostname: bootstrap.server.host,
				port: bootstrap.server.port,
			},
			(info) => {
				log.info(`listening on http://${info.address}:${info.port}`);
				resolve();
			},
		);
	});

	// Mount WebSocket layer on top of the same HTTP server. Chicken-and-egg
	// resolution: the serviceCtx is built first (no log hook), the WS server's
	// log channel is then installed back onto the serviceCtx via setLogHook so
	// every subsequent `logger.<level>(...)` call also lands on the `log` channel.
	const httpServer = server as unknown as HttpServer;
	const wsServer = createWsServer({
		httpServer,
		bus: runtime.bus,
		store: runtime.configStore,
		serviceCtx: runtime.serviceCtx,
		basicAuthCredentials,
		wsTicketStore,
		allowedOrigins: bootstrap.auth?.allowedOrigins,
	});
	// Single fan-out point: redact ONCE, then tee to the WS ring (live tail) +
	// the on-disk archive. Both receive exactly what passed the upstream fanOut
	// level gate (Tab == archive == console, per-module pino level).
	const previousLogHook = runtime.serviceCtx.setLogHook(
		createLogSink({ ring: wsServer.logChannel, store: runtime.logStore }),
	);

	let shuttingDown = false;
	const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		log.info(`received ${signal}, shutting down…`);
		try {
			runtime.serviceCtx.setLogHook(previousLogHook);
			wsServer.dispose();
			wsTicketStore?.dispose();
			subBinding.dispose();
			engines.dispose();
			if (puppeteer) await puppeteer.dispose();
			authSystem?.dispose();
			if (server) {
				await new Promise<void>((resolve) => {
					server?.close(() => resolve());
				});
			}
			await runtime.dispose();
		} catch (err) {
			log.error("error during shutdown", err);
		} finally {
			process.exit(0);
		}
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("uncaughtException", (err) => {
		log.error("uncaughtException", err);
	});
	process.on("unhandledRejection", (err) => {
		log.error("unhandledRejection", err);
	});
}

main().catch((err) => {
	console.error("fatal startup error", err);
	process.exit(1);
});
