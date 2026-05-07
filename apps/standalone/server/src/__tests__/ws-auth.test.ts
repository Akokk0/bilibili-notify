import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageBus } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { BootstrapConfig } from "../config/schema.js";
import { type ConfigStore, createConfigStore } from "../config/store.js";
import { createNodeMessageBus } from "../runtime/message-bus.js";
import { createNodeServiceContext, type NodeServiceContext } from "../runtime/service-context.js";
import { createWsServer, type WsServer } from "../ws/server.js";

// ---------------------------------------------------------------------------
// Helpers (mirror of ws-server.test.ts; kept local so tests run independently)
// ---------------------------------------------------------------------------

async function startHttpServer(): Promise<{ server: HttpServer; port: number }> {
	const server = createServer((_req, res) => {
		res.writeHead(404);
		res.end();
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const addr = server.address() as AddressInfo;
	return { server, port: addr.port };
}

async function stopHttpServer(server: HttpServer): Promise<void> {
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

function makeBootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 0 }, dataDir, logLevel: "silent" };
}

function basicToken(user: string, pass: string): string {
	return Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
}

/**
 * Try to open a ws connection; return ('open' | 'rejected') with the close /
 * error info captured. We treat a server-side `socket.destroy()` as
 * 'rejected' (the client-side will see "unexpected-response" or similar
 * before the open event).
 */
function tryConnect(
	url: string,
	headers?: Record<string, string>,
): Promise<{ outcome: "open" | "rejected"; statusCode?: number; ws?: WebSocket }> {
	return new Promise((resolve) => {
		const ws = new WebSocket(url, headers ? { headers } : undefined);
		let settled = false;
		const settle = (v: {
			outcome: "open" | "rejected";
			statusCode?: number;
			ws?: WebSocket;
		}): void => {
			if (settled) return;
			settled = true;
			resolve(v);
		};
		ws.once("open", () => settle({ outcome: "open", ws }));
		ws.once("unexpected-response", (_req, res) => {
			settle({ outcome: "rejected", statusCode: res.statusCode });
			try {
				ws.terminate();
			} catch {
				/* ignore */
			}
		});
		ws.once("error", () => {
			// Origin failure: server destroys the socket without writing a HTTP
			// response, so ws emits an error rather than 'unexpected-response'.
			settle({ outcome: "rejected" });
		});
		ws.once("close", () => settle({ outcome: "rejected" }));
	});
}

function collectFrames(ws: WebSocket): {
	waitFor: (pred: (msg: any) => boolean, timeoutMs?: number) => Promise<any>;
} {
	const buffer: unknown[] = [];
	const waiters: Array<{
		pred: (msg: any) => boolean;
		resolve: (m: any) => void;
		reject: (e: Error) => void;
		timer: NodeJS.Timeout;
	}> = [];
	ws.on("message", (raw: Buffer) => {
		let msg: unknown;
		try {
			msg = JSON.parse(raw.toString("utf8"));
		} catch {
			return;
		}
		buffer.push(msg);
		for (let i = waiters.length - 1; i >= 0; i--) {
			const w = waiters[i];
			if (!w) continue;
			if (w.pred(msg)) {
				clearTimeout(w.timer);
				waiters.splice(i, 1);
				w.resolve(msg);
			}
		}
	});
	return {
		waitFor(pred, timeoutMs = 1000) {
			for (const m of buffer) if (pred(m as any)) return Promise.resolve(m as any);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					const idx = waiters.findIndex((w) => w.timer === timer);
					if (idx >= 0) waiters.splice(idx, 1);
					reject(new Error(`timed out after ${timeoutMs}ms waiting for matching frame`));
				}, timeoutMs);
				waiters.push({ pred, resolve, reject, timer });
			});
		},
	};
}

// ---------------------------------------------------------------------------
// Suite — Fix 4b: WS upgrade auth + Origin gate
// ---------------------------------------------------------------------------

