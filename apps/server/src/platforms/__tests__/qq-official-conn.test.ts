import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Disposable, Logger, ServiceContext } from "@bilibili-notify/internal";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { type WebSocket, WebSocketServer } from "ws";
import {
	createQQGatewayConn,
	QQ_OPCODE,
	type QQDiscoveredSession,
	type QQInboundGroupMessage,
	type QQInboundPrivateMessage,
} from "../qq-official";

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

describe("createQQGatewayConn — C2C 私聊正文(审批指令的入口)", () => {
	it("C2C_MESSAGE_CREATE → onInbound(openid + 正文)", async () => {
		const gw = await startFakeGateway();
		const onInbound = vi.fn();
		const conn = createQQGatewayConn(connOpts(gw, { onInbound }));
		cleanups.push(() => conn.close());
		await waitFor(() => lastIdentify(gw) !== undefined);
		gw.dispatch("C2C_MESSAGE_CREATE", {
			author: { user_openid: "U_OPENID" },
			content: "y",
			id: "M1",
		});
		await waitFor(() => onInbound.mock.calls.length > 0);
		expect(onInbound).toHaveBeenCalledWith({ userOpenid: "U_OPENID", text: "y", msgId: "M1" });
	});

	it("群消息不进 onInbound —— 群里打个 y 不该发出待审的周报", async () => {
		const gw = await startFakeGateway();
		const onInbound = vi.fn();
		const onDiscovered = vi.fn();
		const conn = createQQGatewayConn(connOpts(gw, { onInbound, onDiscovered }));
		cleanups.push(() => conn.close());
		await waitFor(() => lastIdentify(gw) !== undefined);
		gw.dispatch("GROUP_AT_MESSAGE_CREATE", { group_openid: "G1", content: "y" });
		// 用 onDiscovered 当节拍器:它一定会被这帧触发,到了就说明这帧处理完了。
		await waitFor(() => onDiscovered.mock.calls.length > 0);
		expect(onInbound).not.toHaveBeenCalled();
	});

	it("onInbound 抛错不能带崩连接 —— 它还担着推送", async () => {
		const gw = await startFakeGateway();
		const onInbound = vi.fn((_msg: QQInboundPrivateMessage) => {
			throw new Error("指令处理炸了");
		});
		const conn = createQQGatewayConn(connOpts(gw, { onInbound }));
		cleanups.push(() => conn.close());
		await waitFor(() => lastIdentify(gw) !== undefined);
		gw.dispatch("C2C_MESSAGE_CREATE", { author: { user_openid: "U1" }, content: "y" });
		await waitFor(() => onInbound.mock.calls.length > 0);
		// 还活着的直接证据:再来一帧照样派发到。
		gw.dispatch("C2C_MESSAGE_CREATE", { author: { user_openid: "U1" }, content: "n" });
		await waitFor(() => onInbound.mock.calls.length > 1);
		expect(onInbound.mock.calls[1]?.[0]).toEqual({ userOpenid: "U1", text: "n" });
	});
});

