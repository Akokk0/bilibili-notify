/**
 * 单元测试 — `createOnebotAdapter` / `createWebhookAdapter`(平台投递适配器)。
 *
 * 守护契约(onebot):
 *   - scope/opts.private 决定 /send_group_msg vs /send_private_msg + group_id/user_id
 *   - baseUrl 尾斜杠裁剪;accessToken → Authorization Bearer;payload 段 → OneBot segment
 *   - retcode!=0 / HTTP 非 2xx / fetch 抛错 → ok:false 且 logger.warn;空 payload → "empty payload"
 *   - retryTimes 生效;wrong platform / probe(/get_status)/ isAvailable
 * 守护契约(webhook):
 *   - body 含 targetId/scope/private/payload(序列化)+ secret header;非 2xx/抛错 → ok:false
 *   - probe 恒为 ok:null(不支持);wrong platform / isAvailable
 *
 * fetch 用 vi.stubGlobal mock,不打真实网络。
 */

import { once } from "node:events";
import { type AddressInfo, createServer } from "node:net";
import type {
	NotificationPayload,
	PushAdapter,
	PushTarget,
	ServiceContext,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createOnebotAdapter } from "../onebot.js";
import { createWebhookAdapter } from "../webhook.js";

function makeLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** 测试用 ServiceContext —— 真实定时器(WS 超时 / 重连测试需要真的触发)。 */
function makeServiceCtx(): ServiceContext {
	return {
		logger: makeLogger(),
		setTimeout(fn, ms) {
			const h = setTimeout(fn, ms);
			return { dispose: () => clearTimeout(h) };
		},
		setInterval(fn, ms) {
			const h = setInterval(fn, ms);
			return { dispose: () => clearInterval(h) };
		},
		onDispose() {},
	};
}

/** createOnebotAdapter 的 opts —— logger(可传入以便断言)+ 全新 serviceCtx。 */
function obOpts(logger = makeLogger()) {
	return { logger, serviceCtx: makeServiceCtx() };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 轮询直到 `cond` 为真;支持 async 谓词。 */
async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	for (;;) {
		if (await cond()) return;
		if (Date.now() - start > timeoutMs) throw new Error("waitFor: 超时");
		await sleep(15);
	}
}

/** 测试结束要清理的资源(fake server / bot)。afterEach 统一关。 */
const cleanups: Array<() => void | Promise<void>> = [];

