import type { Server as HttpServer } from "node:http";
import { type ServerType, serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { type AuthSystem, createAuthSystem } from "./auth/index.js";
import { loadBootstrapConfig } from "./config/loader.js";
import { startHistoryRetention } from "./history/retention.js";
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

	// Stage 2.4: assemble the auth stack (StorageManager → BilibiliAPI → LoginFlow). Bus
	// emissions made by LoginFlow flow into the WS `auth` channel via stage 2.3 wiring.
	let authSystem: AuthSystem | undefined;
	try {
		authSystem = await createAuthSystem({
			serviceCtx: runtime.serviceCtx,
			bus: runtime.bus,
			bootstrap,
			// 从 globals.app.healthCheckMinutes 计算初始 ms;后续 config-changed
			// 会通过 engines.ts 调 flow.setHealthCheckMs 热更。
			healthCheckMs: runtime.configStore.getGlobals().app.healthCheckMinutes * 60_000,
		});
	} catch (err) {
		// Fatal: without StorageManager / BilibiliAPI the dashboard can't function.
		log.error("auth system init failed", err);
		throw err;
	}

	// Warn loudly when no dashboard auth is configured — local dev is fine bare,
	// but anything reachable beyond localhost should set BN_DASHBOARD_USER/PASS or
	// auth.basicAuth in the YAML. We do NOT refuse to start (per plan §4.2).
	const basicAuthCredentials = bootstrap.auth?.basicAuth;
	if (!basicAuthCredentials) {
		log.warn(
			"auth not configured, dashboard exposed without auth (set auth.basicAuth.{username,password} or BN_DASHBOARD_USER/BN_DASHBOARD_PASS)",
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

	// 启动 FansPoller — cron 跟 globals.app.dynamicCron,每个 enabled sub
	// 拉一次 B 站 fans 数,写时序 jsonl + emit `fans-refreshed`。
	const fansPoller = startFansPoller({
		bus: runtime.bus,
		logger: log,
		configStore: runtime.configStore,
		subscriptionStore: subBinding.store,
		fansStore: runtime.fansStore,
		api: authSystem.api,
	});
	runtime.attachFansPoller(fansPoller);
	runtime.serviceCtx.onDispose(() => fansPoller.dispose());

	if (bootstrap.webDistDir) {
		log.info(`serving dashboard static assets from ${bootstrap.webDistDir}`);
	}
	const app = createApp(runtime, {
		authSystem,
		basicAuthCredentials,
		puppeteer,
		staticDir: bootstrap.webDistDir,
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
		allowedOrigins: bootstrap.auth?.allowedOrigins,
	});
	const previousLogHook = runtime.serviceCtx.setLogHook((entry) => wsServer.logChannel.push(entry));

	let shuttingDown = false;
	const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		log.info(`received ${signal}, shutting down…`);
		try {
			runtime.serviceCtx.setLogHook(previousLogHook);
			wsServer.dispose();
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