describe("createQQGatewayConn — 群消息正文(链接解析的入口)", () => {
	// 群主把机器人的消息范围放到「获取群内全部消息」后,不 @ 的群消息以 GROUP_MESSAGE_CREATE
	// 下发;@ 了机器人的照旧是 GROUP_AT_MESSAGE_CREATE。两种都得交出去 —— 三档范围是 QQ 那边
	// 的设置,我们这边收到什么解析什么。
	it("GROUP_MESSAGE_CREATE → onInboundGroup(群 openid + 发言者 + 正文)", async () => {
		const gw = await startFakeGateway();
		const onInboundGroup = vi.fn();
		const conn = createQQGatewayConn(connOpts(gw, { onInboundGroup }));
		cleanups.push(() => conn.close());
		await waitFor(() => lastIdentify(gw) !== undefined);
		gw.dispatch("GROUP_MESSAGE_CREATE", {
			group_openid: "G1",
			author: { member_openid: "M1", id: "M1" },
			content: "看这个 https://www.bilibili.com/video/BV1zMtU6uEEb/",
			id: "MSG1",
			timestamp: "2026-09-02T12:00:00+08:00",
		});
		await waitFor(() => onInboundGroup.mock.calls.length > 0);
		expect(onInboundGroup).toHaveBeenCalledWith({
			groupOpenid: "G1",
			memberOpenid: "M1",
			text: "看这个 https://www.bilibili.com/video/BV1zMtU6uEEb/",
		} satisfies QQInboundGroupMessage);
	});

	it("GROUP_AT_MESSAGE_CREATE 同样进 onInboundGroup;C2C 不进", async () => {
		const gw = await startFakeGateway();
		const onInboundGroup = vi.fn();
		const onDiscovered = vi.fn();
		const conn = createQQGatewayConn(connOpts(gw, { onInboundGroup, onDiscovered }));
		cleanups.push(() => conn.close());
		await waitFor(() => lastIdentify(gw) !== undefined);
		gw.dispatch("GROUP_AT_MESSAGE_CREATE", {
			group_openid: "G1",
			author: { member_openid: "M1" },
			content: " https://b23.tv/abc",
		});
		await waitFor(() => onInboundGroup.mock.calls.length > 0);
		expect(onInboundGroup).toHaveBeenCalledWith({
			groupOpenid: "G1",
			memberOpenid: "M1",
			text: " https://b23.tv/abc",
		});
		gw.dispatch("C2C_MESSAGE_CREATE", {
			author: { user_openid: "U1" },
			content: "https://b23.tv/x",
		});
		await waitFor(() => onDiscovered.mock.calls.length > 1);
		expect(onInboundGroup).toHaveBeenCalledTimes(1);
	});

	// 「全部消息」档下 GROUP_MESSAGE_CREATE 是群里每一句话。它进发现表的话,面板那份
	// 「最近优先」的列表会随人说话不停重排;入群与被 @ 两条路已经够让一个群露面。
	it("GROUP_MESSAGE_CREATE 不进发现表 —— 普通群聊不该搅动面板的会话列表", async () => {
		const gw = await startFakeGateway();
		const onDiscovered = vi.fn();
		const onInboundGroup = vi.fn();
		const conn = createQQGatewayConn(connOpts(gw, { onDiscovered, onInboundGroup }));
		cleanups.push(() => conn.close());
		await waitFor(() => lastIdentify(gw) !== undefined);
		gw.dispatch("GROUP_MESSAGE_CREATE", {
			group_openid: "G2",
			author: { member_openid: "M" },
			content: "hi",
		});
		// 用 onInboundGroup 当节拍器:这帧一定会到它那儿,到了就说明发现表那步也过去了。
		await waitFor(() => onInboundGroup.mock.calls.length > 0);
		expect(onDiscovered).not.toHaveBeenCalled();
		// 被 @ 的那条照旧进发现表。
		gw.dispatch("GROUP_AT_MESSAGE_CREATE", { group_openid: "G2", content: "@bot hi" });
		await waitFor(() => onDiscovered.mock.calls.length > 0);
		expect(onDiscovered).toHaveBeenCalledWith({ scope: "group", openid: "G2" });
	});

	it("onInboundGroup 抛错不能带崩连接", async () => {
		const gw = await startFakeGateway();
		const onInboundGroup = vi.fn((_msg: QQInboundGroupMessage) => {
			throw new Error("解析炸了");
		});
		const conn = createQQGatewayConn(connOpts(gw, { onInboundGroup }));
		cleanups.push(() => conn.close());
		await waitFor(() => lastIdentify(gw) !== undefined);
		gw.dispatch("GROUP_MESSAGE_CREATE", {
			group_openid: "G1",
			author: { member_openid: "M" },
			content: "a",
		});
		await waitFor(() => onInboundGroup.mock.calls.length > 0);
		gw.dispatch("GROUP_MESSAGE_CREATE", {
			group_openid: "G1",
			author: { member_openid: "M" },
			content: "b",
		});
		await waitFor(() => onInboundGroup.mock.calls.length > 1);
		expect(onInboundGroup.mock.calls[1]?.[0]).toEqual({
			groupOpenid: "G1",
			memberOpenid: "M",
			text: "b",
		});
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

describe("createQQGatewayConn — RECONNECT/RESUMED 日志开关", () => {
	// QQ 官方网关约每 30 分钟主动要求重连一次,属正常协议行为;默认(缺省
	// shouldLogReconnects)不应刷屏打印。
	it("缺省 shouldLogReconnects → 服务端 RECONNECT(op7)+续连 RESUMED 都不打日志", async () => {
		const gw = await startFakeGateway();
		const logger = makeLogger();
		const conn = createQQGatewayConn(connOpts(gw, { logger }));
		cleanups.push(() => conn.close());
		await waitFor(() => lastIdentify(gw) !== undefined);
		gw.dispatch("READY", { session_id: "SID" });
		await waitFor(() => conn.isOnline());

		gw.conns.at(-1)?.send(JSON.stringify({ op: QQ_OPCODE.RECONNECT }));
		await waitFor(() => gw.received.some((f) => f.op === QQ_OPCODE.RESUME), 5000);
		gw.dispatch("RESUMED", {});
		await sleep(30);

		const warned = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.flat().join(" ");
		const infoed = (logger.info as ReturnType<typeof vi.fn>).mock.calls.flat().join(" ");
		expect(warned).not.toContain("RECONNECT");
		expect(infoed).not.toContain("RESUMED");
	});

	it("shouldLogReconnects() 返回 true → 打印 RECONNECT 与 RESUMED", async () => {
		const gw = await startFakeGateway();
		const logger = makeLogger();
		const conn = createQQGatewayConn(connOpts(gw, { logger, shouldLogReconnects: () => true }));
		cleanups.push(() => conn.close());
		await waitFor(() => lastIdentify(gw) !== undefined);
		gw.dispatch("READY", { session_id: "SID" });
		await waitFor(() => conn.isOnline());

		gw.conns.at(-1)?.send(JSON.stringify({ op: QQ_OPCODE.RECONNECT }));
		await waitFor(() => gw.received.some((f) => f.op === QQ_OPCODE.RESUME), 5000);
		gw.dispatch("RESUMED", {});
		await waitFor(
			() =>
				(logger.info as ReturnType<typeof vi.fn>).mock.calls.some((c) =>
					String(c[0]).includes("RESUMED"),
				),
			5000,
		);

		const warned = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.flat().join(" ");
		const infoed = (logger.info as ReturnType<typeof vi.fn>).mock.calls.flat().join(" ");
		expect(warned).toContain("RECONNECT");
		expect(infoed).toContain("RESUMED");
	});
});