function res(o: { ok: boolean; status?: number; statusText?: string; json?: unknown }) {
	return {
		ok: o.ok,
		status: o.status ?? (o.ok ? 200 : 500),
		statusText: o.statusText ?? "",
		json: async () => o.json ?? {},
	};
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
	for (const c of cleanups.splice(0)) {
		try {
			await c();
		} catch {
			/* ignore cleanup errors */
		}
	}
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function lastBody(): Record<string, unknown> {
	const call = fetchMock.mock.calls.at(-1);
	return JSON.parse((call?.[1] as { body: string }).body);
}
function lastInit(): RequestInit {
	return fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
}

// ---------------------------------------------------------------------------
// OneBot
// ---------------------------------------------------------------------------

function obAdapter(over: Record<string, unknown> = {}): PushAdapter {
	return {
		id: "a1",
		name: "ob",
		platform: "onebot",
		enabled: true,
		config: {
			transport: "http",
			baseUrl: "http://nb:3000/",
			accessToken: "tok",
			retryIntervalMs: 0,
			...over,
		},
	} as unknown as PushAdapter;
}

/** 正向 WS 形态的 onebot adapter(id 与 obTarget.adapterId 同为 a1)。 */
function obWsAdapter(port: number, over: Record<string, unknown> = {}): PushAdapter {
	return {
		id: "a1",
		name: "ob-ws",
		platform: "onebot",
		enabled: true,
		config: { transport: "ws", url: `ws://127.0.0.1:${port}`, retryIntervalMs: 0, ...over },
	} as unknown as PushAdapter;
}

/** 反向 WS 形态的 onebot adapter。 */
function obRevAdapter(port: number, over: Record<string, unknown> = {}): PushAdapter {
	return {
		id: "a1",
		name: "ob-rev",
		platform: "onebot",
		enabled: true,
		config: { transport: "ws-reverse", port, retryIntervalMs: 0, ...over },
	} as unknown as PushAdapter;
}

interface FakeBotServer {
	port: number;
	received: Array<Record<string, unknown>>;
	connections: WebSocket[];
}

/** 假 OneBot WS 服务端(给正向 WS 测试连)。默认收到 action 帧就按 echo 回成功。 */
async function startFakeBotServer(opts?: { autoReply?: boolean }): Promise<FakeBotServer> {
	const wss = new WebSocketServer({ port: 0 });
	await once(wss, "listening");
	const received: Array<Record<string, unknown>> = [];
	const connections: WebSocket[] = [];
	wss.on("connection", (ws) => {
		connections.push(ws);
		ws.on("message", (raw) => {
			const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
			received.push(frame);
			if (opts?.autoReply === false) return;
			ws.send(JSON.stringify({ status: "ok", retcode: 0, echo: frame.echo }));
		});
	});
	cleanups.push(
		() =>
			new Promise<void>((resolve) => {
				for (const c of connections) c.terminate();
				wss.close(() => resolve());
			}),
	);
	return { port: (wss.address() as AddressInfo).port, received, connections };
}

interface FakeBot {
	received: Array<Record<string, unknown>>;
}

/** 假 bot 客户端(给反向 WS 测试,连进 adapter 开的端口)。默认收 action 回 echo 成功。 */
async function connectFakeBot(url: string, headers?: Record<string, string>): Promise<FakeBot> {
	const ws = new WebSocket(url, headers ? { headers } : undefined);
	await new Promise<void>((resolve, reject) => {
		ws.once("open", () => resolve());
		ws.once("error", reject);
	});
	const received: Array<Record<string, unknown>> = [];
	ws.on("message", (raw) => {
		const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
		received.push(frame);
		ws.send(JSON.stringify({ status: "ok", retcode: 0, echo: frame.echo }));
	});
	cleanups.push(() => ws.terminate());
	return { received };
}

/** 反向 WS 监听器异步绑定,bot 客户端可能早于绑定 → 重试直到连上。 */
async function connectWithRetry(url: string, headers?: Record<string, string>): Promise<FakeBot> {
	for (let i = 0; i < 80; i++) {
		try {
			return await connectFakeBot(url, headers);
		} catch {
			await sleep(20);
		}
	}
	throw new Error(`connectWithRetry: 连不上 ${url}`);
}

/** 取一个空闲端口(反向 WS 测试要给 adapter 配具体端口)。 */
async function freePort(): Promise<number> {
	const srv = createServer();
	await new Promise<void>((resolve) => srv.listen(0, resolve));
	const port = (srv.address() as AddressInfo).port;
	await new Promise<void>((resolve) => srv.close(() => resolve()));
	return port;
}
function obTarget(over: Record<string, unknown> = {}): PushTarget {
	return {
		id: "t1",
		name: "群",
		adapterId: "a1",
		platform: "onebot",
		scope: "group",
		enabled: true,
		session: { groupId: "123" },
		...over,
	} as unknown as PushTarget;
}
const TEXT: NotificationPayload = { kind: "text", text: "hello" };

describe("onebot — send 路由", () => {
	it("group:POST /send_group_msg + group_id(Number) + Bearer + 尾斜杠裁剪", async () => {
		fetchMock.mockResolvedValueOnce(res({ ok: true, json: { status: "ok", retcode: 0 } }));
		const ad = createOnebotAdapter(obOpts());
		const r = await ad.send(obAdapter(), obTarget(), TEXT);
		expect(r.ok).toBe(true);
		expect(fetchMock.mock.calls[0]?.[0]).toBe("http://nb:3000/send_group_msg");
		const init = lastInit() as { headers: Record<string, string> };
		expect(init.headers.authorization).toBe("Bearer tok");
		const body = lastBody();
		expect(body.group_id).toBe(123);
		expect(body.message).toEqual([{ type: "text", data: { text: "hello" } }]);
	});

	it("scope=private:/send_private_msg + user_id", async () => {
		fetchMock.mockResolvedValueOnce(res({ ok: true, json: { status: "ok", retcode: 0 } }));
		const ad = createOnebotAdapter(obOpts());
		await ad.send(obAdapter(), obTarget({ scope: "private", session: { userId: "456" } }), TEXT);
		expect(fetchMock.mock.calls[0]?.[0]).toBe("http://nb:3000/send_private_msg");
		expect(lastBody().user_id).toBe(456);
	});

	it("opts.private 覆盖 group scope", async () => {
		fetchMock.mockResolvedValueOnce(res({ ok: true, json: { status: "ok", retcode: 0 } }));
		const ad = createOnebotAdapter(obOpts());
		await ad.send(obAdapter(), obTarget({ session: { userId: "789" } }), TEXT, { private: true });
		expect(fetchMock.mock.calls[0]?.[0]).toBe("http://nb:3000/send_private_msg");
		expect(lastBody().user_id).toBe(789);
	});

	it("NapCat 掉线特征 err → 附加可操作提示", async () => {
		// NapCat 内部 NT 框架超时 / 长消息 trpc 失败 = NapCat ↔ QQNT 通信问题。
		// 跟 payload 形态无关,靠 retry / 改消息都没用,需要用户重启/重登 NapCat。
		fetchMock.mockResolvedValueOnce(
			res({
				ok: true,
				json: {
					status: "failed",
					retcode: 1200,
					wording:
						"Timeout: NTEvent serviceAndMethod:NodeIKernelMsgService/sendMsg ListenerName:NodeIKernelMsgListener/onMsgInfoListUpdate EventRet: {}",
				},
			}),
		);
		const r = await createOnebotAdapter(obOpts()).send(obAdapter(), obTarget(), TEXT);
		expect(r.ok).toBe(false);
		expect(r.err).toContain("NTEvent");
		expect(r.err).toContain("NapCat 可能掉线");
	});

	it("非掉线错误 → 不附加 NapCat 提示", async () => {
		// retry 守卫:不能把 "无权限" / 普通业务错误也挂上掉线提示文案误导用户。
		fetchMock.mockResolvedValueOnce(
			res({ ok: true, json: { status: "failed", retcode: 1404, wording: "无权限发送消息" } }),
		);
		const r = await createOnebotAdapter(obOpts()).send(obAdapter(), obTarget(), TEXT);
		expect(r.ok).toBe(false);
		expect(r.err).toBe("无权限发送消息");
	});

	it("opts.private=false 不应吃掉 scope:private(回归守卫)", async () => {
		// 复发点:旧实现 `opts.private ?? scope === "private"` 用 nullish 而非 falsy,
		// MultiplexSink.send 路径恒传 `{ private: false }`,?? 不替换 false →
		// scope:"private" 被忽略,走 group 分支 → "group: groupId missing"。
		fetchMock.mockResolvedValueOnce(res({ ok: true, json: { status: "ok", retcode: 0 } }));
		const ad = createOnebotAdapter(obOpts());
		await ad.send(obAdapter(), obTarget({ scope: "private", session: { userId: "456" } }), TEXT, {
			private: false,
		});
		expect(fetchMock.mock.calls[0]?.[0]).toBe("http://nb:3000/send_private_msg");
		expect(lastBody().user_id).toBe(456);
	});

	it("private 缺 userId / group 缺 groupId → ok:false 且不发请求", async () => {
		const ad = createOnebotAdapter(obOpts());
		const p = await ad.send(obAdapter(), obTarget({ scope: "private", session: {} }), TEXT);
		expect(p).toMatchObject({ ok: false, err: "private: userId missing" });
		const g = await ad.send(obAdapter(), obTarget({ session: {} }), TEXT);
		expect(g).toMatchObject({ ok: false, err: "group: groupId missing" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("空 composite payload → empty payload,不发请求", async () => {
		const ad = createOnebotAdapter(obOpts());
		const r = await ad.send(obAdapter(), obTarget(), { kind: "composite", segments: [] });
		expect(r).toMatchObject({ ok: false, err: "empty payload" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("composite 段 → OneBot segment(text/image base64/link/at-all)", async () => {
		fetchMock.mockResolvedValueOnce(res({ ok: true, json: { status: "ok", retcode: 0 } }));
		const ad = createOnebotAdapter(obOpts());
		await ad.send(obAdapter(), obTarget(), {
			kind: "composite",
			segments: [
				{ type: "text", text: "T" },
				{ type: "image", buffer: Buffer.from("IMG"), mime: "image/png" },
				{ type: "link", href: "https://x", title: "标题" },
				{ type: "at-all" },
			],
		});
		expect(lastBody().message).toEqual([
			{ type: "text", data: { text: "T" } },
			{ type: "image", data: { file: `base64://${Buffer.from("IMG").toString("base64")}` } },
			{ type: "text", data: { text: "标题 https://x" } },
			{ type: "at", data: { qq: "all" } },
		]);
	});

	it("forward-images forward:false → send_group_msg 多 image 合并(默认行为)", async () => {
		// imageGroupForward=false 默认路径:多图合并到一条普通 send_group_msg,
		// 避开 NapCat SsoSendLongMsg 长消息通道。
		fetchMock.mockResolvedValueOnce(res({ ok: true, json: { status: "ok", retcode: 0 } }));
		const ad = createOnebotAdapter(obOpts());
		await ad.send(obAdapter(), obTarget(), {
			kind: "forward-images",
			urls: ["https://i0.hdslb.com/1.jpg", "https://i0.hdslb.com/2.jpg"],
			forward: false,
		});
		expect(fetchMock.mock.calls[0]?.[0]).toBe("http://nb:3000/send_group_msg");
		expect(lastBody().message).toEqual([
			{ type: "image", data: { file: "https://i0.hdslb.com/1.jpg" } },
			{ type: "image", data: { file: "https://i0.hdslb.com/2.jpg" } },
		]);
	});

	it("forward-images forward:false + private scope → send_private_msg 多 image", async () => {
		fetchMock.mockResolvedValueOnce(res({ ok: true, json: { status: "ok", retcode: 0 } }));
		const ad = createOnebotAdapter(obOpts());
		await ad.send(obAdapter(), obTarget({ scope: "private", session: { userId: "999" } }), {
			kind: "forward-images",
			urls: ["https://x/a.jpg"],
			forward: false,
		});
		expect(fetchMock.mock.calls[0]?.[0]).toBe("http://nb:3000/send_private_msg");
		expect(lastBody().user_id).toBe(999);
		expect(lastBody().message).toEqual([{ type: "image", data: { file: "https://x/a.jpg" } }]);
	});

	it("forward-images forward:true → send_group_forward_msg 合并转发(用户主动开)", async () => {
		// imageGroupForward=true 路径:走 OneBot 合并转发 = 聊天记录卡片。
		// 知道自己 OneBot 实现支持长消息(非 NapCat 或 NapCat 已调优)的用户可以开。
		fetchMock.mockResolvedValueOnce(
			res({ ok: true, json: { status: "ok", retcode: 0, message_id: 999 } }),
		);
		const ad = createOnebotAdapter(obOpts());
		await ad.send(obAdapter(), obTarget(), {
			kind: "forward-images",
			urls: ["https://i0.hdslb.com/1.jpg", "https://i0.hdslb.com/2.jpg"],
			forward: true,
		});
		expect(fetchMock.mock.calls[0]?.[0]).toBe("http://nb:3000/send_group_forward_msg");
		const body = lastBody();
		expect(body.group_id).toBe(123);
		const nodes = body.messages as Array<{
			type: string;
			data: { name: string; uin: string; content: Array<{ type: string; data: { file: string } }> };
		}>;
		expect(nodes.length).toBe(2);
		expect(nodes[0]?.type).toBe("node");
		// 每个 node 内容应是 image segment + URL 透传(NapCat 自己下图)
		expect(nodes[0]?.data?.content?.[0]?.type).toBe("image");
		expect(nodes[0]?.data?.content?.[0]?.data?.file).toBe("https://i0.hdslb.com/1.jpg");
		expect(nodes[1]?.data?.content?.[0]?.data?.file).toBe("https://i0.hdslb.com/2.jpg");
	});

	it("forward-images forward:true + private scope → send_private_forward_msg", async () => {
		fetchMock.mockResolvedValueOnce(
			res({ ok: true, json: { status: "ok", retcode: 0, message_id: 999 } }),
		);
		const ad = createOnebotAdapter(obOpts());
		await ad.send(obAdapter(), obTarget({ scope: "private", session: { userId: "888" } }), {
			kind: "forward-images",
			urls: ["https://x/a.jpg"],
			forward: true,
		});
		expect(fetchMock.mock.calls[0]?.[0]).toBe("http://nb:3000/send_private_forward_msg");
		expect(lastBody().user_id).toBe(888);
	});
});

describe("onebot — 失败与重试", () => {
	it("retcode!=0:ok:false,err 取 wording,logger.warn", async () => {
		fetchMock.mockResolvedValueOnce(
			res({ ok: true, json: { status: "failed", retcode: 1404, wording: "无权限" } }),
		);
		const logger = makeLogger();
		const r = await createOnebotAdapter(obOpts(logger)).send(obAdapter(), obTarget(), TEXT);
		expect(r).toMatchObject({ ok: false, err: "无权限" });
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});

	it("HTTP 非 2xx → ok:false err=HTTP <status>", async () => {
		fetchMock.mockResolvedValueOnce(res({ ok: false, status: 500, statusText: "Internal" }));
		const r = await createOnebotAdapter(obOpts()).send(obAdapter(), obTarget(), TEXT);
		expect(r).toMatchObject({ ok: false, err: "HTTP 500 Internal" });
	});

	it("fetch 抛错 → ok:false,展开 cause code,logger.warn", async () => {
		const cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
		fetchMock.mockRejectedValueOnce(Object.assign(new Error("fetch failed"), { cause }));
		const logger = makeLogger();
		const r = await createOnebotAdapter(obOpts(logger)).send(obAdapter(), obTarget(), TEXT);
		expect(r.ok).toBe(false);
		expect(r.err).toContain("ECONNREFUSED");
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});

	it("retryTimes:首次失败后重试成功(fetch 调用 2 次)", async () => {
		fetchMock
			.mockResolvedValueOnce(res({ ok: true, json: { status: "failed", retcode: 1 } }))
			.mockResolvedValueOnce(res({ ok: true, json: { status: "ok", retcode: 0 } }));
		const ad = createOnebotAdapter(obOpts());
		const r = await ad.send(obAdapter({ retryTimes: 1, retryIntervalMs: 0 }), obTarget(), TEXT);
		expect(r.ok).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("wrong platform → ok:false", async () => {
		const ad = createOnebotAdapter(obOpts());
		const r = await ad.send(obAdapter(), obTarget({ platform: "webhook" }), TEXT);
		expect(r.ok).toBe(false);
		expect(r.err).toMatch(/wrong platform/);
	});
});

describe("onebot — isAvailable / probe", () => {
	it("isAvailable:平台匹配+启用+baseUrl 非空", () => {
		const ad = createOnebotAdapter(obOpts());
		expect(ad.isAvailable(obAdapter(), obTarget())).toBe(true);
		expect(ad.isAvailable(obAdapter({}), obTarget({ enabled: false }))).toBe(false);
		expect(ad.isAvailable(obAdapter({ baseUrl: "" }), obTarget())).toBe(false);
	});

	it("probe:/get_status ok → ok:true;retcode!=0 → ok:false", async () => {
		fetchMock.mockResolvedValueOnce(res({ ok: true, json: { status: "ok", retcode: 0 } }));
		const ad = createOnebotAdapter(obOpts());
		expect((await ad.probe(obAdapter())).ok).toBe(true);
		expect(fetchMock.mock.calls[0]?.[0]).toBe("http://nb:3000/get_status");

		fetchMock.mockResolvedValueOnce(res({ ok: true, json: { status: "failed", retcode: 9 } }));
		expect((await ad.probe(obAdapter())).ok).toBe(false);
	});

	it("probe:wrong platform → ok:false", async () => {
		const ad = createOnebotAdapter(obOpts());
		const wrong = { ...obAdapter(), platform: "webhook" } as unknown as PushAdapter;
		const r = await ad.probe(wrong);
		expect(r).toMatchObject({ ok: false });
		expect(r.err).toMatch(/wrong platform/);
	});
});

// ---------------------------------------------------------------------------
// OneBot — 正向 WS(ws)
// ---------------------------------------------------------------------------

describe("onebot — 正向 WS(ws)", () => {
	it("reconcile 建连后 send:发 action 帧,按 echo 收响应", async () => {
		const bot = await startFakeBotServer();
		const ad = createOnebotAdapter(obOpts());
		const adapter = obWsAdapter(bot.port);
		ad.reconcile?.([adapter]);
		await waitFor(async () => (await ad.probe(adapter)).ok === true);
		const r = await ad.send(adapter, obTarget(), TEXT);
		expect(r.ok).toBe(true);
		const frame = bot.received.find((f) => f.action === "send_group_msg");
		expect(frame).toBeDefined();
		expect((frame as { params: { group_id: number } }).params.group_id).toBe(123);
		ad.dispose?.();
	});

	it("isAvailable:ws 看 url 非空", () => {
		const ad = createOnebotAdapter(obOpts());
		expect(ad.isAvailable(obWsAdapter(3001), obTarget())).toBe(true);
		expect(ad.isAvailable(obWsAdapter(3001, { url: "" }), obTarget())).toBe(false);
		ad.dispose?.();
	});

	it("echo 乱序:并发两次 send,bot 乱序回 → 各自匹配正确响应", async () => {
		const pending: Array<{ ws: WebSocket; echo: unknown }> = [];
		const wss = new WebSocketServer({ port: 0 });
		await once(wss, "listening");
		const port = (wss.address() as AddressInfo).port;
		wss.on("connection", (ws) => {
			ws.on("message", (raw) => {
				pending.push({ ws, echo: (JSON.parse(raw.toString()) as { echo: unknown }).echo });
				if (pending.length === 2) {
					// 乱序:后到的先回
					for (const p of [...pending].reverse()) {
						p.ws.send(JSON.stringify({ status: "ok", retcode: 0, echo: p.echo }));
					}
				}
			});
		});
		cleanups.push(() => new Promise<void>((r) => wss.close(() => r())));
		const ad = createOnebotAdapter(obOpts());
		const adapter = obWsAdapter(port);
		ad.reconcile?.([adapter]);
		await waitFor(() => wss.clients.size > 0);
		await sleep(40);
		const [r1, r2] = await Promise.all([
			ad.send(adapter, obTarget({ session: { groupId: "111" } }), TEXT),
			ad.send(adapter, obTarget({ session: { groupId: "222" } }), TEXT),
		]);
		expect(r1.ok).toBe(true);
		expect(r2.ok).toBe(true);
		ad.dispose?.();
	});

	it("响应超时:bot 不回 → ok:false 且 err 含超时", async () => {
		const bot = await startFakeBotServer({ autoReply: false });
		const ad = createOnebotAdapter(obOpts());
		const adapter = obWsAdapter(bot.port, { timeoutMs: 120 });
		ad.reconcile?.([adapter]);
		await waitFor(() => bot.connections.length > 0);
		await sleep(40);
		const r = await ad.send(adapter, obTarget(), TEXT);
		expect(r.ok).toBe(false);
		expect(r.err).toMatch(/超时/);
		ad.dispose?.();
	});

	it("未 reconcile / 未连接时 send → ok:false", async () => {
		const ad = createOnebotAdapter(obOpts());
		const r = await ad.send(obWsAdapter(59_998), obTarget(), TEXT);
		expect(r.ok).toBe(false);
		expect(r.err).toMatch(/未连接/);
		ad.dispose?.();
	});

	it("入站事件帧(无 echo)被忽略,不影响后续 send", async () => {
		const bot = await startFakeBotServer();
		const ad = createOnebotAdapter(obOpts());
		const adapter = obWsAdapter(bot.port);
		ad.reconcile?.([adapter]);
		await waitFor(() => bot.connections.length > 0);
		await sleep(40);
		// bot 推 heartbeat 元事件 + message 事件(都无 echo)
		bot.connections[0]?.send(
			JSON.stringify({ post_type: "meta_event", meta_event_type: "heartbeat" }),
		);
		bot.connections[0]?.send(JSON.stringify({ post_type: "message", message: "hi" }));
		await sleep(30);
		expect((await ad.send(adapter, obTarget(), TEXT)).ok).toBe(true);
		ad.dispose?.();
	});

	it("reconcile 幂等:config 未变重复 reconcile 不重连", async () => {
		const bot = await startFakeBotServer();
		const ad = createOnebotAdapter(obOpts());
		const adapter = obWsAdapter(bot.port);
		ad.reconcile?.([adapter]);
		await waitFor(() => bot.connections.length === 1);
		ad.reconcile?.([adapter]);
		ad.reconcile?.([adapter]);
		await sleep(60);
		expect(bot.connections.length).toBe(1); // 没有新建连接
		ad.dispose?.();
	});

	it("断线重连:bot 服务端断开后 adapter 自动重连并恢复推送", async () => {
		const bot = await startFakeBotServer();
		const ad = createOnebotAdapter(obOpts());
		const adapter = obWsAdapter(bot.port);
		ad.reconcile?.([adapter]);
		await waitFor(() => bot.connections.length === 1);
		bot.connections[0]?.close(); // 服务端主动断开
		await waitFor(() => bot.connections.length === 2, 8000); // 退避后重连(起点 ~1s)
		await waitFor(async () => (await ad.probe(adapter)).ok === true, 4000);
		expect((await ad.send(adapter, obTarget(), TEXT)).ok).toBe(true);
		ad.dispose?.();
	}, 15_000);
});

// ---------------------------------------------------------------------------
// OneBot — 反向 WS(ws-reverse)
// ---------------------------------------------------------------------------

describe("onebot — 反向 WS(ws-reverse)", () => {
	it("bot 连入后 send:监听端口 → bot 收 action 帧", async () => {
		const port = await freePort();
		const ad = createOnebotAdapter(obOpts());
		const adapter = obRevAdapter(port);
		ad.reconcile?.([adapter]);
		const bot = await connectWithRetry(`ws://127.0.0.1:${port}`);
		await waitFor(async () => (await ad.probe(adapter)).ok === true);
		const r = await ad.send(adapter, obTarget(), TEXT);
		expect(r.ok).toBe(true);
		expect(bot.received.some((f) => f.action === "send_group_msg")).toBe(true);
		ad.dispose?.();
	});

	it("isAvailable:ws-reverse 恒 true(运行期可达性由 send/probe 判断)", () => {
		const ad = createOnebotAdapter(obOpts());
		expect(ad.isAvailable(obRevAdapter(6700), obTarget())).toBe(true);
		ad.dispose?.();
	});

	it("无 bot 连入 → send ok:false,probe 提示等待 bot", async () => {
		const port = await freePort();
		const ad = createOnebotAdapter(obOpts());
		const adapter = obRevAdapter(port);
		ad.reconcile?.([adapter]);
		await sleep(60);
		const r = await ad.send(adapter, obTarget(), TEXT);
		expect(r.ok).toBe(false);
		expect(r.err).toMatch(/无 bot/);
		const p = await ad.probe(adapter);
		expect(p.ok).toBe(false);
		expect(p.err).toMatch(/等待 bot/);
		ad.dispose?.();
	});

	it("握手鉴权:token 不匹配 → 连接被拒;token 正确 → 可推送", async () => {
		const port = await freePort();
		const ad = createOnebotAdapter(obOpts());
		const adapter = obRevAdapter(port, { accessToken: "right" });
		ad.reconcile?.([adapter]);
		await sleep(60);
		// 不带 token:握手后被 close(1008),不计入活跃 bot
		await connectWithRetry(`ws://127.0.0.1:${port}`);
		await sleep(80);
		expect((await ad.send(adapter, obTarget(), TEXT)).ok).toBe(false);
		// 带正确 token → 注册为活跃 bot
		await connectWithRetry(`ws://127.0.0.1:${port}`, { authorization: "Bearer right" });
		await waitFor(async () => (await ad.probe(adapter)).ok === true);
		expect((await ad.send(adapter, obTarget(), TEXT)).ok).toBe(true);
		ad.dispose?.();
	});

	it("端口绑定失败(EADDRINUSE)→ probe 报错", async () => {
		const port = await freePort();
		const blocker = createServer();
		await new Promise<void>((r) => blocker.listen(port, r));
		cleanups.push(() => new Promise<void>((r) => blocker.close(() => r())));
		const ad = createOnebotAdapter(obOpts());
		const adapter = obRevAdapter(port);
		ad.reconcile?.([adapter]);
		await waitFor(async () => {
			const p = await ad.probe(adapter);
			return p.ok === false && /绑定失败|EADDRINUSE/i.test(p.err ?? "");
		});
		ad.dispose?.();
	});

	it("端口变更:reconcile 换 port → 旧端口释放、新端口监听", async () => {
		const portA = await freePort();
		const ad = createOnebotAdapter(obOpts());
		ad.reconcile?.([obRevAdapter(portA)]);
		await sleep(80);
		const portB = await freePort();
		ad.reconcile?.([obRevAdapter(portB)]); // 同 id a1,换 port
		await sleep(80);
		// 旧端口应已释放 —— 能重新占用
		const reuse = createServer();
		cleanups.push(() => new Promise<void>((r) => reuse.close(() => r())));
		await expect(
			new Promise<void>((resolve, reject) => {
				reuse.once("error", reject);
				reuse.listen(portA, resolve);
			}),
		).resolves.toBeUndefined();
		// 新端口能连入并推送
		await connectWithRetry(`ws://127.0.0.1:${portB}`);
		await waitFor(async () => (await ad.probe(obRevAdapter(portB))).ok === true);
		ad.dispose?.();
	});

	it("dispose:关闭反向监听器,端口释放", async () => {
		const port = await freePort();
		const ad = createOnebotAdapter(obOpts());
		ad.reconcile?.([obRevAdapter(port)]);
		await sleep(80);
		ad.dispose?.();
		await sleep(80);
		const reuse = createServer();
		cleanups.push(() => new Promise<void>((r) => reuse.close(() => r())));
		await expect(
			new Promise<void>((resolve, reject) => {
				reuse.once("error", reject);
				reuse.listen(port, resolve);
			}),
		).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// OneBot — transport 切换 / reconcile 收敛 / dispose 幂等(状态化生命周期)
// ---------------------------------------------------------------------------

describe("onebot — transport 切换 / reconcile 收敛", () => {
	it("ws → http:reconcile 后正向连接被关闭、端口释放", async () => {
		const bot = await startFakeBotServer();
		const ad = createOnebotAdapter(obOpts());
		ad.reconcile?.([obWsAdapter(bot.port)]);
		await waitFor(() => bot.connections.length === 1);
		// 同 id a1 切到 http —— 不再在 desiredFwd 里,正向连接应被关闭
		ad.reconcile?.([obAdapter()]);
		await waitFor(() => bot.connections[0]?.readyState === WebSocket.CLOSED, 4000);
		// http 形态走 fetch,不依赖 ws 连接
		fetchMock.mockResolvedValueOnce(res({ ok: true, json: { status: "ok", retcode: 0 } }));
		expect((await ad.send(obAdapter(), obTarget(), TEXT)).ok).toBe(true);
		ad.dispose?.();
	});

	it("ws-reverse → ws:reconcile 后旧反向端口释放、新正向连接建立", async () => {
		const revPort = await freePort();
		const ad = createOnebotAdapter(obOpts());
		ad.reconcile?.([obRevAdapter(revPort)]);
		await sleep(80);
		const bot = await startFakeBotServer();
		ad.reconcile?.([obWsAdapter(bot.port)]); // 同 id a1
		await waitFor(() => bot.connections.length === 1, 4000);
		// 旧反向端口应已释放
		const reuse = createServer();
		cleanups.push(() => new Promise<void>((r) => reuse.close(() => r())));
		await expect(
			new Promise<void>((resolve, reject) => {
				reuse.once("error", reject);
				reuse.listen(revPort, resolve);
			}),
		).resolves.toBeUndefined();
		ad.dispose?.();
	});

	it("adapter 从集合移除(禁用/删除):reconcile 关掉其正向连接", async () => {
		const bot = await startFakeBotServer();
		const ad = createOnebotAdapter(obOpts());
		ad.reconcile?.([obWsAdapter(bot.port)]);
		await waitFor(() => bot.connections.length === 1);
		// 空集合 —— 等价于 adapter 被禁用 / 删除
		ad.reconcile?.([]);
		await waitFor(() => bot.connections[0]?.readyState === WebSocket.CLOSED, 4000);
		// send 此时应失败(连接已关、不重连)
		expect((await ad.send(obWsAdapter(bot.port), obTarget(), TEXT)).ok).toBe(false);
		ad.dispose?.();
	});

	it("dispose 幂等:重复调用不抛错", async () => {
		const bot = await startFakeBotServer();
		const ad = createOnebotAdapter(obOpts());
		ad.reconcile?.([obWsAdapter(bot.port)]);
		await waitFor(() => bot.connections.length === 1);
		ad.dispose?.();
		expect(() => ad.dispose?.()).not.toThrow();
		expect(() => ad.dispose?.()).not.toThrow();
	});

	it("dispose 后 reconcile 是 no-op(disposed 守卫)", async () => {
		const bot = await startFakeBotServer();
		const ad = createOnebotAdapter(obOpts());
		ad.dispose?.();
		ad.reconcile?.([obWsAdapter(bot.port)]); // disposed → 应被忽略
		await sleep(120);
		expect(bot.connections.length).toBe(0);
	});

	it("dispose 后正向连接不再重连(closed 守卫)", async () => {
		const bot = await startFakeBotServer();
		const ad = createOnebotAdapter(obOpts());
		ad.reconcile?.([obWsAdapter(bot.port)]);
		await waitFor(() => bot.connections.length === 1);
		ad.dispose?.();
		await waitFor(() => bot.connections[0]?.readyState === WebSocket.CLOSED, 4000);
		// 退避窗口足够长,若 closed 守卫失效会看到第 2 条连接
		await sleep(1500);
		expect(bot.connections.length).toBe(1);
	}, 8000);

	it("dispose 时未决 send 立即 reject,不挂到超时", async () => {
		// bot 不回响应;dispose 应让在途 send 立刻以 ok:false 结束
		const bot = await startFakeBotServer({ autoReply: false });
		const ad = createOnebotAdapter(obOpts());
		const adapter = obWsAdapter(bot.port, { timeoutMs: 10_000 });
		ad.reconcile?.([adapter]);
		await waitFor(() => bot.connections.length === 1);
		await sleep(40);
		const sendP = ad.send(adapter, obTarget(), TEXT);
		await sleep(40); // 确保 call() 已挂进 pending
		const t0 = Date.now();
		ad.dispose?.();
		const r = await sendP;
		expect(r.ok).toBe(false);
		// 远小于 10s timeout —— 证明是 rejectAll 兜的,不是等超时
		expect(Date.now() - t0).toBeLessThan(2000);
	});

	it("send 时连接断开:未决请求被 reject(不永久挂起)", async () => {
		const bot = await startFakeBotServer({ autoReply: false });
		const ad = createOnebotAdapter(obOpts());
		const adapter = obWsAdapter(bot.port, { timeoutMs: 10_000 });
		ad.reconcile?.([adapter]);
		await waitFor(() => bot.connections.length === 1);
		await sleep(40);
		const sendP = ad.send(adapter, obTarget(), TEXT);
		await sleep(40);
		const t0 = Date.now();
		bot.connections[0]?.terminate(); // 服务端粗暴断开
		const r = await sendP;
		expect(r.ok).toBe(false);
		expect(Date.now() - t0).toBeLessThan(3000);
		ad.dispose?.();
	});

	it("反向 WS:bot 断开后注销,probe 回到等待 bot", async () => {
		const port = await freePort();
		const ad = createOnebotAdapter(obOpts());
		const adapter = obRevAdapter(port);
		ad.reconcile?.([adapter]);
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		await new Promise<void>((resolve, reject) => {
			ws.once("open", () => resolve());
			ws.once("error", reject);
		});
		ws.on("message", (raw) => {
			const f = JSON.parse(raw.toString()) as { echo: unknown };
			ws.send(JSON.stringify({ status: "ok", retcode: 0, echo: f.echo }));
		});
		await waitFor(async () => (await ad.probe(adapter)).ok === true);
		ws.close();
		// bot 注销后 channel 为空 → probe 回到「等待 bot」
		await waitFor(async () => {
			const p = await ad.probe(adapter);
			return p.ok === false && /等待 bot/.test(p.err ?? "");
		}, 4000);
		ad.dispose?.();
	});
});

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

function whAdapter(over: Record<string, unknown> = {}): PushAdapter {
	return {
		id: "w1",
		name: "wh",
		platform: "webhook",
		enabled: true,
		config: { url: "http://hook.local", secret: "s3cr3t", headers: { "x-team": "ops" }, ...over },
	} as unknown as PushAdapter;
}
function whTarget(over: Record<string, unknown> = {}): PushTarget {
	return {
		id: "wt1",
		name: "团队群",
		adapterId: "w1",
		platform: "webhook",
		scope: "group",
		enabled: true,
		session: {},
		...over,
	} as unknown as PushTarget;
}

describe("webhook — send", () => {
	it("happy:POST JSON body 含元信息 + secret/自定义 header", async () => {
		fetchMock.mockResolvedValueOnce(res({ ok: true }));
		const ad = createWebhookAdapter({ logger: makeLogger() });
		const r = await ad.send(whAdapter(), whTarget(), TEXT);
		expect(r.ok).toBe(true);
		expect(fetchMock.mock.calls[0]?.[0]).toBe("http://hook.local");
		const init = lastInit() as { headers: Record<string, string> };
		expect(init.headers["x-bilibili-notify-secret"]).toBe("s3cr3t");
		expect(init.headers["x-team"]).toBe("ops");
		const body = lastBody();
		expect(body).toMatchObject({
			targetId: "wt1",
			targetName: "团队群",
			scope: "group",
			private: false,
			payload: { kind: "text", text: "hello" },
		});
		expect(typeof body.ts).toBe("string");
	});

	it("image/composite payload 序列化为 base64", async () => {
		fetchMock.mockResolvedValue(res({ ok: true }));
		const ad = createWebhookAdapter({ logger: makeLogger() });
		await ad.send(whAdapter(), whTarget(), {
			kind: "image",
			image: { buffer: Buffer.from("PIC"), mime: "image/png" },
			caption: "c",
		});
		expect(lastBody().payload).toEqual({
			kind: "image",
			image: { mime: "image/png", data: Buffer.from("PIC").toString("base64") },
			caption: "c",
		});
		await ad.send(whAdapter(), whTarget(), {
			kind: "composite",
			segments: [
				{ type: "text", text: "t" },
				{ type: "image", buffer: Buffer.from("Q"), mime: "image/jpeg" },
			],
		});
		expect(lastBody().payload).toEqual({
			kind: "composite",
			segments: [
				{ type: "text", text: "t" },
				{ type: "image", mime: "image/jpeg", data: Buffer.from("Q").toString("base64") },
			],
		});
	});

	it("非 2xx → ok:false err=HTTP", async () => {
		fetchMock.mockResolvedValueOnce(res({ ok: false, status: 503, statusText: "Unavailable" }));
		const r = await createWebhookAdapter({ logger: makeLogger() }).send(
			whAdapter(),
			whTarget(),
			TEXT,
		);
		expect(r).toMatchObject({ ok: false, err: "HTTP 503 Unavailable" });
	});

	it("fetch 抛错 → ok:false + logger.warn", async () => {
		fetchMock.mockRejectedValueOnce(new Error("network down"));
		const logger = makeLogger();
		const r = await createWebhookAdapter({ logger }).send(whAdapter(), whTarget(), TEXT);
		expect(r).toMatchObject({ ok: false, err: "network down" });
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});

	it("wrong platform → ok:false", async () => {
		const ad = createWebhookAdapter({ logger: makeLogger() });
		const r = await ad.send(whAdapter(), whTarget({ platform: "onebot" }), TEXT);
		expect(r.ok).toBe(false);
		expect(r.err).toMatch(/wrong platform/);
	});
});

describe("webhook — isAvailable / probe", () => {
	it("isAvailable:平台匹配+启用+url 非空", () => {
		const ad = createWebhookAdapter({ logger: makeLogger() });
		expect(ad.isAvailable(whAdapter(), whTarget())).toBe(true);
		expect(ad.isAvailable(whAdapter({ url: "" }), whTarget())).toBe(false);
		expect(ad.isAvailable(whAdapter(), whTarget({ enabled: false }))).toBe(false);
	});

	it("probe 恒为 ok:null(webhook 无连通探测)", async () => {
		const ad = createWebhookAdapter({ logger: makeLogger() });
		const r = await ad.probe(whAdapter());
		expect(r.ok).toBeNull();
		expect(r.err).toMatch(/does not support/);
	});
});