describe("WS upgrade gate", () => {
	let dataDir: string;
	let bus: MessageBus;
	let store: ConfigStore;
	let serviceCtx: NodeServiceContext;
	let httpServer: HttpServer;
	let port: number;
	let wsServer: WsServer;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-ws-auth-"));
		serviceCtx = createNodeServiceContext({ name: "ws-auth", level: "silent", pretty: false });
		bus = createNodeMessageBus();
		store = createConfigStore({ bootstrap: makeBootstrap(dataDir), bus, serviceCtx });
		await store.load();
		const started = await startHttpServer();
		httpServer = started.server;
		port = started.port;
	});

	afterEach(async () => {
		wsServer?.dispose();
		await stopHttpServer(httpServer);
		await serviceCtx.dispose();
		await rm(dataDir, { recursive: true, force: true });
	});

	it("basic-auth configured: upgrade without Authorization is rejected (401)", async () => {
		wsServer = createWsServer({
			httpServer,
			bus,
			store,
			serviceCtx,
			heartbeatIntervalMs: 0,
			heartbeatTimeoutMs: 0,
			basicAuthCredentials: { username: "admin", password: "s3cret" },
		});

		const result = await tryConnect(`ws://127.0.0.1:${port}/ws`);
		expect(result.outcome).toBe("rejected");
		expect(result.statusCode).toBe(401);
	});

	it("basic-auth configured: upgrade with valid Authorization header succeeds", async () => {
		wsServer = createWsServer({
			httpServer,
			bus,
			store,
			serviceCtx,
			heartbeatIntervalMs: 0,
			heartbeatTimeoutMs: 0,
			basicAuthCredentials: { username: "admin", password: "s3cret" },
		});

		const result = await tryConnect(`ws://127.0.0.1:${port}/ws`, {
			Authorization: `Basic ${basicToken("admin", "s3cret")}`,
		});
		expect(result.outcome).toBe("open");
		result.ws?.close();
	});

	it("basic-auth configured: upgrade with ?token= query-string fallback succeeds", async () => {
		wsServer = createWsServer({
			httpServer,
			bus,
			store,
			serviceCtx,
			heartbeatIntervalMs: 0,
			heartbeatTimeoutMs: 0,
			basicAuthCredentials: { username: "admin", password: "s3cret" },
		});

		const tok = encodeURIComponent(basicToken("admin", "s3cret"));
		const result = await tryConnect(`ws://127.0.0.1:${port}/ws?token=${tok}`);
		expect(result.outcome).toBe("open");
		result.ws?.close();
	});

	it("basic-auth configured: upgrade with wrong password is rejected (401)", async () => {
		wsServer = createWsServer({
			httpServer,
			bus,
			store,
			serviceCtx,
			heartbeatIntervalMs: 0,
			heartbeatTimeoutMs: 0,
			basicAuthCredentials: { username: "admin", password: "s3cret" },
		});

		const result = await tryConnect(`ws://127.0.0.1:${port}/ws`, {
			Authorization: `Basic ${basicToken("admin", "nope")}`,
		});
		expect(result.outcome).toBe("rejected");
		expect(result.statusCode).toBe(401);
	});

	it("origin gate: upgrade from non-whitelisted origin is destroyed (no 401, just dropped)", async () => {
		wsServer = createWsServer({
			httpServer,
			bus,
			store,
			serviceCtx,
			heartbeatIntervalMs: 0,
			heartbeatTimeoutMs: 0,
			allowedOrigins: ["https://dashboard.example.com"],
		});

		const result = await tryConnect(`ws://127.0.0.1:${port}/ws`, {
			Origin: "https://evil.example.org",
		});
		expect(result.outcome).toBe("rejected");
		// No status — server destroys the socket directly.
	});

	it("origin gate: upgrade from whitelisted origin succeeds", async () => {
		wsServer = createWsServer({
			httpServer,
			bus,
			store,
			serviceCtx,
			heartbeatIntervalMs: 0,
			heartbeatTimeoutMs: 0,
			allowedOrigins: ["https://dashboard.example.com"],
		});

		const result = await tryConnect(`ws://127.0.0.1:${port}/ws`, {
			Origin: "https://dashboard.example.com",
		});
		expect(result.outcome).toBe("open");
		result.ws?.close();
	});

	it("no auth + no origin gate: upgrade succeeds (local dev mode)", async () => {
		wsServer = createWsServer({
			httpServer,
			bus,
			store,
			serviceCtx,
			heartbeatIntervalMs: 0,
			heartbeatTimeoutMs: 0,
		});

		const result = await tryConnect(`ws://127.0.0.1:${port}/ws`);
		expect(result.outcome).toBe("open");
		result.ws?.close();
	});
});

