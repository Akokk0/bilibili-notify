import type { Server as HttpServer } from "node:http";
import { type ServerType, serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { type AuthSystem, createAuthSystem } from "./auth/index.js";
import { loadBootstrapConfig } from "./config/loader.js";
import { createAppRuntime } from "./runtime/bootstrap.js";
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
		});
	} catch (err) {
		// Fatal: without StorageManager / BilibiliAPI the dashboard can't function.
		log.error("auth system init failed", err);
		throw err;
	}

	const app = createApp(runtime, { authSystem });
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
