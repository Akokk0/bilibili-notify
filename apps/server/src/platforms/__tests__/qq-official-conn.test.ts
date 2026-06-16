import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Disposable, Logger, ServiceContext } from "@bilibili-notify/internal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { createQQGatewayConn, QQ_OPCODE, type QQDiscoveredSession } from "../qq-official";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	for (;;) {
		if (cond()) return;
		if (Date.now() - start > timeoutMs) throw new Error("waitFor: 超时");
		await sleep(10);
	}
}

function makeLogger(): Logger {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** 真实定时器的 ServiceContext(WS 是真异步,需要真 setInterval/setTimeout)。 */
function makeServiceCtx(): ServiceContext {
	return {
		logger: makeLogger(),
		setTimeout(fn, ms): Disposable {
			const h = setTimeout(fn, ms);
			return { dispose: () => clearTimeout(h) };
		},
		setInterval(fn, ms): Disposable {
			const h = setInterval(fn, ms);
			return { dispose: () => clearInterval(h) };
		},
		onDispose() {},
	};
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) {
		try {
			await c();
		} catch {
			/* ignore */
		}
	}
});

interface FakeGateway {
	url: string;
	/** 客户端发来的所有帧(跨重连累计)。 */
	received: Array<Record<string, unknown>>;
	conns: WebSocket[];
	/** 向最近一条连接推一条 DISPATCH(自增 seq)。 */
	dispatch(t: string, d: unknown): void;
	/** 向最近一条连接回 HEARTBEAT_ACK。 */
	ack(): void;
}

/** 假 QQ 网关:每条连接一上来就下发 HELLO,收集客户端帧。 */
async function startFakeGateway(opts?: { heartbeatInterval?: number }): Promise<FakeGateway> {
	const wss = new WebSocketServer({ port: 0 });
	await once(wss, "listening");
	const received: Array<Record<string, unknown>> = [];
	const conns: WebSocket[] = [];
	let seq = 0;
	wss.on("connection", (ws) => {
		conns.push(ws);
		ws.send(
			JSON.stringify({ op: 10, d: { heartbeat_interval: opts?.heartbeatInterval ?? 45000 } }),
		);
		ws.on("message", (raw) => {
			received.push(JSON.parse(raw.toString()) as Record<string, unknown>);
		});
	});
	const port = (wss.address() as AddressInfo).port;
	cleanups.push(
		() =>
			new Promise<void>((resolve) => {
				for (const c of conns) c.terminate();
				wss.close(() => resolve());
			}),
	);
	return {
		url: `ws://127.0.0.1:${port}`,
		received,
		conns,
		dispatch(t, d) {
			seq += 1;
			conns.at(-1)?.send(JSON.stringify({ op: 0, s: seq, t, d }));
		},
		ack() {
			conns.at(-1)?.send(JSON.stringify({ op: 11 }));
		},
	};
}

function connOpts(gw: FakeGateway, over: Partial<Parameters<typeof createQQGatewayConn>[0]> = {}) {
	return {
		adapterId: "a1",
		resolveGatewayUrl: async () => gw.url,
		getToken: async () => "ACCESS",
		onDiscovered: vi.fn(),
		serviceCtx: makeServiceCtx(),
		logger: makeLogger(),
		reconnectBaseMs: 10,
		...over,
	};
}

const lastIdentify = (gw: FakeGateway) => gw.received.find((f) => f.op === QQ_OPCODE.IDENTIFY);

describe("createQQGatewayConn — 握手", () => {
	it("收到 HELLO → 回 IDENTIFY(QQBot token + intents + shard[0,1])", async () => {
		const gw = await startFakeGateway();
		const conn = createQQGatewayConn(connOpts(gw));
		cleanups.push(() => conn.close());
		await waitFor(() => lastIdentify(gw) !== undefined);
		const idf = lastIdentify(gw) as { d: { token: string; intents: number; shard: number[] } };
		expect(idf.d.token).toBe("QQBot ACCESS");
		expect(idf.d.shard).toEqual([0, 1]);
		expect(idf.d.intents & (1 << 25)).toBeTruthy();
	});

	it("DISPATCH READY → isOnline() 变 true", async () => {
		const gw = await startFakeGateway();
		const conn = createQQGatewayConn(connOpts(gw));
		cleanups.push(() => conn.close());
		await waitFor(() => lastIdentify(gw) !== undefined);
		gw.dispatch("READY", { session_id: "SID", user: { id: "bot" } });
		await waitFor(() => conn.isOnline());
		expect(conn.isOnline()).toBe(true);
	});
});

