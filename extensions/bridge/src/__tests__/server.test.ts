/**
 * WS 端点 —— 桥连进来的那条长连接。
 *
 * 这一层的每一条都是**协议里写死的承诺**,所以每条都拿真 socket 验(而不是调一个纯函数):
 * 断连码是插件用来决定「要不要重连」的唯一依据,握手超时是不给未鉴权的空连接占位子的
 * 唯一手段,「新的赢」是用户误开两份插件时不至于卡死的唯一出路 —— 这些都只在真连上
 * 才成立,mock 掉 socket 等于什么都没证。
 */

import { createServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { WebSocket } from "ws";
import { BRIDGE_CLOSE_CODES, BRIDGE_PROTOCOL_VERSION } from "../contract.js";
import {
	type BridgeServer,
	type BridgeSession,
	bridgeOrigin,
	bridgeRemoteAddress,
	createBridgeServer,
} from "../server.js";

const CONNECTION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOKEN = "good-token";

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * 把桥接上一台真 HTTP server —— **宿主做的就是这件事**:按 `/ext/<id>` 前缀挑出属于它的
 * upgrade,剥掉前缀,把剩下那一段连同三样原料交过来(见 `extensions/upgrade.ts`)。
 */
function serve(httpServer: HttpServer, server: BridgeServer): void {
	httpServer.removeAllListeners("upgrade");
	httpServer.on("upgrade", (req, socket, head) => {
		const path = (req.url ?? "").replace(/^\/ext\/bridge/, "").split("?")[0] ?? "";
		server.upgrade({ req, socket, head, path });
	});
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
function peer(port: number, token: string | null, path = "") {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/ext/bridge${path}`, {
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

function fakeReq(over: {
	headers?: Record<string, string | string[]>;
	socket?: Record<string, unknown>;
}): IncomingMessage {
	return {
		headers: over.headers ?? {},
		socket: { localAddress: "127.0.0.1", localPort: 8787, ...over.socket },
	} as unknown as IncomingMessage;
}

/**
 * 取图 URL 的地址从哪儿来。BN **不知道**别人从哪个地址找得到它(NAS / 反代 / Docker
 * 端口映射各不相同),猜错的症状是「那条消息没有图」而且一声不吭 —— 平台去拉图失败是
 * 静默的。桥刚刚成功连上时用的 `Host`,是唯一一个已被证实可达的答案。
 */
describe("bridgeOrigin", () => {
	it("就是桥连进来时用的那个 Host", () => {
		expect(bridgeOrigin(fakeReq({ headers: { host: "192.168.1.5:8787" } }))).toBe(
			"http://192.168.1.5:8787",
		);
	});

	it("反代说是 https 就是 https —— 不然图 URL 会被浏览器 / 平台按混合内容拦掉", () => {
		expect(
			bridgeOrigin(fakeReq({ headers: { host: "bn.example.com", "x-forwarded-proto": "https" } })),
		).toBe("https://bn.example.com");
	});

	it("串了好几层反代时取最外面那一跳", () => {
		expect(
			bridgeOrigin(
				fakeReq({ headers: { host: "bn.example.com", "x-forwarded-proto": "https, http" } }),
			),
		).toBe("https://bn.example.com");
	});

	it("直接 TLS 连进来的算 https", () => {
		expect(
			bridgeOrigin(fakeReq({ headers: { host: "bn:8787" }, socket: { encrypted: true } })),
		).toBe("https://bn:8787");
	});

	it("没有 Host(协议其实不允许)→ 退到这条 socket 的本地地址,IPv6 要加方括号", () => {
		expect(bridgeOrigin(fakeReq({ socket: { localAddress: "::1", localPort: 9000 } }))).toBe(
			"http://[::1]:9000",
		);
	});
});

describe("bridgeRemoteAddress", () => {
	it("直连就是 socket 对端", () => {
		expect(bridgeRemoteAddress(fakeReq({ socket: { remoteAddress: "192.168.1.5" } }))).toBe(
			"192.168.1.5",
		);
	});

	it("IPv4 走在 IPv6 栈上时剥掉 ::ffff: 那层壳 —— 对人没有意义", () => {
		expect(bridgeRemoteAddress(fakeReq({ socket: { remoteAddress: "::ffff:192.168.1.5" } }))).toBe(
			"192.168.1.5",
		);
	});

	it("反代后面取 X-Forwarded-For 的第一跳,不是反代自己", () => {
		expect(
			bridgeRemoteAddress(
				fakeReq({
					headers: { "x-forwarded-for": "10.0.0.7, 172.17.0.1" },
					socket: { remoteAddress: "172.17.0.1" },
				}),
			),
		).toBe("10.0.0.7");
	});

	it("什么都拿不到就是没有,不编一个", () => {
		expect(bridgeRemoteAddress(fakeReq({}))).toBeUndefined();
	});
});

describe("/bridge 端点", () => {
	let httpServer: HttpServer;
	let port: number;
	let server: BridgeServer;
	let peers: Peer[];
	let inboundFrames: unknown[];
	let inboundSessions: BridgeSession[];
	let botsCalls: { linkId: string; bots: readonly unknown[] }[];
	let sockets: Socket[];

	async function boot(over: Partial<Parameters<typeof createBridgeServer>[0]> = {}) {
		server?.dispose();
		server = createBridgeServer({
			logger: SILENT,
			serverVersion: "9.9.9",
			resolveToken: (token) => (token === TOKEN ? CONNECTION_ID : null),
			inbound: () => ({ private: true, group: "with-links" }),
			handshakeTimeoutMs: 20_000,
			heartbeatIntervalMs: 0,
			onInbound: (session, frame) => {
				inboundSessions.push(session);
				inboundFrames.push(frame);
			},
			onBots: (linkId, bots) => botsCalls.push({ linkId, bots }),
			...over,
		});
		serve(httpServer, server);
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
		inboundSessions = [];
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

	/**
	 * 挂载点底下**还有别的路**(取图口是 `/blob/<id>`),只有根那一条是 WS。从前这一层
	 * 自己比对绝对路径 `/bridge`;现在宿主已经按前缀分过,它只需要认「剩下的那一段」。
	 *
	 * 「同前缀的**名字**不是它」(`/ext/bridgefoo`)那一半跟着搬去了宿主 —— 分段是
	 * `extensions/upgrade.ts` 的活,由它自己的 `upgrade.test.ts` 钉着。这一层收到 `path`
	 * 时前缀已经剥掉了,再在这儿比一次只会比出一个假的安心。
	 */
	it("挂载点底下的别的路径不是 WS —— 回 404,不是把 socket 吊着", async () => {
		const p = peer(port, TOKEN, "/blob/abc");
		peers.push(p);
		expect(await p.waitRejected()).toBe(404);
	});

	it("**没挂上 HTTP server 就不收连接** —— 那时它根本收不到 upgrade", async () => {
		httpServer.removeAllListeners("upgrade");
		const p = join();
		// 没人应答 upgrade:既不会开成 WS,也不会收到 HTTP 拒绝。
		await new Promise((r) => setTimeout(r, 40));
		expect(p.socket.readyState).not.toBe(WebSocket.OPEN);
		expect(server.sessionCount).toBe(0);
	});

	it("没有 Authorization 头 → upgrade 401,连 WS 都不给开", async () => {
		expect(await join(null).waitRejected()).toBe(401);
	});

	it("token 认不出 → 401", async () => {
		expect(await join("wrong").waitRejected()).toBe(401);
	});

	it("认得这个 token、只是眼下不收 → **503 不是 401**:插件据此退避重连而不是当配置错", async () => {
		await boot({ accepts: () => false });
		expect(await join().waitRejected()).toBe(503);
		expect(server.sessionCount).toBe(0);
	});

	it("不收的判断是**现读**的 —— 用户把开关拨回来,下一次重连就进得来", async () => {
		let on = false;
		await boot({ accepts: () => on });
		expect(await join().waitRejected()).toBe(503);
		on = true;
		await handshaken();
		expect(server.sessionCount).toBe(1);
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
			markdown: "unknown",
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
		expect(botsCalls.at(-1)?.linkId).toBe(CONNECTION_ID);
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

	it("bot 带着自己的平台图标进来,会话里就有 —— 坏图标只丢图标,不丢 bot", async () => {
		const p = await handshaken();
		const icon = `data:image/png;base64,${"A".repeat(64)}`;
		p.send({
			type: "bots",
			bots: [
				{ botId: "b1", platform: "telegram", icon },
				{ botId: "b2", platform: "kook", icon: "https://example.com/kook.png" },
			],
		});
		await new Promise((r) => setTimeout(r, 30));
		const bots = server.getSession(CONNECTION_ID)?.bots ?? [];
		expect(bots.map((b) => [b.botId, b.icon])).toEqual([
			["b1", icon],
			["b2", undefined],
		]);
	});

	it("交上去的是整个会话 —— 归一化要拿名单查 selfId,再回头 getSession 就多一条丢消息的路", async () => {
		const p = await handshaken();
		p.send({ type: "bots", bots: [{ botId: "b1", platform: "telegram", selfId: "77770000" }] });
		p.send({
			type: "inbound",
			botId: "b1",
			platform: "telegram",
			message: { scope: "group", groupId: "-100", userId: "u1", text: "http://b23.tv/x" },
		});
		await new Promise((r) => setTimeout(r, 30));
		expect(inboundSessions.at(-1)?.linkId).toBe(CONNECTION_ID);
		expect(inboundSessions.at(-1)?.bots.map((b) => b.selfId)).toEqual(["77770000"]);
	});

	it("会话记着桥是从哪个地址连进来的 —— 取图 URL 拿它拼", async () => {
		await handshaken();
		expect(server.getSession(CONNECTION_ID)?.origin).toBe(`http://127.0.0.1:${port}`);
	});

	/**
	 * 面板上那句「来自 192.168.1.5」:两条接入都叫「家里那台」时,主人靠它分辨哪条是哪台。
	 * 与 `origin` 是两个方向 —— 那个是桥连到了**我们的**哪个地址,这个是桥**自己**在哪。
	 */
	it("会话也记着桥是从哪台机器来的", async () => {
		await handshaken();
		expect(server.getSession(CONNECTION_ID)?.remoteAddress).toBe("127.0.0.1");
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

	// ---- 探活:面板那颗「测试」按钮 -------------------------------------------

	/**
	 * 「上次测试 OK · 0ms」是假的:老 probe 只查名单不打网络。真值得是一趟 ping → pong
	 * 的往返;协议 1.3 给 `ping` 加可选 `id`、`pong` 原样回,同一条 socket 上心跳的 pong
	 * 与探活的 pong 才分得开。
	 */
	it("ping():带 id 的 ping,桥回带 id 的 pong → 报的是这一趟的往返时长", async () => {
		await boot({ heartbeatIntervalMs: 0 });
		const p = await handshaken();
		p.socket.on("message", (raw) => {
			const frame = JSON.parse(raw.toString("utf8")) as { type?: string; id?: string };
			if (frame.type === "ping" && frame.id) {
				setTimeout(() => p.send({ type: "pong", id: frame.id }), 30);
			}
		});
		const outcome = await server.ping(CONNECTION_ID);
		expect(outcome).toMatchObject({ ok: true });
		expect(outcome.latencyMs).toBeGreaterThanOrEqual(25);
	});

	it("ping():1.2 的老桥回的 pong 不带 id → 也认(最早那趟 ping 收下它)", async () => {
		await boot({ heartbeatIntervalMs: 0 });
		const p = await handshaken();
		p.socket.on("message", (raw) => {
			const frame = JSON.parse(raw.toString("utf8")) as { type?: string };
			if (frame.type === "ping") p.send({ type: "pong" });
		});
		expect(await server.ping(CONNECTION_ID)).toMatchObject({ ok: true });
	});

	it("ping():桥不回 → 超时报错,不挂死", async () => {
		await boot({ heartbeatIntervalMs: 0, pingTimeoutMs: 40 });
		await handshaken();
		const outcome = await server.ping(CONNECTION_ID);
		expect(outcome.ok).toBe(false);
		expect(outcome.err).toMatch(/pong/);
	});

	it("ping():桥没连着 → 直接不通", async () => {
		expect(await server.ping("nobody")).toMatchObject({ ok: false });
	});

	it("心跳:不回 pong → 踢掉,会话清干净", async () => {
		await boot({ heartbeatIntervalMs: 30, heartbeatTimeoutMs: 60 });
		const p = await handshaken();
		await new Promise((r) => setTimeout(r, 250));
		expect(p.socket.readyState).not.toBe(WebSocket.OPEN);
		expect(server.sessionCount).toBe(0);
	});

	// ---- 发消息与回执 ------------------------------------------------------

	const sendRequest = {
		botId: "b1",
		platform: "telegram",
		target: { scope: "group" as const, address: "-100" },
		message: { kind: "text" as const, text: "开播啦" },
	};

	it("send 把帧发出去(带一个自己生成的 id),回执回来才落地", async () => {
		const p = await handshaken();
		const pending = server.send(CONNECTION_ID, sendRequest);
		const frame = await p.next();
		expect(frame).toMatchObject({ type: "send", ...sendRequest });
		expect(typeof frame.id).toBe("string");
		p.send({ type: "result", id: frame.id, ok: true });
		expect(await pending).toEqual({ ok: true });
	});

	it("回执报失败 → **回 ok:false,不抛** —— 上面那层要的是投递结果不是异常", async () => {
		const p = await handshaken();
		const pending = server.send(CONNECTION_ID, sendRequest);
		const frame = await p.next();
		p.send({ type: "result", id: frame.id, ok: false, err: "bot 掉线了" });
		expect(await pending).toEqual({ ok: false, err: "bot 掉线了" });
	});

	it("桥不回 → 超时后失败,而不是永远吊着", async () => {
		await boot({ sendTimeoutMs: 40 });
		const p = await handshaken();
		const outcome = await server.send(CONNECTION_ID, sendRequest);
		expect(outcome.ok).toBe(false);
		expect(outcome.err).toContain("回执");
		expect(p.socket.readyState).toBe(WebSocket.OPEN);
	});

	it("超时之后回执才来 → 忽略,不炸也不断连", async () => {
		await boot({ sendTimeoutMs: 40 });
		const p = await handshaken();
		const pending = server.send(CONNECTION_ID, sendRequest);
		const frame = await p.next();
		await pending;
		p.send({ type: "result", id: frame.id, ok: true });
		await new Promise((r) => setTimeout(r, 30));
		expect(p.socket.readyState).toBe(WebSocket.OPEN);
	});

	it("桥不认得的 id → 忽略,不断连(这不是畸形帧)", async () => {
		const p = await handshaken();
		p.send({ type: "result", id: "凭空捏造", ok: true });
		await new Promise((r) => setTimeout(r, 30));
		expect(p.socket.readyState).toBe(WebSocket.OPEN);
	});

	it("**桥断线 → 在飞的立刻失败**,不排队不补推(推一条三小时前的开播比不推更糟)", async () => {
		const p = await handshaken();
		const pending = server.send(CONNECTION_ID, sendRequest);
		await p.next();
		p.socket.terminate();
		const outcome = await pending;
		expect(outcome.ok).toBe(false);
		expect(outcome.err).toBeTruthy();
	});

	it("桥没连着 → 立刻失败,不等超时", async () => {
		const started = Date.now();
		const outcome = await server.send(CONNECTION_ID, sendRequest);
		expect(outcome.ok).toBe(false);
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("两条同时在飞,各拿各的回执 —— id 不许串", async () => {
		const p = await handshaken();
		const first = server.send(CONNECTION_ID, sendRequest);
		const second = server.send(CONNECTION_ID, { ...sendRequest, botId: "b2" });
		const a = await p.next();
		const b = await p.next();
		expect(a.id).not.toBe(b.id);
		// 故意倒着回,证明配对靠 id 不靠顺序。
		p.send({ type: "result", id: b.id, ok: false, err: "第二条炸了" });
		p.send({ type: "result", id: a.id, ok: true });
		expect(await first).toEqual({ ok: true });
		expect(await second).toEqual({ ok: false, err: "第二条炸了" });
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
