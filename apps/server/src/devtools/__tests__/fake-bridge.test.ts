/**
 * 假桥客户端 —— 它说的是**桥那套协议**,而桥是个拓展,核心 import 不到它。
 *
 * 所以这一层的帧是**照着 `extensions/bridge/PROTOCOL.md` 手写的**(主人 2026-09-10 拍板
 * 认下这笔:见 ADR-0012 决策 42)。手写的东西会漂,所以两道都要:这条测试钉「帧长什么样」,
 * `__tests__/devtools-fake-bridge-e2e.test.ts` 把真桥装进装载根、让它俩真的说一次话。
 */

import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { type WebSocket, WebSocketServer } from "ws";
import { createFakeBridge, type FakeBridge } from "../fake-bridge.js";

const TOKEN = "fake-bridge-token";

let httpServer: HttpServer;
let wss: WebSocketServer;
let port: number;
let bridge: FakeBridge | undefined;
/** 端点收到的帧,按到达顺序。 */
let frames: Record<string, unknown>[];
let authHeaders: (string | undefined)[];
let sockets: WebSocket[];
/** 不给开 upgrade 时回的状态码;null = 照常开。 */
let refuse: number | null;

function nextFrame(type: string, timeoutMs = 1000): Promise<Record<string, unknown>> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const tick = () => {
			const hit = frames.find((f) => f.type === type);
			if (hit) return resolve(hit);
			if (Date.now() > deadline) return reject(new Error(`没等到 ${type} 帧`));
			setTimeout(tick, 5);
		};
		tick();
	});
}

function send(socket: WebSocket, frame: unknown): void {
	socket.send(JSON.stringify(frame));
}

/** 端点这一侧照协议回一句 welcome —— 握手要两边都动才算成。 */
function welcome(socket: WebSocket): void {
	send(socket, {
		type: "welcome",
		protocol: { major: 1, minor: 1 },
		server: { version: "9.9.9-test" },
		inbound: { private: true, group: "with-links" },
	});
}

beforeEach(async () => {
	frames = [];
	authHeaders = [];
	sockets = [];
	refuse = null;
	httpServer = createServer();
	wss = new WebSocketServer({ noServer: true });
	httpServer.on("upgrade", (req, socket, head) => {
		authHeaders.push(req.headers.authorization);
		if (refuse !== null) {
			socket.write(`HTTP/1.1 ${refuse} Nope\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			sockets.push(ws);
			ws.on("message", (raw: Buffer) => {
				const frame = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
				frames.push(frame);
				if (frame.type === "hello") welcome(ws);
			});
		});
	});
	await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
	port = (httpServer.address() as AddressInfo).port;
});

afterEach(async () => {
	bridge?.dispose();
	bridge = undefined;
	for (const socket of sockets) socket.terminate();
	wss.close();
	await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

function fake(over: Partial<Parameters<typeof createFakeBridge>[0]> = {}): FakeBridge {
	return createFakeBridge({
		url: `ws://127.0.0.1:${port}/ext/bridge`,
		token: TOKEN,
		kind: "koishi",
		name: "假桥",
		bots: [
			{
				botId: "bot-1",
				platform: "telegram",
				name: "小电视",
				capabilities: { atAll: "supported", markdown: "unsupported" },
			},
		],
		receipt: () => ({ ok: true }),
		...over,
	});
}

describe("握手", () => {
	it("token 走 upgrade 的 Authorization 头,不在帧里也不在 URL 里", async () => {
		bridge = fake();
		await bridge.ready();
		expect(authHeaders).toEqual([`Bearer ${TOKEN}`]);
	});

	it("连上第一帧就是 hello,带协议版本、桥的种类与全量 bot 名单", async () => {
		bridge = fake();
		await bridge.ready();

		expect(frames[0]).toEqual({
			type: "hello",
			protocol: { major: 1, minor: 1 },
			bridge: { kind: "koishi", name: "假桥" },
			bots: [
				{
					botId: "bot-1",
					platform: "telegram",
					name: "小电视",
					capabilities: { atAll: "supported", markdown: "unsupported" },
				},
			],
		});
	});

	/** 场景要拿这句话往面板上贴 —— 「转了半天没反应」是最没用的一种失败。 */
	it("upgrade 被拒 → ready() 带着状态码炸出来", async () => {
		refuse = 401;
		bridge = fake();
		await expect(bridge.ready()).rejects.toThrow(/401/);
	});
});

describe("连着的时候", () => {
	it("BN 催一声就回一声", async () => {
		bridge = fake();
		await bridge.ready();

		send(sockets[0] as WebSocket, { type: "ping" });
		expect(await nextFrame("pong")).toEqual({ type: "pong" });
	});

	it("收到 send 就回执,回什么由 receipt 现说", async () => {
		let receipt: { ok: boolean; err?: string } = { ok: true };
		bridge = fake({ receipt: () => receipt as { ok: true } });
		await bridge.ready();

		send(sockets[0] as WebSocket, {
			type: "send",
			id: "s-1",
			botId: "bot-1",
			platform: "telegram",
			target: { scope: "group", address: "g-42" },
			message: { kind: "text", text: "开播啦" },
		});
		expect(await nextFrame("result")).toEqual({ type: "result", id: "s-1", ok: true });

		receipt = { ok: false, err: "群被禁言了" };
		frames.length = 0;
		send(sockets[0] as WebSocket, {
			type: "send",
			id: "s-2",
			botId: "bot-1",
			platform: "telegram",
			target: { scope: "group", address: "g-42" },
			message: { kind: "text", text: "再来一条" },
		});
		expect(await nextFrame("result")).toEqual({
			type: "result",
			id: "s-2",
			ok: false,
			err: "群被禁言了",
		});
	});

	/** 不认识的帧**忽略**,别炸 —— 协议里写死的演进纪律,两个方向对称。 */
	it("BN 发来一种没见过的帧 → 当没看见,连接照旧", async () => {
		bridge = fake();
		await bridge.ready();

		send(sockets[0] as WebSocket, { type: "从未来来的帧" });
		send(sockets[0] as WebSocket, { type: "ping" });
		expect(await nextFrame("pong")).toBeTruthy();
	});

	it("驮一条入站上去,平台名跟着那个 bot 走", async () => {
		bridge = fake();
		await bridge.ready();

		bridge.sendInbound({ scope: "private", userId: "10086", text: "帮助" });
		expect(await nextFrame("inbound")).toEqual({
			type: "inbound",
			botId: "bot-1",
			platform: "telegram",
			message: { scope: "private", userId: "10086", text: "帮助" },
		});
	});

	/** 🔴 还没握完手就驮 → 说清楚这条没发出去,别扔个 readyState 出来、把消息悄悄丢了。 */
	it("还没连上就驮 → 明说没发出去", () => {
		bridge = fake();
		expect(() => bridge?.sendInbound({ scope: "private", userId: "1", text: "帮助" })).toThrow(
			/没连上/,
		);
	});
});
