import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageBus } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createWsTicketStore } from "../auth/ws-ticket.js";
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

/** Loose envelope type for inbound WS frames; same shape as ws-server.test.ts. */
type WsMsg = Record<string, unknown>;

/** Typed accessor for the WS frame's `data` envelope; tests assert on the runtime shape. */
function dataOf(m: WsMsg): Record<string, unknown> {
	return (m.data ?? {}) as Record<string, unknown>;
}

function collectFrames(ws: WebSocket): {
	waitFor: (pred: (msg: WsMsg) => boolean, timeoutMs?: number) => Promise<WsMsg>;
} {
	const buffer: WsMsg[] = [];
	const waiters: Array<{
		pred: (msg: WsMsg) => boolean;
		resolve: (m: WsMsg) => void;
		reject: (e: Error) => void;
		timer: NodeJS.Timeout;
	}> = [];
	ws.on("message", (raw: Buffer) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw.toString("utf8"));
		} catch {
			return;
		}
		if (typeof parsed !== "object" || parsed === null) return;
		const msg = parsed as WsMsg;
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
			for (const m of buffer) if (pred(m)) return Promise.resolve(m);
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
// Suite — WS upgrade gate (cookie-only model, Q4/Q7d)
//
// The only accepted upgrade credential is a one-shot `?ticket=` issued by the
// cookie-authed `POST /api/auth/ws-ticket`. The legacy `Authorization: Basic`
// and `?token=<b64>` paths were removed — these tests lock that.
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

	it("auth required: upgrade without a ticket is rejected (401)", async () => {
		wsServer = createWsServer({
			httpServer,
			bus,
			store,
			serviceCtx,
			heartbeatIntervalMs: 0,
			heartbeatTimeoutMs: 0,
			authRequired: true,
		});

		const result = await tryConnect(`ws://127.0.0.1:${port}/ws`);
		expect(result.outcome).toBe("rejected");
		expect(result.statusCode).toBe(401);
	});

	it("auth required: Authorization: Basic is NO LONGER accepted (regression, Q7d)", async () => {
		wsServer = createWsServer({
			httpServer,
			bus,
			store,
			serviceCtx,
			heartbeatIntervalMs: 0,
			heartbeatTimeoutMs: 0,
			authRequired: true,
		});

		const result = await tryConnect(`ws://127.0.0.1:${port}/ws`, {
			Authorization: `Basic ${basicToken("admin", "s3cret")}`,
		});
		expect(result.outcome).toBe("rejected");
		expect(result.statusCode).toBe(401);
	});

	it("auth required: ?token=<b64> is NO LONGER accepted (regression, Q7d)", async () => {
		wsServer = createWsServer({
			httpServer,
			bus,
			store,
			serviceCtx,
			heartbeatIntervalMs: 0,
			heartbeatTimeoutMs: 0,
			authRequired: true,
		});

		const tok = encodeURIComponent(basicToken("admin", "s3cret"));
		const result = await tryConnect(`ws://127.0.0.1:${port}/ws?token=${tok}`);
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

	it("origin gate: upgrade with NO Origin header is destroyed when the gate is enabled (shared-helper equivalence)", async () => {
		// Regression for the ws/server.ts refactor onto auth/origin.ts: the old
		// inline impl rejected a missing/non-string Origin (`if(!o) return false`)
		// once the gate was enabled. `node`'s `ws` client sends no Origin header
		// by default, so this exercises exactly that path through the shared
		// `isOriginAllowed` helper — must still be a hard reject.
		wsServer = createWsServer({
			httpServer,
			bus,
			store,
			serviceCtx,
			heartbeatIntervalMs: 0,
			heartbeatTimeoutMs: 0,
			allowedOrigins: ["https://dashboard.example.com"],
		});

		const result = await tryConnect(`ws://127.0.0.1:${port}/ws`);
		expect(result.outcome).toBe("rejected");
	});

	it("origin gate disabled (no allowedOrigins): upgrade with NO Origin header succeeds (legacy parity)", async () => {
		// The other half of the equivalence: gate off → missing Origin is fine
		// (old impl returned true before even looking at the header).
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

	// P0-4: ?ticket=<one-shot> 是浏览器 WS 上行的唯一鉴权方式(不让真实凭证落
	// 反代日志)。下面两个 case 锁住 ticket 路径接进 checkAuth + 一次性消费语义。

	it("auth required + valid one-shot ticket: upgrade succeeds, ticket then unusable", async () => {
		const wsTicketStore = createWsTicketStore({ ttlMs: 30_000 });
		wsServer = createWsServer({
			httpServer,
			bus,
			store,
			serviceCtx,
			heartbeatIntervalMs: 0,
			heartbeatTimeoutMs: 0,
			authRequired: true,
			wsTicketStore,
		});

		const { ticket } = wsTicketStore.issue();
		const first = await tryConnect(
			`ws://127.0.0.1:${port}/ws?ticket=${encodeURIComponent(ticket)}`,
		);
		expect(first.outcome).toBe("open");
		first.ws?.close();

		// 同一 ticket 第二次必须被拒(consume 是一次性的)。
		const second = await tryConnect(
			`ws://127.0.0.1:${port}/ws?ticket=${encodeURIComponent(ticket)}`,
		);
		expect(second.outcome).toBe("rejected");
		expect(second.statusCode).toBe(401);

		wsTicketStore.dispose();
	});

	it("auth required + unknown ticket: rejected (401)", async () => {
		const wsTicketStore = createWsTicketStore({ ttlMs: 30_000 });
		wsServer = createWsServer({
			httpServer,
			bus,
			store,
			serviceCtx,
			heartbeatIntervalMs: 0,
			heartbeatTimeoutMs: 0,
			authRequired: true,
			wsTicketStore,
		});

		const result = await tryConnect(`ws://127.0.0.1:${port}/ws?ticket=fabricated-token`);
		expect(result.outcome).toBe("rejected");
		expect(result.statusCode).toBe(401);

		wsTicketStore.dispose();
	});

	it("desktop token configured: upgrade requires ?desktopToken= and still honors Origin gate", async () => {
		const allowedOrigin = `http://127.0.0.1:${port}`;
		wsServer = createWsServer({
			httpServer,
			bus,
			store,
			serviceCtx,
			heartbeatIntervalMs: 0,
			heartbeatTimeoutMs: 0,
			allowedOrigins: [allowedOrigin],
			desktopToken: "desktop-secret",
		});

		const missingToken = await tryConnect(`ws://127.0.0.1:${port}/ws`, {
			Origin: allowedOrigin,
		});
		expect(missingToken.outcome).toBe("rejected");
		expect(missingToken.statusCode).toBe(401);

		const badOrigin = await tryConnect(`ws://127.0.0.1:${port}/ws?desktopToken=desktop-secret`, {
			Origin: "https://evil.example.org",
		});
		expect(badOrigin.outcome).toBe("rejected");
		expect(badOrigin.statusCode).toBeUndefined();

		const ok = await tryConnect(`ws://127.0.0.1:${port}/ws?desktopToken=desktop-secret`, {
			Origin: allowedOrigin,
		});
		expect(ok.outcome).toBe("open");
		ok.ws?.close();
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
		expect(typeof dataOf(evt).refreshedAt).toBe("string");

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
		expect(dataOf(evt).ok).toBe(true);
		expect(dataOf(evt).refreshedAt).toBeDefined();
		expect(JSON.stringify(evt.data)).not.toContain("refreshToken");
		expect(JSON.stringify(evt.data)).not.toContain("cookiesJson");
		ws.close();
	});
});
