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
import { createFakeBridge, type FakeBridge, PROTOCOL } from "../fake-bridge.js";

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
			// 版本从假桥那一格来,这里不抄字面值 —— 抄了就是「每次改版本顺手改测试」,
			// 而版本该跟桥的 contract.ts 对齐,那件事由 fake-bridge-protocol-version.test.ts 钉。
			protocol: { ...PROTOCOL },
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

	/**
	 * 🔴 图标是 1.2 加的一格,只认 `data:image/…;base64,` 的 data URL。假桥造不出它的话,
	 * 「bot 行左边那枚方块」这条路在真机之前一次都走不到。
	 */
	it("bot 的平台图标一起报上去 —— 面板那枚方块的料就在这一格", async () => {
		const icon = `data:image/png;base64,${"A".repeat(16)}`;
		bridge = fake({ bots: [{ botId: "bot-1", platform: "telegram", icon }] });
		await bridge.ready();

		const reported = frames[0]?.bots as { icon?: string }[] | undefined;
		expect(reported?.[0]?.icon).toBe(icon);
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

	/**
	 * 分享卡里的链接是 1.4 那两格(协议 §5.3)。假桥报不出它们的话,「群里转一张卡」那条
	 * 路在真机之前一次都走不到 —— 而两格**分开**正是小程序卡不被回一张重复卡的原因。
	 */
	it("群那一支带上 1.4 的两格卡链接 → 原样进帧", async () => {
		bridge = fake();
		await bridge.ready();

		bridge.sendInbound({
			scope: "group",
			groupId: "g1",
			userId: "10086",
			text: "",
			cardLinks: ["https://b23.tv/aaa"],
			miniAppCardLinks: ["https://b23.tv/bbb"],
		});
		expect((await nextFrame("inbound")).message).toEqual({
			scope: "group",
			groupId: "g1",
			userId: "10086",
			text: "",
			cardLinks: ["https://b23.tv/aaa"],
			miniAppCardLinks: ["https://b23.tv/bbb"],
		});
	});

	/** 不给就**不出现在帧里** —— 那正是老桥(1.3)的样子,BN 那头得照收。 */
	it("群那一支不给卡链接 → 帧里连这两格都没有", async () => {
		bridge = fake();
		await bridge.ready();

		bridge.sendInbound({ scope: "group", groupId: "g1", userId: "10086", text: "看看 b23.tv/x" });
		expect((await nextFrame("inbound")).message).toEqual({
			scope: "group",
			groupId: "g1",
			userId: "10086",
			text: "看看 b23.tv/x",
		});
	});

	/**
	 * 🔴 **握完手之后名单还会再来一份**:真插件探完能力(小程序卡那一格是唯一探得出来的)
	 * 就重推一份全量快照。假桥没有这个口的话,「能力矩阵会不会跟着换」在真机之前钉不住。
	 */
	it("握完手再推一份全量名单 —— 真插件探完能力就是这么做的", async () => {
		bridge = fake();
		await bridge.ready();

		bridge.pushBots([
			{ botId: "bot-1", platform: "telegram", capabilities: { miniAppCard: "supported" } },
		]);
		expect(await nextFrame("bots")).toEqual({
			type: "bots",
			bots: [{ botId: "bot-1", platform: "telegram", capabilities: { miniAppCard: "supported" } }],
		});
	});

	it("还没握上手就推名单 → 明说没推上去(别假装成功)", () => {
		bridge = fake();
		expect(() => bridge?.pushBots([{ botId: "bot-1", platform: "telegram" }])).toThrow(/没连上/);
	});

	/** 🔴 还没握完手就驮 → 说清楚这条没发出去,别扔个 readyState 出来、把消息悄悄丢了。 */
	it("还没连上就驮 → 明说没发出去", () => {
		bridge = fake();
		expect(() => bridge?.sendInbound({ scope: "private", userId: "1", text: "帮助" })).toThrow(
			/没连上/,
		);
	});
});