// ---------------------------------------------------------------------------
// Suite — Fix 5: cookies-refreshed payload redaction
// ---------------------------------------------------------------------------

describe("WS cookies-refreshed redaction", () => {
	let dataDir: string;
	let bus: MessageBus;
	let store: ConfigStore;
	let serviceCtx: NodeServiceContext;
	let httpServer: HttpServer;
	let port: number;
	let wsServer: WsServer;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-ws-redact-"));
		serviceCtx = createNodeServiceContext({ name: "ws-redact", level: "silent", pretty: false });
		bus = createNodeMessageBus();
		store = createConfigStore({ bootstrap: makeBootstrap(dataDir), bus, serviceCtx });
		await store.load();
		const started = await startHttpServer();
		httpServer = started.server;
		port = started.port;
		wsServer = createWsServer({
			httpServer,
			bus,
			store,
			serviceCtx,
			heartbeatIntervalMs: 0,
			heartbeatTimeoutMs: 0,
		});
	});

	afterEach(async () => {
		wsServer?.dispose();
		await stopHttpServer(httpServer);
		await serviceCtx.dispose();
		await rm(dataDir, { recursive: true, force: true });
	});

	it("strips cookiesJson + refreshToken from the WS envelope", async () => {
		const result = await tryConnect(`ws://127.0.0.1:${port}/ws`);
		expect(result.outcome).toBe("open");
		const ws = result.ws as WebSocket;
		const c = collectFrames(ws);
		ws.send(JSON.stringify({ type: "subscribe", channels: ["auth"] }));
		await c.waitFor((m) => m?.type === "subscribed");

		// Mirror of CookiesRefreshedPayload from packages/api: this is what the
		// real api callback emits onto the bus today.
		const sensitivePayload = {
			cookiesJson:
				'[{"key":"SESSDATA","value":"super-secret-session-token-do-not-leak"},{"key":"bili_jct","value":"csrf-token-also-secret"}]',
			refreshToken: "refresh-token-also-secret",
		};
		bus.emit("cookies-refreshed", sensitivePayload);

		const evt = await c.waitFor((m) => m?.type === "auth" && m?.event === "cookies-refreshed");

		// Envelope's `data` must not contain any cookie/token fields.
		const dataStr = JSON.stringify(evt.data);
		expect(dataStr).not.toContain("super-secret-session-token-do-not-leak");
		expect(dataStr).not.toContain("csrf-token-also-secret");
		expect(dataStr).not.toContain("refresh-token-also-secret");
		expect(dataStr).not.toContain("cookiesJson");
		expect(dataStr).not.toContain("refreshToken");
		expect(dataStr).not.toContain("SESSDATA");
		expect(dataStr).not.toContain("bili_jct");

		// Positive shape — minimal "refresh happened" signal.
		expect(evt.data).toHaveProperty("refreshedAt");
		expect(typeof evt.data.refreshedAt).toBe("string");

		ws.close();
	});

	it("preserves the optional ok boolean if upstream sets it", async () => {
		const result = await tryConnect(`ws://127.0.0.1:${port}/ws`);
		expect(result.outcome).toBe("open");
		const ws = result.ws as WebSocket;
		const c = collectFrames(ws);
		ws.send(JSON.stringify({ type: "subscribe", channels: ["auth"] }));
		await c.waitFor((m) => m?.type === "subscribed");

		bus.emit("cookies-refreshed", {
			cookiesJson: "[]",
			refreshToken: "x",
			ok: true,
		});

		const evt = await c.waitFor((m) => m?.type === "auth" && m?.event === "cookies-refreshed");
		expect(evt.data.ok).toBe(true);
		expect(evt.data.refreshedAt).toBeDefined();
		expect(JSON.stringify(evt.data)).not.toContain("refreshToken");
		expect(JSON.stringify(evt.data)).not.toContain("cookiesJson");
		ws.close();
	});
});
