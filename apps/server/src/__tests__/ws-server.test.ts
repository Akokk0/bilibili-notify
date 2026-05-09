import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ConfigScope,
	type Disposable,
	type GlobalConfig,
	type MessageBus,
	makeDefaultGlobalConfig,
	type PushTarget,
	type Subscription,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { BootstrapConfig } from "../config/schema.js";
import { type ConfigStore, createConfigStore } from "../config/store.js";
import { createNodeMessageBus } from "../runtime/message-bus.js";
import { createNodeServiceContext, type NodeServiceContext } from "../runtime/service-context.js";
import { createWsServer, type WsServer } from "../ws/server.js";

// ---------------------------------------------------------------------------
// Helpers
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

function connect(port: number): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		ws.once("open", () => resolve(ws));
		ws.once("error", reject);
	});
}

/** Read frames from a socket into an array; returns a getter + unsub. */
function collect(ws: WebSocket): {
	all: () => unknown[];
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
		all: () => buffer.slice(),
		waitFor(pred, timeoutMs = 1000) {
			// Check existing buffer first.
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

function send(ws: WebSocket, obj: unknown): void {
	ws.send(JSON.stringify(obj));
}

function makeBootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 0 }, dataDir, logLevel: "info" };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("WS server", () => {
	let dataDir: string;
	let bus: MessageBus;
	let store: ConfigStore;
	let serviceCtx: NodeServiceContext;
	let httpServer: HttpServer;
	let port: number;
	let wsServer: WsServer;
	let logHookDisposable: Disposable | undefined;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-ws-test-"));
		serviceCtx = createNodeServiceContext({ name: "ws-test", level: "fatal", pretty: false });
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
			// Fast heartbeat for the heartbeat test; 0 disables for tests that don't need it.
			heartbeatIntervalMs: 0,
			heartbeatTimeoutMs: 0,
		});
		serviceCtx.setLogHook((entry) => wsServer.logChannel.push(entry));
		logHookDisposable = { dispose: () => serviceCtx.setLogHook(undefined) };
	});

	afterEach(async () => {
		logHookDisposable?.dispose();
		wsServer.dispose();
		await stopHttpServer(httpServer);
		await serviceCtx.dispose();
		await rm(dataDir, { recursive: true, force: true });
	});

	it("subscribe to state → receives subscribed + state/hydrate immediately", async () => {
		const ws = await connect(port);
		const c = collect(ws);
		send(ws, { type: "subscribe", channels: ["state"] });

		const ack = await c.waitFor((m) => m?.type === "subscribed");
		expect(ack.channels).toContain("state");

		const hydrate = await c.waitFor((m) => m?.type === "state" && m?.event === "hydrate");
		expect(hydrate.data.globals).toEqual(makeDefaultGlobalConfig());
		expect(hydrate.data.subscriptions).toEqual([]);
		expect(hydrate.data.targets).toEqual([]);
		ws.close();
	});

	it("auth-lost on bus → forwarded to subscribed clients", async () => {
		const ws = await connect(port);
		const c = collect(ws);
		send(ws, { type: "subscribe", channels: ["auth"] });
		await c.waitFor((m) => m?.type === "subscribed");

		bus.emit("auth-lost");
		const evt = await c.waitFor((m) => m?.type === "auth" && m?.event === "auth-lost");
		expect(evt.data).toBeNull();
		ws.close();
	});

	it("two clients on different channels — events don't cross over", async () => {
		const a = await connect(port);
		const b = await connect(port);
		const ca = collect(a);
		const cb = collect(b);
		send(a, { type: "subscribe", channels: ["auth"] });
		send(b, { type: "subscribe", channels: ["push-events"] });
		await ca.waitFor((m) => m?.type === "subscribed");
		await cb.waitFor((m) => m?.type === "subscribed");

		bus.emit("auth-lost");
		bus.emit("history-recorded", "abc-123");

		const aEvt = await ca.waitFor((m) => m?.type === "auth" && m?.event === "auth-lost");
		expect(aEvt.data).toBeNull();
		const bEvt = await cb.waitFor(
			(m) => m?.type === "push-events" && m?.event === "history-recorded",
		);
		expect(bEvt.data).toBe("abc-123");

		// Reverse direction: ensure neither leaked.
		expect(ca.all().some((m: any) => m?.type === "push-events")).toBe(false);
		expect(cb.all().some((m: any) => m?.type === "auth")).toBe(false);
		a.close();
		b.close();
	});

	it("unsubscribe stops further delivery", async () => {
		const ws = await connect(port);
		const c = collect(ws);
		send(ws, { type: "subscribe", channels: ["auth"] });
		await c.waitFor((m) => m?.type === "subscribed");

		send(ws, { type: "unsubscribe", channels: ["auth"] });
		await c.waitFor((m) => m?.type === "unsubscribed");

		bus.emit("auth-lost");

		// Wait long enough that any in-flight frame would have arrived.
		await new Promise((r) => setTimeout(r, 50));
		expect(c.all().some((m: any) => m?.type === "auth" && m?.event === "auth-lost")).toBe(false);
		ws.close();
	});

	it("invalid control message → error frame, connection stays open", async () => {
		const ws = await connect(port);
		const c = collect(ws);
		send(ws, { type: "subscribe", channels: ["nope"] });
		const err = await c.waitFor((m) => m?.type === "error");
		expect(err.message).toBe("invalid_control_message");
		// Confirm the socket is still alive by issuing a valid subscribe afterwards.
		send(ws, { type: "subscribe", channels: ["state"] });
		const ack = await c.waitFor((m) => m?.type === "subscribed");
		expect(ack.channels).toContain("state");
		ws.close();
	});

	it("config-changed on state channel includes scope + fresh snapshot", async () => {
		const ws = await connect(port);
		const c = collect(ws);
		send(ws, { type: "subscribe", channels: ["state"] });
		await c.waitFor((m) => m?.type === "state" && m?.event === "hydrate");

		await store.patchGlobals({ app: { dynamicCron: "*/15 * * * *" } });
		const evt = await c.waitFor((m) => m?.type === "state" && m?.event === "config-changed");
		expect(evt.data.scope).toBe("globals");
		expect((evt.data.snapshot as GlobalConfig).app.dynamicCron).toBe("*/15 * * * *");
		ws.close();
	});

	it("client ping → server pong", async () => {
		const ws = await connect(port);
		const c = collect(ws);
		send(ws, { type: "ping" });
		const pong = await c.waitFor((m) => m?.type === "pong");
		expect(pong).toBeDefined();
		ws.close();
	});

	it("logger.warn is forwarded onto the log channel", async () => {
		const ws = await connect(port);
		const c = collect(ws);
		send(ws, { type: "subscribe", channels: ["log"] });
		await c.waitFor((m) => m?.type === "subscribed");

		serviceCtx.logger.warn("hello-from-test", { extra: 1 });
		const evt = await c.waitFor((m) => m?.type === "log" && m?.event === "warn");
		expect(evt.data.msg).toBe("hello-from-test");
		expect(Array.isArray(evt.data.args)).toBe(true);
		ws.close();
	});
});