describe("createQQGatewayConn — openid 捞取", () => {
	it("GROUP_AT_MESSAGE_CREATE → onDiscovered(group 会话)", async () => {
		const gw = await startFakeGateway();
		const onDiscovered = vi.fn();
		const conn = createQQGatewayConn(connOpts(gw, { onDiscovered }));
		cleanups.push(() => conn.close());
		await waitFor(() => lastIdentify(gw) !== undefined);
		gw.dispatch("READY", { session_id: "SID" });
		gw.dispatch("GROUP_AT_MESSAGE_CREATE", {
			group_openid: "G_OPENID",
			author: { member_openid: "M", username: "阿绫" },
		});
		await waitFor(() => onDiscovered.mock.calls.length > 0);
		expect(onDiscovered).toHaveBeenCalledWith({
			scope: "group",
			openid: "G_OPENID",
			displayHint: "阿绫",
		} satisfies QQDiscoveredSession);
	});

	it("C2C_MESSAGE_CREATE → onDiscovered(private 会话)", async () => {
		const gw = await startFakeGateway();
		const onDiscovered = vi.fn();
		const conn = createQQGatewayConn(connOpts(gw, { onDiscovered }));
		cleanups.push(() => conn.close());
		await waitFor(() => lastIdentify(gw) !== undefined);
		gw.dispatch("C2C_MESSAGE_CREATE", { author: { user_openid: "U_OPENID" } });
		await waitFor(() => onDiscovered.mock.calls.length > 0);
		expect(onDiscovered).toHaveBeenCalledWith({ scope: "private", openid: "U_OPENID" });
	});
});

describe("createQQGatewayConn — 心跳与重连", () => {
	it("按 heartbeat_interval 发 op1 心跳帧", async () => {
		const gw = await startFakeGateway({ heartbeatInterval: 30 });
		const conn = createQQGatewayConn(connOpts(gw));
		cleanups.push(() => conn.close());
		await waitFor(() => gw.received.some((f) => f.op === QQ_OPCODE.HEARTBEAT));
		expect(gw.received.some((f) => f.op === QQ_OPCODE.HEARTBEAT)).toBe(true);
	});

	it("僵尸连接(无 ACK)→ 关闭并重连(出现第二条连接)", async () => {
		const gw = await startFakeGateway({ heartbeatInterval: 25 });
		const conn = createQQGatewayConn(connOpts(gw));
		cleanups.push(() => conn.close());
		// 从不回 ACK:第一次心跳后 acked=false,第二次心跳判定僵尸 → close → 重连。
		await waitFor(() => gw.conns.length >= 2, 5000);
		expect(gw.conns.length).toBeGreaterThanOrEqual(2);
	});

	it("断线重连且会话未失效 → 发 RESUME(op6) 而非重新 IDENTIFY", async () => {
		const gw = await startFakeGateway();
		const conn = createQQGatewayConn(connOpts(gw));
		cleanups.push(() => conn.close());
		await waitFor(() => lastIdentify(gw) !== undefined);
		gw.dispatch("READY", { session_id: "SID42" });
		await waitFor(() => conn.isOnline());
		// 普通断开(code 1006 < 4000)→ 不清会话 → 重连后 RESUME。
		gw.conns.at(-1)?.close();
		await waitFor(() => gw.received.some((f) => f.op === QQ_OPCODE.RESUME), 5000);
		const resume = gw.received.find((f) => f.op === QQ_OPCODE.RESUME) as {
			d: { session_id: string; seq: number };
		};
		expect(resume.d.session_id).toBe("SID42");
	});

	it("close() → 离线且不再重连", async () => {
		const gw = await startFakeGateway();
		const conn = createQQGatewayConn(connOpts(gw));
		await waitFor(() => lastIdentify(gw) !== undefined);
		conn.close();
		expect(conn.isOnline()).toBe(false);
		const before = gw.conns.length;
		await sleep(80);
		expect(gw.conns.length).toBe(before); // 没有新连接
	});
});
