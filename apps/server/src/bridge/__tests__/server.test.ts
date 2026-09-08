/**
 * `/bridge` 端点 —— 桥连进来的那条长连接。
 *
 * 这一层的每一条都是**协议里写死的承诺**,所以每条都拿真 socket 验(而不是调一个纯函数):
 * 断连码是插件用来决定「要不要重连」的唯一依据,握手超时是不给未鉴权的空连接占位子的
 * 唯一手段,「新的赢」是用户误开两份插件时不至于卡死的唯一出路 —— 这些都只在真连上
 * 才成立,mock 掉 socket 等于什么都没证。
 */

import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { BRIDGE_CLOSE_CODES, BRIDGE_PROTOCOL_VERSION } from "@bilibili-notify/contract";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { WebSocket } from "ws";
import type { NodeServiceContext } from "../../runtime/service-context.js";
import { type BridgeServer, createBridgeServer } from "../server.js";

const CONNECTION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOKEN = "good-token";

function fakeServiceCtx(): NodeServiceContext {
	return {
		logger: { info() {}, warn() {}, error() {}, debug() {} },
	} as unknown as NodeServiceContext;
}

function helloFrame(over: Record<string, unknown> = {}) {
	return {
		type: "hello",
		protocol: { ...BRIDGE_PROTOCOL_VERSION },
		bridge: { kind: "koishi", name: "家里那台", version: "0.1.0" },
		bots: [{ botId: "b1", platform: "telegram", capabilities: { atAll: "unsupported" } }],
		...over,
	};
}