// ---------------------------------------------------------------------------
// Heartbeat suite — separate so we can use accelerated timings without
// affecting the rest of the suite's wall-clock expectations.
// ---------------------------------------------------------------------------

describe("WS server heartbeat", () => {
	it("client that never replies pong gets terminated within the timeout window", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "bn-ws-hb-"));
		const serviceCtx = createNodeServiceContext({ name: "hb", level: "fatal", pretty: false });
		const bus = createNodeMessageBus();
		const store = createConfigStore({ bootstrap: makeBootstrap(dataDir), bus, serviceCtx });
		await store.load();
		const { server, port } = await startHttpServer();
		const wsServer = createWsServer({
			httpServer: server,
			bus,
			store,
			serviceCtx,
			heartbeatIntervalMs: 200,
			heartbeatTimeoutMs: 500,
		});

		try {
			const ws = await connect(port);
			// Suppress automatic pong replies: ws (client) replies to control-frame
			// PINGs automatically, but our heartbeat is application-level so the
			// client must reply with a JSON `{type:'pong'}` itself. By NOT sending
			// one we should be terminated within ~700ms (1× ping + timeout window).
			const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
			await Promise.race([
				closed,
				new Promise<void>((_resolve, reject) =>
					setTimeout(() => reject(new Error("heartbeat did not terminate stale client")), 2000),
				),
			]);
			expect(ws.readyState).toBe(WebSocket.CLOSED);
		} finally {
			wsServer.dispose();
			await stopHttpServer(server);
			await serviceCtx.dispose();
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	it("client that replies pong stays connected", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "bn-ws-hb2-"));
		const serviceCtx = createNodeServiceContext({ name: "hb2", level: "fatal", pretty: false });
		const bus = createNodeMessageBus();
		const store = createConfigStore({ bootstrap: makeBootstrap(dataDir), bus, serviceCtx });
		await store.load();
		const { server, port } = await startHttpServer();
		const wsServer = createWsServer({
			httpServer: server,
			bus,
			store,
			serviceCtx,
			heartbeatIntervalMs: 100,
			heartbeatTimeoutMs: 300,
		});

		try {
			const ws = await connect(port);
			ws.on("message", (raw: Buffer) => {
				let msg: any;
				try {
					msg = JSON.parse(raw.toString("utf8"));
				} catch {
					return;
				}
				if (msg?.type === "ping") send(ws, { type: "pong" });
			});
			// Idle for ~700ms — well past the 300ms timeout. We should still be open.
			await new Promise((r) => setTimeout(r, 700));
			expect(ws.readyState).toBe(WebSocket.OPEN);
			ws.close();
		} finally {
			wsServer.dispose();
			await stopHttpServer(server);
			await serviceCtx.dispose();
			await rm(dataDir, { recursive: true, force: true });
		}
	});
});

// silence unused
void ((_: Subscription[], __: PushTarget[], ___: ConfigScope) => undefined);
