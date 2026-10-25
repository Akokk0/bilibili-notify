/**
 * 假桥客户端 —— 它说的是**桥这套协议**,对家是桥**自己的** `createBridgeServer`:真 HTTP 服务器、
 * 真 upgrade、真握手。断言看的是端点上的真会话与真帧,不是手搭的回声。
 *
 * 假桥的网络一律走 `ctx.http`:这里的 `http` 是真 `ws` / 真 `fetch` 套的替身(`host-stand-in.ts`),
 * 外面再包一层记账,好把假桥**发出去的帧**原样看一遍。版本号与帧类型直接取桥的 `contract.ts`,
 * 所以不再需要核心那份「版本钉子」—— 漂不了。
 */

import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fail, ok, type Result } from "@bilibili-notify/extension";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { BRIDGE_PROTOCOL_VERSION } from "../contract.js";
import { createFakeBridge as createFake, type FakeBridge } from "../devtools/fake-bridge.js";
import { type BridgeServer, type BridgeSession, createBridgeServer } from "../server.js";
import { recordingHttp, SILENT } from "./host-stand-in.js";

const TOKEN = "fake-bridge-token";
const LINK = "link-1";

/** 一张 1x1 的图 —— 内容随便,要的是「取得到」。 */
const PNG = Buffer.from(
	"89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100" +
		"05fe02fea7000000004945",
	"hex",
);

let httpServer: HttpServer;
let server: BridgeServer;
let port: number;
let bridge: FakeBridge | undefined;
/** 端点上收到的入站、名单。 */
let inbound: { session: BridgeSession; frame: unknown }[];
let botsSeen: number;
/** upgrade 请求带来的 Authorization 头。 */
let authHeaders: (string | undefined)[];
/** 假桥发出去的帧(经 `ctx.http` 那层记下)。 */
let sentFrames: Record<string, unknown>[];
/** 记账那一层 —— 也是往假桥里塞帧的口(模拟「BN 发来一种没见过的帧」)。 */
let recorder: ReturnType<typeof recordingHttp>;
let accepting: boolean;
let knownToken: string | null;

beforeEach(async () => {
	inbound = [];
	botsSeen = 0;
	authHeaders = [];
	recorder = recordingHttp();
	sentFrames = recorder.sent;
	accepting = true;
	knownToken = TOKEN;
	httpServer = createServer((req, res) => {
		if (req.url === "/img.png") {
			res.writeHead(200, { "content-type": "image/png" }).end(PNG);
			return;
		}
		res.writeHead(404).end();
	});
	server = createBridgeServer({
		logger: SILENT,
		ctx: {
			setInterval: (fn, ms) => {
				const timer = setInterval(fn, ms);
				return { dispose: () => clearInterval(timer) };
			},
			setTimeout: (fn, ms) => {
				const timer = setTimeout(fn, ms);
				return { dispose: () => clearTimeout(timer) };
			},
		},
		serverVersion: "9.9.9-test",
		resolveToken: (token) => (token === knownToken ? LINK : null),
		accepts: () => accepting,
		inbound: () => ({ private: true, group: "with-links" }),
		onInbound: (session, frame) => inbound.push({ session, frame }),
		onBots: () => {
			botsSeen += 1;
		},
	});
	httpServer.on("upgrade", (req, socket, head) => {
		authHeaders.push(req.headers.authorization);
		server.upgrade({ req, socket, head, path: "/" });
	});
	await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
	port = (httpServer.address() as AddressInfo).port;
});