/** 一个假桥 —— 把帧、关闭码、upgrade 的 HTTP 状态都攒起来,好让测试等它们。 */
function peer(port: number, token: string | null) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`, {
		headers: token === null ? {} : { Authorization: `Bearer ${token}` },
	});
	const frames: Record<string, unknown>[] = [];
	let frameWaiter: ((f: Record<string, unknown>) => void) | null = null;
	let closeCode: number | null = null;
	let closeWaiter: ((c: number) => void) | null = null;
	let httpStatus: number | null = null;
	let statusWaiter: ((s: number) => void) | null = null;

	socket.on("message", (raw) => {
		const frame = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
		if (frameWaiter) {
			const w = frameWaiter;
			frameWaiter = null;
			w(frame);
		} else frames.push(frame);
	});
	socket.on("close", (code) => {
		closeCode = code;
		closeWaiter?.(code);
	});
	socket.on("unexpected-response", (_req, res) => {
		httpStatus = res.statusCode ?? 0;
		statusWaiter?.(httpStatus);
		socket.terminate();
	});
	// upgrade 被拒时 ws 也会 emit error;不监听会变成 unhandled。
	socket.on("error", () => {});

	return {
		socket,
		send(frame: unknown) {
			socket.send(JSON.stringify(frame));
		},
		open(): Promise<void> {
			if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
			return new Promise((resolve, reject) => {
				socket.once("open", () => resolve());
				socket.once("error", reject);
			});
		},
		next(): Promise<Record<string, unknown>> {
			const buffered = frames.shift();
			if (buffered) return Promise.resolve(buffered);
			return new Promise((resolve) => {
				frameWaiter = resolve;
			});
		},
		waitClose(): Promise<number> {
			if (closeCode !== null) return Promise.resolve(closeCode);
			return new Promise((resolve) => {
				closeWaiter = resolve;
			});
		},
		waitRejected(): Promise<number> {
			if (httpStatus !== null) return Promise.resolve(httpStatus);
			return new Promise((resolve) => {
				statusWaiter = resolve;
			});
		},
		dispose() {
			try {
				socket.terminate();
			} catch {
				// already gone
			}
		},
	};
}

type Peer = ReturnType<typeof peer>;

describe("/bridge 端点", () => {
	let httpServer: HttpServer;
	let port: number;
	let server: BridgeServer;
	let peers: Peer[];
	let inboundFrames: unknown[];
	let botsCalls: { connectionId: string; bots: readonly unknown[] }[];
	let sockets: Socket[];

	async function boot(over: Partial<Parameters<typeof createBridgeServer>[0]> = {}) {
		server?.dispose();
		server = createBridgeServer({
			httpServer,
			serviceCtx: fakeServiceCtx(),
			serverVersion: "9.9.9",
			resolveToken: (token) => (token === TOKEN ? CONNECTION_ID : null),
			inbound: () => ({ private: true, group: "with-links" }),
			handshakeTimeoutMs: 20_000,
			heartbeatIntervalMs: 0,
			onInbound: (_id, frame) => inboundFrames.push(frame),
			onBots: (connectionId, bots) => botsCalls.push({ connectionId, bots }),
			...over,
		});
	}

	function join(token: string | null = TOKEN): Peer {
		const p = peer(port, token);
		peers.push(p);
		return p;
	}

	/** 连上 + 握手 + 收下 welcome,后面大部分用例的起点。 */
	async function handshaken(): Promise<Peer> {
		const p = join();
		await p.open();
		p.send(helloFrame());
		await p.next();
		return p;
	}

	beforeEach(async () => {
		peers = [];
		inboundFrames = [];
		botsCalls = [];
		sockets = [];
		httpServer = createServer((_req, res) => res.end());
		// 没人应答的 upgrade 会把 socket 挂在那儿(而且 upgrade 之后它已经不在 server 的
		// 连接表里,closeAllConnections 摘不掉),close() 会一直等 —— 自己攒着自己掐。
		httpServer.on("connection", (socket) => sockets.push(socket));
		await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
		port = (httpServer.address() as AddressInfo).port;
		await boot();
	});

	afterEach(async () => {
		for (const p of peers) p.dispose();
		server.dispose();
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => httpServer.close(() => resolve()));
	});

	// ---- 鉴权在 upgrade ----------------------------------------------------

	it("没有 Authorization 头 → upgrade 401,连 WS 都不给开", async () => {
		expect(await join(null).waitRejected()).toBe(401);
	});

	it("token 认不出 → 401", async () => {
		expect(await join("wrong").waitRejected()).toBe(401);
	});

	// ---- 握手 --------------------------------------------------------------

	it("握手成功 → welcome 带协议版本、独立端版本、入站订阅", async () => {
		const p = join();
		await p.open();
		p.send(helloFrame());
		expect(await p.next()).toEqual({
			type: "welcome",
			protocol: { ...BRIDGE_PROTOCOL_VERSION },
			server: { version: "9.9.9" },
			inbound: { private: true, group: "with-links" },
		});
	});

	it("握手之后 getSession 认得这条桥,带 bot 名单与桥自报的元信息", async () => {
		await handshaken();
		const session = server.getSession(CONNECTION_ID);
		expect(session?.kind).toBe("koishi");
		expect(session?.name).toBe("家里那台");
		expect(session?.version).toBe("0.1.0");
		expect(session?.bots.map((b) => b.botId)).toEqual(["b1"]);
	});

	it("**能力在这一层就归一** —— 桥少报的补成 unknown,业务层看不到缺口", async () => {
		await handshaken();
		const caps = server.getSession(CONNECTION_ID)?.bots[0]?.capabilities;
		expect(caps).toEqual({
			atAll: "unsupported",
			inbound: "unknown",
			forward: "unknown",
			miniAppCard: "unknown",
			shareCardLinks: "unknown",
		});
	});

	it("迟迟不发 hello → 断连 4004,不给未鉴权的空连接占位子", async () => {
		await boot({ handshakeTimeoutMs: 40 });
		const p = join();
		await p.open();
		expect(await p.waitClose()).toBe(BRIDGE_CLOSE_CODES.handshakeTimeout);
		expect(server.sessionCount).toBe(0);
	});

	it("协议 major 对不上 → 断连 4002,**且不发 welcome**", async () => {
		const p = join();
		await p.open();
		p.send(helloFrame({ protocol: { major: BRIDGE_PROTOCOL_VERSION.major + 1, minor: 0 } }));
		expect(await p.waitClose()).toBe(BRIDGE_CLOSE_CODES.incompatibleProtocol);
		expect(server.sessionCount).toBe(0);
	});

	it("minor 差多少都连得上 —— 不然加个可选字段就得逼所有插件同时发版", async () => {
		const p = join();
		await p.open();
		p.send(helloFrame({ protocol: { major: BRIDGE_PROTOCOL_VERSION.major, minor: 99 } }));
		expect((await p.next()).type).toBe("welcome");
	});

	it("第一帧不是 hello → 断连 4003", async () => {
		const p = join();
		await p.open();
		p.send({ type: "pong" });
		expect(await p.waitClose()).toBe(BRIDGE_CLOSE_CODES.badFrame);
	});

	it("hello 发第二次 → 断连 4003(它是第一帧,且只此一次)", async () => {
		const p = await handshaken();
		p.send(helloFrame());
		expect(await p.waitClose()).toBe(BRIDGE_CLOSE_CODES.badFrame);
	});

	// ---- 演进纪律 ----------------------------------------------------------

	it("**不认识的帧忽略,连接照旧活着** —— 桥比 BN 新时不该被打死", async () => {
		const p = await handshaken();
		p.send({ type: "telemetry", whatever: 1 });
		p.send({ type: "bots", bots: [{ botId: "b2", platform: "discord" }] });
		await new Promise((r) => setTimeout(r, 30));
		expect(p.socket.readyState).toBe(WebSocket.OPEN);
		expect(server.getSession(CONNECTION_ID)?.bots.map((b) => b.botId)).toEqual(["b2"]);
	});

	it("认识但畸形的帧 → 断连 4003(这不叫新帧,叫垃圾)", async () => {
		const p = await handshaken();
		p.send({ type: "inbound", botId: "b1" });
		expect(await p.waitClose()).toBe(BRIDGE_CLOSE_CODES.badFrame);
	});

	// ---- 会话 --------------------------------------------------------------

	it("bots 帧是**全量快照** —— 整份换掉,不是并进去", async () => {
		const p = await handshaken();
		p.send({ type: "bots", bots: [{ botId: "b2", platform: "discord" }] });
		await new Promise((r) => setTimeout(r, 30));
		expect(server.getSession(CONNECTION_ID)?.bots.map((b) => b.botId)).toEqual(["b2"]);
		expect(botsCalls.at(-1)?.connectionId).toBe(CONNECTION_ID);
	});

	it("入站帧交给上面,原样带着 botId 与 platform", async () => {
		const p = await handshaken();
		p.send({
			type: "inbound",
			botId: "b1",
			platform: "telegram",
			message: { scope: "private", userId: "u1", text: "订阅列表" },
		});
		await new Promise((r) => setTimeout(r, 30));
		expect(inboundFrames).toEqual([
			{
				type: "inbound",
				botId: "b1",
				platform: "telegram",
				message: { scope: "private", userId: "u1", text: "订阅列表" },
			},
		]);
	});

	it("同一个 token 又连进来一条 → **新的赢**,老的收 4006", async () => {
		const first = await handshaken();
		const second = await handshaken();
		expect(await first.waitClose()).toBe(BRIDGE_CLOSE_CODES.replaced);
		expect(server.sessionCount).toBe(1);
		expect(second.socket.readyState).toBe(WebSocket.OPEN);
	});

	it("新连接**握手成功之后**才踢老的 —— 版本不对的重连不该干掉正在用的那条", async () => {
		const first = await handshaken();
		const second = join();
		await second.open();
		second.send(helloFrame({ protocol: { major: BRIDGE_PROTOCOL_VERSION.major + 1, minor: 0 } }));
		expect(await second.waitClose()).toBe(BRIDGE_CLOSE_CODES.incompatibleProtocol);
		expect(first.socket.readyState).toBe(WebSocket.OPEN);
		expect(server.getSession(CONNECTION_ID)).toBeDefined();
	});

	it("disconnect() 按给的码把桥踢下线(吊销 / 删接入 / 关模块共用)", async () => {
		const p = await handshaken();
		server.disconnect(CONNECTION_ID, BRIDGE_CLOSE_CODES.revoked);
		expect(await p.waitClose()).toBe(BRIDGE_CLOSE_CODES.revoked);
		expect(server.getSession(CONNECTION_ID)).toBeUndefined();
	});

	it("桥自己断开 → 会话清掉", async () => {
		const p = await handshaken();
		expect(server.sessionCount).toBe(1);
		p.socket.close();
		await new Promise((r) => setTimeout(r, 50));
		expect(server.sessionCount).toBe(0);
	});

	// ---- 心跳 --------------------------------------------------------------

	it("心跳:回 pong 就一直活着", async () => {
		await boot({ heartbeatIntervalMs: 30, heartbeatTimeoutMs: 200 });
		const p = await handshaken();
		p.socket.on("message", (raw) => {
			const frame = JSON.parse(raw.toString("utf8")) as { type?: string };
			if (frame.type === "ping") p.send({ type: "pong" });
		});
		await new Promise((r) => setTimeout(r, 150));
		expect(p.socket.readyState).toBe(WebSocket.OPEN);
	});

	it("心跳:不回 pong → 踢掉,会话清干净", async () => {
		await boot({ heartbeatIntervalMs: 30, heartbeatTimeoutMs: 60 });
		const p = await handshaken();
		await new Promise((r) => setTimeout(r, 250));
		expect(p.socket.readyState).not.toBe(WebSocket.OPEN);
		expect(server.sessionCount).toBe(0);
	});

	// ---- 共存与收摊 --------------------------------------------------------

	it("别的路径的 upgrade **不吃掉** —— dashboard 那条 /ws 还得有人接", async () => {
		let sawOther = false;
		httpServer.on("upgrade", (req, socket) => {
			if (req.url?.startsWith("/ws")) {
				sawOther = true;
				socket.destroy();
			}
		});
		const stray = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		stray.on("error", () => {});
		await new Promise((r) => setTimeout(r, 50));
		expect(sawOther).toBe(true);
		stray.terminate();
	});

	/**
	 * `/bridge/blob/<id>` 是**取图口**,一条普通 HTTP GET。前缀匹配会把它也算成本端点的
	 * 地盘 —— 今天没人往那儿发 upgrade 所以看不出来,等取图口落地就是一处静默错认。
	 * `/bridgefoo` 同理:一个能被前缀吃掉的名字就是一个能被冒名的端点。
	 */
	it("只认 /bridge 本身 —— 子路径与同前缀的名字都不是它", async () => {
		for (const url of ["/bridge/blob/abc", "/bridgefoo"]) {
			// 拿**对的 token** 去连,把变量压到只剩路径这一个。
			const stray = new WebSocket(`ws://127.0.0.1:${port}${url}`, {
				headers: { Authorization: `Bearer ${TOKEN}` },
			});
			stray.on("error", () => {});
			await new Promise((r) => setTimeout(r, 60));
			// 桥没伸手 → 没人应答这条 upgrade → 永远握不上手。伸手了就会是 OPEN。
			expect(stray.readyState, url).not.toBe(WebSocket.OPEN);
			stray.terminate();
		}
	});

	it("dispose() 关掉在连的桥、并摘掉 upgrade 处理器", async () => {
		const p = await handshaken();
		server.dispose();
		await p.waitClose();
		expect(server.sessionCount).toBe(0);
		// 摘干净了就没人应答这条 upgrade,连不上。
		const after = join();
		await expect(after.open()).rejects.toBeTruthy();
	});
});
