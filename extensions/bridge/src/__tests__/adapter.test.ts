/**
 * 桥 adapter —— 把一条推送译成协议帧,再把回执译回投递结果。
 *
 * 它是矩阵里唯一一个**方言不是自己写的**实现:桥后面挂着 telegram 还是 discord,
 * 编解码全在对面。所以这里钉的不是「报文长什么样」,而是三件本地的事:
 * 1. **投影穷尽** —— 每个 payload kind 都有一条路。漏一个就是运行时静默发不出去。
 * 2. **图换成一次性 URL** —— `Buffer` 过不了 JSON,而这条 URL 的可达性有个致命前提
 *    (只保证桥自己能取),所以「哪些图进 blob、哪些原样透传」必须是明确的。
 * 3. **发之前先问「这个 bot 还在不在」** —— 一条桥连接后面挂着好几个 bot,bot 掉了
 *    连接还在;不看名单就发等于把一条推送扔进黑洞再等 30 秒超时。
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
import type { BridgeSendRequest, BridgeServer, BridgeSession } from "../server.js";

/** 宿主交给拓展的那份连接视图 —— config 已经过本拓展那份 zod。 */
type View = ExtensionConnectionView<BridgeConnectionConfig>;

function view(over: Partial<View> = {}): View {
	return {
		id: CONNECTION_ID,
		name: "家里那台 koishi",
		enabled: true,
		config: { token: "t0ken", bridgeKind: "koishi" },
		...over,
	};
}

const CONNECTION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function connection(over: Partial<Connection> = {}): Connection {
	return {
		id: CONNECTION_ID,
		name: "家里那台 koishi",
		enabled: true,
		kind: "extension",
		extensionId: "bridge",
		config: { token: "t0ken", bridgeKind: "koishi" },
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
		botId: "b1",
		...over,
	} as PushTarget;
}

function session(over: Partial<BridgeSession> = {}): BridgeSession {
	return {
		connectionId: CONNECTION_ID,
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
	disconnect: ReturnType<typeof vi.fn>;
	published: { mime: string; bytes: number }[];
	lastRequest(): BridgeSendRequest;
	/** 宿主交给它的那份名单 —— 换掉它再 `reconcile()` 就是「配置动了」。 */
	setConnections(list: View[]): void;
}

/** `live: null` = 桥没连着。**别用 `undefined`** —— 显式传它会触发默认参数,那条用例就空过了。 */
function harness(live: BridgeSession | null = session()): Harness {
	// 形参要写出来:mock 的 `calls` 元组是按形参推的,零形参的话 `calls[0][1]` 取不到。
	const send = vi.fn(async (_id: string, _request: BridgeSendRequest) => ({
		ok: true,
		err: undefined as string | undefined,
	}));
	const disconnect = vi.fn();
	const published: { mime: string; bytes: number }[] = [];
	const server = {
		getSession: (id: string) => (id === CONNECTION_ID ? (live ?? undefined) : undefined),
		listSessions: () => (live ? [live] : []),
		send,
		disconnect,
		sessionCount: live ? 1 : 0,
		dispose() {},
	} as unknown as BridgeServer;
	let connections: View[] = [view()];
	const adapter = createBridgeAdapter({
		server,
		connections: () => connections,
		mountPath: "/ext/bridge",
		blobs: {
			put(buffer: Buffer, mime: string) {
				published.push({ mime, bytes: buffer.byteLength });
				return `blob${published.length}`;
			},
		},
	});
	return {
		adapter,
		send,
		disconnect,
		published,
		lastRequest: () => send.mock.calls.at(-1)?.[1] as BridgeSendRequest,
		setConnections: (list) => {
			connections = list;
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

	it("**bot 不在名单里 → 不可发**(连接还在,是那个 bot 掉了)", () => {
		const h = harness();
		expect(h.adapter.isAvailable(connection(), target({ botId: "没这个" }))).toBe(false);
	});

	it("目标没记 botId → 不可发(一条桥后面好几个 bot,不指名发给谁)", () => {
		const h = harness();
		expect(h.adapter.isAvailable(connection(), target({ botId: undefined }))).toBe(false);
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
		const result = await h.adapter.send(connection(), target({ botId: "没这个" }), {
			kind: "text",
			text: "喵",
		});
		expect(result.ok).toBe(false);
		expect(h.send).not.toHaveBeenCalled();
	});

	// ---- 投影 --------------------------------------------------------------

	it("文本:整条带着 bot / 平台 / 地址交给传输层", async () => {
		const h = harness();
		const result = await h.adapter.send(connection(), target(), { kind: "text", text: "开播啦" });
		expect(result.ok).toBe(true);
		expect(h.send.mock.calls[0]?.[0]).toBe(CONNECTION_ID);
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

	it("probe:连着就是通,没连上是不通 —— 不打网络,桥是自己连过来的", async () => {
		expect((await harness().adapter.probe(connection())).ok).toBe(true);
		expect((await harness(null).adapter.probe(connection())).ok).toBe(false);
	});

	// ---- 吊销 --------------------------------------------------------------

	it("接入被删了 → 把还连着的那条踢下线", () => {
		const h = harness();
		h.setConnections([]);
		h.adapter.reconcile?.([]);
		expect(h.disconnect).toHaveBeenCalledWith(CONNECTION_ID, 4005);
	});

	it("接入被停用 → 踢下线,但用的是「可以退避重连」那个码", () => {
		const h = harness();
		h.setConnections([view({ enabled: false })]);
		h.adapter.reconcile?.([]);
		expect(h.disconnect).toHaveBeenCalledWith(CONNECTION_ID, 4007);
	});

	it("**token 被重新生成 → 踢下线** —— 不然重新生成 token 这个动作等于没做", () => {
		const h = harness();
		h.adapter.reconcile?.([]);
		expect(h.disconnect).not.toHaveBeenCalled();
		h.setConnections([view({ config: { token: "新的", bridgeKind: "koishi" } })]);
		h.adapter.reconcile?.([]);
		expect(h.disconnect).toHaveBeenCalledWith(CONNECTION_ID, 4005);
	});

	it("什么都没变 → 不动它(reconcile 每次配置变更都会跑)", () => {
		const h = harness();
		h.adapter.reconcile?.([]);
		h.adapter.reconcile?.([]);
		expect(h.disconnect).not.toHaveBeenCalled();
	});

	/**
	 * 别人的连接根本不会进这份名单 —— 宿主只把属于这个拓展、且 config 解得出形状的交过来
	 * (ADR-0012 决策 30)。从前这一层要自己 parse 一条来路不明的连接,现在不必了。
	 */
	it("名单里只有自己的:别人的连接进不来,所以也踢不着", () => {
		const h = harness();
		h.adapter.reconcile?.([]);
		expect(h.disconnect).not.toHaveBeenCalled();
	});
});
