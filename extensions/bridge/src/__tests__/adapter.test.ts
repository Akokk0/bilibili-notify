/**
 * 桥 adapter —— 把一条推送译成协议帧,再把回执译回投递结果。
 *
 * 它是矩阵里唯一一个**方言不是自己写的**实现:桥后面挂着 telegram 还是 discord,
 * 编解码全在对面。所以这里钉的不是「报文长什么样」,而是三件本地的事:
 * 1. **投影穷尽** —— 每个 payload kind 都有一条路。漏一个就是运行时静默发不出去。
 * 2. **图换成一次性 URL** —— `Buffer` 过不了 JSON,而这条 URL 的可达性有个致命前提
 *    (只保证桥自己能取),所以「哪些图进 blob、哪些原样透传」必须是明确的。
 * 3. **发之前先问「这个 bot 还在不在」** —— 一条接入后面挂着好几个 bot,bot 掉了
 *    接入还在;不看名单就发等于把一条推送扔进黑洞再等 30 秒超时。
 *
 * 连接是「一个 bot」(ADR-0012 决策 45):config 记的是「哪条接入上的哪个 bot」,目标身上
 * 没有 `botId`。接入(token)住设置里,adapter 现读那份名单。
 */

import type {
	Connection,
	ExtensionConnectionView,
	NotificationPayload,
	PushTarget,
} from "@bilibili-notify/extension";
import { describe, expect, it, vi } from "vite-plus/test";
import { createBridgeAdapter } from "../adapter.js";
import type { BridgeConnectionConfig } from "../config.js";
import type { BridgeCapabilityReport } from "../contract.js";
import type { BridgeSendRequest, BridgeServer, BridgeSession } from "../server.js";
import type { BridgeLink } from "../settings.js";

const LINK_ID = "link-home";
const CONNECTION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function link(over: Partial<BridgeLink> = {}): BridgeLink {
	return {
		id: LINK_ID,
		name: "家里那台 koishi",
		enabled: true,
		token: "t0ken",
		bridgeKind: "koishi",
		...over,
	};
}

/** 宿主交给拓展的那份连接视图 —— config 已经过本拓展那份 zod:接入 + bot。 */
type View = ExtensionConnectionView<BridgeConnectionConfig>;

function view(over: Partial<View> = {}): View {
	return {
		id: CONNECTION_ID,
		name: "电报那个 bot",
		enabled: true,
		config: { link: LINK_ID, botId: "b1" },
		...over,
	};
}

function connection(over: Partial<Connection> = {}): Connection {
	return {
		id: CONNECTION_ID,
		name: "电报那个 bot",
		enabled: true,
		kind: "extension",
		extensionId: "bridge",
		platform: "telegram",
		config: { link: LINK_ID, botId: "b1" },
		...over,
	} as Connection;
}

function target(over: Partial<PushTarget> = {}): PushTarget {
	return {
		id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		name: "电报群",
		connectionId: CONNECTION_ID,
		kind: "session",
		platform: "telegram",
		scope: "group",
		enabled: true,
		address: "-100",
		...over,
	} as PushTarget;
}

/** 一条会话,可以只改某一格能力 —— markdown 那一档的用例全靠它。 */
function session(
	over: Partial<BridgeSession> = {},
	caps: Partial<BridgeCapabilityReport> = {},
): BridgeSession {
	return {
		linkId: LINK_ID,
		kind: "koishi",
		bots: [
			{
				botId: "b1",
				platform: "telegram",
				capabilities: {
					atAll: "unsupported",
					inbound: "supported",
					forward: "unknown",
					miniAppCard: "unknown",
					shareCardLinks: "unknown",
					markdown: "unknown",
					...caps,
				},
			},
		],
		connectedAt: 0,
		origin: "http://192.168.1.5:8787",
		...over,
	};
}

interface Harness {
	adapter: ReturnType<typeof createBridgeAdapter>;
	send: ReturnType<typeof vi.fn>;
	ping: ReturnType<typeof vi.fn>;
	disconnect: ReturnType<typeof vi.fn>;
	published: { mime: string; bytes: number }[];
	lastRequest(): BridgeSendRequest;
	/** 宿主交给它的那份连接名单。 */
	setConnections(list: View[]): void;
	/** 设置里那份接入名单 —— 换掉它再 `reconcile()` 就是「接入动了」。 */
	setLinks(list: BridgeLink[]): void;
}