afterEach(async () => {
	bridge?.dispose();
	bridge = undefined;
	server.dispose();
	httpServer.closeAllConnections();
	await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

function fake(over: Partial<Parameters<typeof createFake>[0]> = {}): FakeBridge {
	return createFake({
		http: recorder.http,
		url: `ws://127.0.0.1:${port}`,
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
		receipt: () => ok(),
		...over,
	});
}

async function eventually(assertion: () => void, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			assertion();
			return;
		} catch (err) {
			if (Date.now() > deadline) throw err;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}
}

const SEND = {
	botId: "bot-1",
	platform: "telegram",
	target: { scope: "group", address: "g-42" },
} as const;

describe("握手", () => {
	it("token 走 upgrade 的 Authorization 头,不在帧里也不在 URL 里", async () => {
		bridge = fake();
		await bridge.ready();
		expect(authHeaders).toEqual([`Bearer ${TOKEN}`]);
		expect(JSON.stringify(sentFrames)).not.toContain(TOKEN);
	});

	it("连上第一帧就是 hello,带协议版本、桥的种类与全量 bot 名单;端点上多出一条握过手的会话", async () => {
		bridge = fake();
		await bridge.ready();

		expect(sentFrames[0]).toEqual({
			type: "hello",
			// 版本直接取桥的常量 —— 抄一份字面值才会漂。
			protocol: BRIDGE_PROTOCOL_VERSION,
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
		const session = server.getSession(LINK);
		expect(session).toMatchObject({ kind: "koishi", name: "假桥" });
		expect(session?.bots.map((b) => b.botId)).toEqual(["bot-1"]);
		expect(bridge.connected()).toBe(true);
	});

	/**
	 * 🔴 图标是 1.2 加的一格,只认 `data:image/…;base64,` 的 data URL。假桥造不出它的话,
	 * 「bot 行左边那枚方块」这条路在真机之前一次都走不到。
	 */
	it("bot 的平台图标一起报上去 —— 端点上的会话里就有它", async () => {
		const icon = `data:image/png;base64,${"A".repeat(16)}`;
		bridge = fake({ bots: [{ botId: "bot-1", platform: "telegram", icon }] });
		await bridge.ready();
		expect(server.getSession(LINK)?.bots[0]?.icon).toBe(icon);
	});

	/** 场景要拿这句话往面板上贴 —— 「转了半天没反应」是最没用的一种失败。 */
	it("upgrade 被拒(token 不对)→ ready() 带着状态码炸出来", async () => {
		knownToken = "别的 token";
		bridge = fake();
		await expect(bridge.ready()).rejects.toThrow(/401/);
		expect(bridge.connected()).toBe(false);
	});

	it("接入停用着 → 503 带着状态码炸出来", async () => {
		accepting = false;
		bridge = fake();
		await expect(bridge.ready()).rejects.toThrow(/503/);
	});

	it("地址给错 → 连不上,理由能直接贴到面板上", async () => {
		bridge = fake({ url: "不是个地址" });
		await expect(bridge.ready()).rejects.toThrow(/连不上/);
	});
});

describe("连着的时候", () => {
	it("BN 探一趟活就回一趟,带着原 id —— 「测试」量得出真数", async () => {
		bridge = fake();
		await bridge.ready();

		const pinged = await server.ping(LINK);
		expect(pinged.ok).toBe(true);
		const pong = sentFrames.find((f) => f.type === "pong");
		expect(typeof pong?.id).toBe("string");
	});

	it("收到 send 就回执,回什么由 receipt 现说", async () => {
		let receipt: Result = ok();
		bridge = fake({ receipt: () => receipt });
		await bridge.ready();

		expect(await server.send(LINK, { ...SEND, message: { kind: "text", text: "开播啦" } })).toEqual(
			ok(),
		);

		receipt = fail("unknown", "群被禁言了");
		expect(
			await server.send(LINK, { ...SEND, message: { kind: "text", text: "再来一条" } }),
		).toEqual(fail("unknown", "群被禁言了"));
	});

	it("消息里带图 → 假桥真去取(走 ctx.http.fetch),取得到才回执", async () => {
		const lines: string[] = [];
		bridge = fake({ log: (line) => lines.push(line) });
		await bridge.ready();

		const result = await server.send(LINK, {
			...SEND,
			message: { kind: "image", url: `http://127.0.0.1:${port}/img.png`, mime: "image/png" },
		});
		expect(result).toEqual(ok());
		expect(lines.some((line) => line.includes(`取到图 ${PNG.byteLength} 字节`))).toBe(true);
	});

	/** 静默发一条没有图的消息才是最难查的那种坏 —— 取不到就如实回失败。 */
	it("图取不到 → 回执是失败,理由带着状态码,不假装发成了", async () => {
		bridge = fake();
		await bridge.ready();

		const result = await server.send(LINK, {
			...SEND,
			message: { kind: "image", url: `http://127.0.0.1:${port}/gone.png`, mime: "image/png" },
		});
		expect(result).toMatchObject({
			ok: false,
			code: "unavailable",
			message: expect.stringContaining("404"),
		});
	});

	/** 不认识的帧**忽略**,别炸 —— 协议里写死的演进纪律,两个方向对称。 */
	it("BN 发来一种没见过的帧 → 当没看见,连接照旧", async () => {
		bridge = fake();
		await bridge.ready();

		recorder.inject({ type: "从未来来的帧" });
		expect((await server.ping(LINK)).ok).toBe(true);
		expect(bridge.connected()).toBe(true);
	});

	it("驮一条入站上去,平台名跟着那个 bot 走", async () => {
		bridge = fake();
		await bridge.ready();

		bridge.sendInbound({ scope: "private", userId: "10086", text: "帮助" });
		await eventually(() => expect(inbound).toHaveLength(1));
		expect(inbound[0]?.frame).toEqual({
			type: "inbound",
			botId: "bot-1",
			platform: "telegram",
			message: { scope: "private", userId: "10086", text: "帮助" },
		});
		expect(inbound[0]?.session.linkId).toBe(LINK);
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
		await eventually(() => expect(inbound).toHaveLength(1));
		expect((inbound[0]?.frame as { message?: unknown } | undefined)?.message).toEqual({
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
		await eventually(() => expect(inbound).toHaveLength(1));
		expect(sentFrames.at(-1)).toEqual({
			type: "inbound",
			botId: "bot-1",
			platform: "telegram",
			message: { scope: "group", groupId: "g1", userId: "10086", text: "看看 b23.tv/x" },
		});
	});

	/**
	 * 🔴 **握完手之后名单还会再来一份**:真插件探完能力(小程序卡那一格是唯一探得出来的)
	 * 就重推一份全量快照。假桥没有这个口的话,「能力矩阵会不会跟着换」在真机之前钉不住。
	 */
	it("握完手再推一份全量名单 —— 端点上的会话换成新的,能力归一成六项", async () => {
		bridge = fake();
		await bridge.ready();
		const before = botsSeen;

		bridge.pushBots([
			{ botId: "bot-1", platform: "telegram", capabilities: { miniAppCard: "supported" } },
		]);
		await eventually(() => expect(botsSeen).toBeGreaterThan(before));
		const caps = server.getSession(LINK)?.bots[0]?.capabilities;
		expect(caps?.miniAppCard).toBe("supported");
		expect(caps?.atAll).toBe("unknown");
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

	it("dispose 之后,端点上的会话消失", async () => {
		bridge = fake();
		await bridge.ready();
		bridge.dispose();
		await eventually(() => expect(server.getSession(LINK)).toBeUndefined());
		expect(bridge.connected()).toBe(false);
	});
});