/** `live: null` = 桥没连着。**别用 `undefined`** —— 显式传它会触发默认参数,那条用例就空过了。 */
function harness(live: BridgeSession | null = session()): Harness {
	// 形参要写出来:mock 的 `calls` 元组是按形参推的,零形参的话 `calls[0][1]` 取不到。
	const send = vi.fn(async (_id: string, _request: BridgeSendRequest) => ({
		ok: true,
		err: undefined as string | undefined,
	}));
	const disconnect = vi.fn();
	const ping = vi.fn(async (_id: string) => ({
		ok: true,
		latencyMs: 42,
		err: undefined as string | undefined,
	}));
	const published: { mime: string; bytes: number }[] = [];
	const server = {
		getSession: (id: string) => (id === LINK_ID ? (live ?? undefined) : undefined),
		listSessions: () => (live ? [live] : []),
		send,
		ping,
		disconnect,
		sessionCount: live ? 1 : 0,
		dispose() {},
	} as unknown as BridgeServer;
	let connections: View[] = [view()];
	let links: BridgeLink[] = [link()];
	const adapter = createBridgeAdapter({
		server,
		connections: () => connections,
		links: () => links,
		mountPath: "/ext/bridge",
		blobs: {
			put(buffer: Buffer, mime: string) {
				published.push({ mime, bytes: buffer.byteLength });
				return `blob${published.length}`;
			},
		},
	});
	return {
		ping,
		adapter,
		send,
		disconnect,
		published,
		lastRequest: () => send.mock.calls.at(-1)?.[1] as BridgeSendRequest,
		setConnections: (list) => {
			connections = list;
		},
		setLinks: (list) => {
			links = list;
		},
	};
}

describe("桥 adapter", () => {
	/**
	 * 🔴 **分发键由宿主按拓展 id 填,拓展自己不报**(ADR-0012 决策 28)。
	 *
	 * 自报的话,一个拓展可以声明 `"onebot"` 把内置那条连接的推送整个截走 —— 归属是宿主的
	 * 判断,不是拓展的声明。覆盖那一步的守卫在 `extensions/__tests__/context-grants.test.ts`。
	 */
	it("自己**不报**分发键 —— 报了也会被宿主覆盖掉", () => {
		expect([...harness().adapter.platforms]).toEqual([]);
	});

	// ---- 发得出去吗 --------------------------------------------------------

	it("会话在、bot 在名单里 → 可发", () => {
		const h = harness();
		expect(h.adapter.isAvailable(connection(), target())).toBe(true);
	});

	it("桥没连着 → 不可发", () => {
		const h = harness(null);
		expect(h.adapter.isAvailable(connection(), target())).toBe(false);
	});

	it("**bot 不在名单里 → 不可发**(接入还在,是那个 bot 掉了)", () => {
		const h = harness();
		h.setConnections([view({ config: { link: LINK_ID, botId: "没这个" } })]);
		expect(h.adapter.isAvailable(connection(), target())).toBe(false);
	});

	it("连接绑的接入删了 / 停用了 → 不可发,理由说的是接入", async () => {
		const h = harness();
		h.setLinks([]);
		expect(h.adapter.isAvailable(connection(), target())).toBe(false);
		expect((await h.adapter.probe(connection())).err).toMatch(/接入/);
		h.setLinks([link({ enabled: false })]);
		expect((await h.adapter.probe(connection())).err).toMatch(/停用/);
	});

	it("连接或目标停用 → 不可发", () => {
		const h = harness();
		h.setConnections([view({ enabled: false })]);
		expect(h.adapter.isAvailable(connection(), target())).toBe(false);
		h.setConnections([view()]);
		expect(h.adapter.isAvailable(connection(), target({ enabled: false }))).toBe(false);
	});

	it("发之前先问一遍 —— bot 不在名单就**一帧都不发**,别扔进黑洞等超时", async () => {
		const h = harness();
		h.setConnections([view({ config: { link: LINK_ID, botId: "没这个" } })]);
		const result = await h.adapter.send(connection(), target(), { kind: "text", text: "喵" });
		expect(result.ok).toBe(false);
		expect(h.send).not.toHaveBeenCalled();
	});

	// ---- 投影 --------------------------------------------------------------

	it("文本:整条带着 bot / 平台 / 地址交给传输层", async () => {
		const h = harness();
		const result = await h.adapter.send(connection(), target(), { kind: "text", text: "开播啦" });
		expect(result.ok).toBe(true);
		// 帧走的是**接入**那条 socket;平台是 bot 自己报的那个,不是目标身上抄的。
		expect(h.send.mock.calls[0]?.[0]).toBe(LINK_ID);
		expect(h.lastRequest()).toEqual({
			botId: "b1",
			platform: "telegram",
			target: { scope: "group", address: "-100", parentAddress: undefined },
			message: { kind: "text", text: "开播啦" },
		});
	});

	it("图:Buffer **换成一次性 URL**,地址是这条桥自己连进来时用的那个", async () => {
		const h = harness();
		await h.adapter.send(connection(), target(), {
			kind: "image",
			image: { buffer: Buffer.from([1, 2, 3]), mime: "image/png" },
			caption: "封面",
		});
		expect(h.published).toEqual([{ mime: "image/png", bytes: 3 }]);
		expect(h.lastRequest().message).toEqual({
			kind: "image",
			url: "http://192.168.1.5:8787/ext/bridge/blob/blob1",
			mime: "image/png",
			caption: "封面",
		});
	});

	it("图 URL 的地址跟着**会话**走,不是写死的 —— 每条桥从哪儿连进来的都不一样", async () => {
		const h = harness(session({ origin: "https://bn.example.com" }));
		await h.adapter.send(connection(), target(), {
			kind: "image",
			image: { buffer: Buffer.from([1]), mime: "image/png" },
		});
		expect(h.lastRequest().message).toMatchObject({
			url: "https://bn.example.com/ext/bridge/blob/blob1",
		});
	});

	it("composite:四种段都过得去,图那一段也换 URL", async () => {
		const h = harness();
		await h.adapter.send(connection(), target(), {
			kind: "composite",
			segments: [
				{ type: "at-all" },
				{ type: "text", text: "看这个" },
				{ type: "image", buffer: Buffer.from([9]), mime: "image/jpeg" },
				{ type: "link", href: "https://b23.tv/x", title: "视频" },
			],
		});
		expect(h.lastRequest().message).toEqual({
			kind: "composite",
			segments: [
				{ type: "at-all" },
				{ type: "text", text: "看这个" },
				{ type: "image", url: "http://192.168.1.5:8787/ext/bridge/blob/blob1", mime: "image/jpeg" },
				{ type: "link", href: "https://b23.tv/x", title: "视频" },
			],
		});
	});

	it("**远端 URL 原样透传,不进 blob** —— 图廊与小程序卡的图本来就是公网可达的", async () => {
		const h = harness();
		await h.adapter.send(connection(), target(), {
			kind: "forward-images",
			images: [{ url: "https://i0.hdslb.com/a.jpg", width: 1080, height: 1920 }],
			forward: true,
		});
		await h.adapter.send(connection(), target(), {
			kind: "miniapp-card",
			title: "标题",
			desc: "简介",
			picUrl: "https://i0.hdslb.com/cover.jpg",
			path: "pages/video/video?bvid=BV1",
			jumpUrl: "https://www.bilibili.com/video/BV1",
		});
		expect(h.published).toEqual([]);
		expect(h.send.mock.calls[0]?.[1].message).toEqual({
			kind: "forward-images",
			images: [{ url: "https://i0.hdslb.com/a.jpg", width: 1080, height: 1920 }],
			forward: true,
		});
		expect(h.send.mock.calls[1]?.[1].message).toMatchObject({
			kind: "miniapp-card",
			picUrl: "https://i0.hdslb.com/cover.jpg",
			path: "pages/video/video?bvid=BV1",
		});
	});

	/**
	 * 这张表是**编译期穷尽守卫**:给 `NotificationPayload` 加一个 kind 而这里忘了给它
	 * 一条路,键少一个就编译不过。运行时再跑一遍,顺带证明每条路真的发得出去。
	 */
	const EVERY_PAYLOAD: Record<NotificationPayload["kind"], NotificationPayload> = {
		text: { kind: "text", text: "x" },
		image: { kind: "image", image: { buffer: Buffer.from([1]), mime: "image/png" } },
		composite: { kind: "composite", segments: [{ type: "text", text: "x" }] },
		"forward-images": {
			kind: "forward-images",
			images: [{ url: "https://x/1.jpg" }],
			forward: false,
		},
		"miniapp-card": {
			kind: "miniapp-card",
			title: "t",
			desc: "d",
			picUrl: "https://x/p.jpg",
			path: "pages/video/video",
			jumpUrl: "https://x/v",
		},
	};

	it("每个 payload kind 都译得出来,没有一条路是死的", async () => {
		const h = harness();
		for (const [kind, payload] of Object.entries(EVERY_PAYLOAD)) {
			const result = await h.adapter.send(connection(), target(), payload);
			expect(result.ok, kind).toBe(true);
			expect(h.lastRequest().message.kind, kind).toBe(kind);
		}
	});

	// ---- 私聊覆盖 ----------------------------------------------------------

	/**
	 * 调用方(`MultiplexSink.send`)**恒传 `{ private: false }`**,所以这里只能认
	 * `=== true`。写成 `opts.private ?? scope === "private"` 的话 `??` 不替换 false,
	 * scope 是 private 的目标会永远走群那一支 —— onebot 上栽过一次的坑。
	 */
	it("private 覆盖只认 === true;scope 本来就是 private 的也走私聊", async () => {
		const h = harness();
		await h.adapter.send(connection(), target(), { kind: "text", text: "x" }, { private: true });
		expect(h.lastRequest().target.scope).toBe("private");

		await h.adapter.send(connection(), target(), { kind: "text", text: "x" }, { private: false });
		expect(h.lastRequest().target.scope).toBe("group");

		await h.adapter.send(
			connection(),
			target({ scope: "private", address: "u1" }),
			{ kind: "text", text: "x" },
			{ private: false },
		);
		expect(h.lastRequest().target.scope).toBe("private");
	});

	// ---- 回执 --------------------------------------------------------------

	it("回执失败 → 原因原样带给用户", async () => {
		const h = harness();
		h.send.mockResolvedValueOnce({ ok: false, err: "telegram 说这个群没了" });
		const result = await h.adapter.send(connection(), target(), { kind: "text", text: "x" });
		expect(result.ok).toBe(false);
		expect(result.err).toBe("telegram 说这个群没了");
	});

	// ---- 探测 --------------------------------------------------------------

	it("probe:接入连着、bot 在名单上 → 真打一趟 ping,延迟是往返的那个数", async () => {
		const h = harness();
		expect(await h.adapter.probe(connection())).toEqual({
			ok: true,
			latencyMs: 42,
			err: undefined,
		});
		expect(h.ping).toHaveBeenCalledWith(LINK_ID);
	});

	it("probe:ping 没回来 → 不通,原因照抄", async () => {
		const h = harness();
		h.ping.mockResolvedValueOnce({ ok: false, latencyMs: 0, err: "桥 5000ms 内没回 pong" });
		expect(await h.adapter.probe(connection())).toMatchObject({ ok: false, err: /pong/ });
	});

	it("probe:没连上是不通,而且不打 ping —— 没有 socket 可打", async () => {
		const h = harness(null);
		expect((await h.adapter.probe(connection())).ok).toBe(false);
		expect(h.ping).not.toHaveBeenCalled();
	});

	// ---- 能力 --------------------------------------------------------------

	/**
	 * 一条连接就是一个 bot,所以能力**按 bot 答得准** —— 这两个方法从前刻意不实现(那时
	 * 连接是一条接入,底下同时挂着 QQ 与 telegram,合并出来的答案对谁都不对)。
	 */
	it("capabilities:桥报的三态原样对应;没连着就是「还不知道」并带原因", async () => {
		expect(
			harness(session({}, { miniAppCard: "supported" })).adapter.capabilities?.(connection()),
		).toMatchObject({ miniAppCard: { state: "supported" } });
		expect(
			harness(session({}, { miniAppCard: "unsupported" })).adapter.capabilities?.(connection()),
		).toMatchObject({ miniAppCard: { state: "unsupported" } });
		expect(harness().adapter.capabilities?.(connection())).toMatchObject({
			miniAppCard: { state: "unknown" },
		});
		const offline = harness(null);
		expect(offline.adapter.capabilities?.(connection())).toMatchObject({
			miniAppCard: { state: "unknown", reason: expect.stringMatching(/没连着/) },
		});
		expect(await offline.adapter.probeCapabilities?.(connection())).toMatchObject({
			miniAppCard: { state: "unknown" },
		});
	});

	// ---- 吊销 --------------------------------------------------------------

	it("接入被删了 → 把还连着的那条踢下线", () => {
		const h = harness();
		h.setLinks([]);
		h.adapter.reconcile?.([]);
		expect(h.disconnect).toHaveBeenCalledWith(LINK_ID, 4005);
	});

	it("接入被停用 → 踢下线,但用的是「可以退避重连」那个码", () => {
		const h = harness();
		h.setLinks([link({ enabled: false })]);
		h.adapter.reconcile?.([]);
		expect(h.disconnect).toHaveBeenCalledWith(LINK_ID, 4007);
	});

	it("**token 被重新生成 → 踢下线** —— 不然重新生成 token 这个动作等于没做", () => {
		const h = harness();
		h.adapter.reconcile?.([]);
		expect(h.disconnect).not.toHaveBeenCalled();
		h.setLinks([link({ token: "新的" })]);
		h.adapter.reconcile?.([]);
		expect(h.disconnect).toHaveBeenCalledWith(LINK_ID, 4005);
	});

	/**
	 * 🔴 **重启之后第一次换 token 也得踢**。上一轮快照是**建 adapter 那一刻**打的底,不是
	 * 「第一次 reconcile 跑完」—— 宿主开机那趟 reconcile 跑在拓展装载**之前**,所以桥根本
	 * 没机会先对一次账。空表打底的话 `before === undefined`,重启后第一次「重新生成 token」
	 * 静默放过,旧会话拿着作废的 token 继续收推送。
	 */
	it("**开机后第一次就换 token → 照样踢下线**(上一轮快照在建 adapter 时就打好底)", () => {
		const h = harness();
		h.setLinks([link({ token: "新的" })]);
		h.adapter.reconcile?.([]);
		expect(h.disconnect).toHaveBeenCalledWith(LINK_ID, 4005);
	});

	it("什么都没变 → 不动它(reconcile 每次配置变更都会跑)", () => {
		const h = harness();
		h.adapter.reconcile?.([]);
		h.adapter.reconcile?.([]);
		expect(h.disconnect).not.toHaveBeenCalled();
	});

	/** 删一条连接不该断谁 —— 连接是一个 bot,断不断看的是接入。 */
	it("连接删光了、接入还在 → 会话留着", () => {
		const h = harness();
		h.setConnections([]);
		h.adapter.reconcile?.([]);
		expect(h.disconnect).not.toHaveBeenCalled();
	});
});

/**
 * 🔴 **主人写在文案模板里的 markdown,按 bot 的能力降级**(ADR-0012 决策 32)。
 *
 * 分叉的理由很实在:不认 markdown 的那一头收到的是**字面上的一堆星号**。宁可少点排版,
 * 也别让群里收到一串符号。而这件事只有桥知道 —— 能力是 per-bot 的。
 */
describe("markdown 按能力降级", () => {
	const RICH = "**开播**了,[进直播间](https://live.bilibili.com/1)";
	const PLAIN = "开播了,进直播间 https://live.bilibili.com/1";

	async function sendText(caps: Partial<BridgeCapabilityReport>, text = RICH) {
		const h = harness(session({}, caps));
		await h.adapter.send(connection(), target(), { kind: "text", text }, {});
		return h.lastRequest().message;
	}

	it("报了 supported → 原样发,一个字不动", async () => {
		expect(await sendText({ markdown: "supported" })).toEqual({ kind: "text", text: RICH });
	});

	it("报了 unsupported → 剥成纯文本", async () => {
		expect(await sendText({ markdown: "unsupported" })).toEqual({ kind: "text", text: PLAIN });
	});

	/** 拿不准就别发星号 —— `unknown` 与 `unsupported` 在这件事上做同一个选择。 */
	it("没报(unknown)→ 也剥", async () => {
		expect(await sendText({ markdown: "unknown" })).toEqual({ kind: "text", text: PLAIN });
	});

	it("图说明也过一遍 —— 它跟正文一样是主人写的", async () => {
		const h = harness(session({}, { markdown: "unknown" }));
		await h.adapter.send(
			connection(),
			target(),
			{ kind: "image", image: { buffer: Buffer.from("x"), mime: "image/png" }, caption: RICH },
			{},
		);
		expect(h.lastRequest().message).toMatchObject({ kind: "image", caption: PLAIN });
	});

	it("composite:每一段文字都过一遍,图那一段不受影响", async () => {
		const h = harness(session({}, { markdown: "unknown" }));
		await h.adapter.send(
			connection(),
			target(),
			{
				kind: "composite",
				segments: [
					{ type: "text", text: RICH },
					{ type: "image", buffer: Buffer.from("x"), mime: "image/png" },
					{ type: "link", href: "https://b23.tv/a", title: "**标题**" },
				],
			},
			{},
		);
		expect(h.lastRequest().message).toEqual({
			kind: "composite",
			segments: [
				{ type: "text", text: PLAIN },
				{ type: "image", url: "http://192.168.1.5:8787/ext/bridge/blob/blob1", mime: "image/png" },
				{ type: "link", href: "https://b23.tv/a", title: "标题" },
			],
		});
	});
});
