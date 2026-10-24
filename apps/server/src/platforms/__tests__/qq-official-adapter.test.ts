import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type {
	Connection,
	Disposable,
	Logger,
	NotificationPayload,
	PushTarget,
	ServiceContext,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { WebSocketServer } from "ws";
import { fakeAdapterContext, reconcileAdapter } from "../../__tests__/support/adapter-ctx.js";
import { snapshotFor } from "../../__tests__/support/connection-snapshot.js";
import { fixedLocale, switchableLocale } from "../../__tests__/support/fixed-locale.js";
import { createQQOfficialAdapter, createQQSessionRegistry } from "../qq-official";

// 今天只有简中有译文:把服务端的 `t` 换成"非简中时带语言前缀"的,好看出换语言后重报的字真的变了。
const spoken = vi.hoisted(() => ({ locale: "zh-CN" }));
vi.mock("../../i18n/index.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../../i18n/index.js")>();
	return {
		...real,
		t: (key: never, vars?: never) => {
			const text = real.t(key, vars);
			return spoken.locale === "zh-CN" ? text : `${spoken.locale}|${text}`;
		},
	};
});

function makeLogger(): Logger {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}
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
		signal: new AbortController().signal,
		track: () => {},
	};
}

function adapterOpts() {
	return {
		logger: makeLogger(),
		serviceCtx: makeServiceCtx(),
		registry: createQQSessionRegistry(),
		locale: fixedLocale(),
	};
}

function qqConnection(over: Record<string, unknown> = {}): Connection {
	return {
		id: "a1",
		name: "qq",
		adapterKey: "qq-official",
		platform: "qq-official",
		platformSnapshot: snapshotFor("qq-official"),
		enabled: true,
		settings: { appId: "APPID", appSecret: "SECRET", sandbox: false, botType: "public", ...over },
	} as unknown as Connection;
}

function qqTarget(scope: string, address: string, parentAddress?: string): PushTarget {
	return {
		id: "t1",
		name: "目标",
		connectionId: "a1",
		kind: "session",
		scope,
		enabled: true,
		address,
		parentAddress,
	} as unknown as PushTarget;
}

const TEXT: NotificationPayload = { kind: "text", text: "阿绫发布了动态" };

/** 生产里登记即 `start(ctx)`:send / probe 用例照同一条路先拿到 `ctx.http`(对账名单先空着)。 */
function startedQQ(opts = adapterOpts()) {
	const ad = createQQOfficialAdapter(opts);
	reconcileAdapter(ad, []);
	return ad;
}

// 底下的 fetch 按 URL 路由:token / gateway / files / messages;请求客户端是真的,所以回应也得是真的 `Response`。
let fetchMock: ReturnType<typeof vi.fn>;
function res(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status });
}
/** 按地址字符串路由的假 fetch(客户端交给 fetch 的第一个参数是 `URL`)。 */
function route(impl: (url: string, init: RequestInit) => Promise<Response> | Response): void {
	fetchMock.mockImplementation((target: URL, init: RequestInit) => impl(String(target), init));
}
/** 假 fetch:不回应,直到请求客户端的超时(或调用方)中止它。 */
function hangUntilAborted(_url: string, init: RequestInit): Promise<Response> {
	return new Promise((_resolve, reject) => {
		(init.signal as AbortSignal).addEventListener("abort", () => {
			reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
		});
	});
}
beforeEach(() => {
	fetchMock = vi.fn();
	route(async (url) => {
		if (url.includes("getAppAccessToken"))
			return res(200, { access_token: "TKN", expires_in: 7200 });
		if (url.endsWith("/files"))
			return res(200, { file_uuid: "FUUID", file_info: "FILEINFO", ttl: 3600 });
		if (url.endsWith("/messages")) return res(200, { id: "MSG1", timestamp: "t" });
		return res(200, {});
	});
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
	spoken.locale = "zh-CN";
});

function callsTo(suffix: string) {
	return fetchMock.mock.calls.filter((c) => String(c[0]).endsWith(suffix));
}
function bodyOf(call: unknown[]): Record<string, unknown> {
	return JSON.parse((call[1] as { body: string }).body);
}

/**
 * 网关连不上经 `ctx.reportProblem({ connectionId })` 只进问题表(推送走 REST,不受网关影响,不私聊):
 * 连续 60 秒不在线才报,连接停用 / 删掉时清。接线的守卫 —— 网关连接那一层的时序在 qq-official-conn.test.ts。
 */
describe("createQQOfficialAdapter — 网关连不上的上报", () => {
	/** 手动拨的定时器:谁登记了多少毫秒的定时看得见,到点由测试叫。 */
	function manualServiceCtx() {
		const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
		const ctx: ServiceContext = {
			...makeServiceCtx(),
			setTimeout(fn, ms): Disposable {
				const timer = { fn, ms, live: true };
				timers.push(timer);
				return {
					dispose: () => {
						timer.live = false;
					},
				};
			},
		};
		return {
			ctx,
			fire: (ms: number) => {
				for (const timer of timers) if (timer.live && timer.ms === ms) timer.fn();
			},
			/** 到点叫掉除了某个时长以外还活着的定时(重连的退避)。 */
			fireAllBut: (ms: number) => {
				for (const timer of [...timers]) {
					if (!timer.live || timer.ms === ms) continue;
					timer.live = false;
					timer.fn();
				}
			},
		};
	}

	/** 网关一直连不上、满 60 秒报出一条:T16 各条的起手。 */
	async function offlineReported(locale: ReturnType<typeof switchableLocale>) {
		route(async (url) => {
			if (url.includes("getAppAccessToken"))
				return res(200, { access_token: "TKN", expires_in: 7200 });
			return res(200, {}); // /gateway 没给 url
		});
		const manual = manualServiceCtx();
		const ad = createQQOfficialAdapter({
			...adapterOpts(),
			serviceCtx: manual.ctx,
			locale,
		});
		const fake = fakeAdapterContext([qqConnection()]);
		const reportProblem = vi.fn();
		const resolveProblem = vi.fn();
		ad.start({ ...fake.ctx, reportProblem, resolveProblem });
		await vi.waitFor(() => expect(callsTo("/gateway").length).toBeGreaterThan(0));
		manual.fire(60_000);
		expect(reportProblem).toHaveBeenCalledTimes(1);
		return { ad, fake, manual, reportProblem, resolveProblem };
	}

	function switchTo(locale: ReturnType<typeof switchableLocale>, to: string) {
		spoken.locale = to;
		locale.set(to);
	}

	const OFFLINE_ZH =
		"网关已经连续一分钟没连上（解析网关地址失败: Error: getGateway 响应无 url），群里和私聊的消息暂时收不到；推送不受影响。";

	// T16 验红:`onOffline` 只报不记原因 / 不订语言,这条红。
	it("网关连不上进了表,换语言后再报一遍:同一个原因,用新语言的字", async () => {
		const locale = switchableLocale();
		const { ad, reportProblem } = await offlineReported(locale);
		expect(reportProblem).toHaveBeenLastCalledWith({
			connectionId: "a1",
			code: "gateway_offline",
			message: OFFLINE_ZH,
		});

		switchTo(locale, "en");
		expect(reportProblem).toHaveBeenCalledTimes(2);
		expect(reportProblem).toHaveBeenLastCalledWith({
			connectionId: "a1",
			code: "gateway_offline",
			message: `en|${OFFLINE_ZH}`,
		});
		ad.stop();
	});

	it("网关又上线了(READY)之后换语言:不再报", async () => {
		const locale = switchableLocale();
		const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		await once(wss, "listening");
		wss.on("connection", (ws) => {
			ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }));
			ws.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "SID" } }));
		});
		try {
			const { ad, manual, reportProblem, resolveProblem } = await offlineReported(locale);
			route(async (url) => {
				if (url.includes("getAppAccessToken"))
					return res(200, { access_token: "TKN", expires_in: 7200 });
				if (url.endsWith("/gateway"))
					return res(200, { url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}` });
				return res(200, {});
			});
			manual.fireAllBut(60_000); // 重连的退避到点
			await vi.waitFor(() => expect(resolveProblem).toHaveBeenCalled());
			expect(resolveProblem).toHaveBeenCalledWith({
				connectionId: "a1",
				code: "gateway_offline",
				notify: false,
			});

			switchTo(locale, "en");
			expect(reportProblem).toHaveBeenCalledTimes(1);
			ad.stop();
		} finally {
			for (const c of wss.clients) c.terminate();
			await new Promise<void>((resolve) => wss.close(() => resolve()));
		}
	});

	it("连接停用(对账清掉)之后换语言:不再报", async () => {
		const locale = switchableLocale();
		const { ad, fake, reportProblem } = await offlineReported(locale);
		fake.setConnections([qqConnection({ appSecret: "" })]);
		fake.fireChanged();

		switchTo(locale, "en");
		expect(reportProblem).toHaveBeenCalledTimes(1);
		ad.stop();
	});

	it("stop() 之后换语言:不再报(语言订阅摘掉了)", async () => {
		const inner = switchableLocale();
		let subscribers = 0;
		const locale = {
			...inner,
			onChange(fn: () => void) {
				subscribers += 1;
				const sub = inner.onChange(fn);
				return {
					dispose() {
						subscribers -= 1;
						sub.dispose();
					},
				};
			},
		};
		const { ad, reportProblem } = await offlineReported(locale);
		expect(subscribers).toBe(1);
		ad.stop();
		expect(subscribers).toBe(0);

		switchTo(locale, "en");
		expect(reportProblem).toHaveBeenCalledTimes(1);
	});

	it("网关一直连不上:满 60 秒报一条 gateway_offline 带原因,只进表;停用连接时清掉且不补「已恢复」", async () => {
		route(async (url) => {
			if (url.includes("getAppAccessToken"))
				return res(200, { access_token: "TKN", expires_in: 7200 });
			return res(200, {}); // /gateway 没给 url
		});
		const { ctx: serviceCtx, fire } = manualServiceCtx();
		const ad = createQQOfficialAdapter({ ...adapterOpts(), serviceCtx });
		const fake = fakeAdapterContext([qqConnection()]);
		const reportProblem = vi.fn();
		const resolveProblem = vi.fn();
		ad.start({ ...fake.ctx, reportProblem, resolveProblem });

		await vi.waitFor(() => expect(callsTo("/gateway").length).toBeGreaterThan(0));
		expect(reportProblem).not.toHaveBeenCalled();
		fire(60_000);
		expect(reportProblem).toHaveBeenCalledTimes(1);
		expect(reportProblem).toHaveBeenCalledWith({
			connectionId: "a1",
			code: "gateway_offline",
			message: expect.stringContaining("getGateway"),
		});

		fake.setConnections([qqConnection({ appSecret: "" })]);
		fake.fireChanged();
		expect(resolveProblem).toHaveBeenCalledWith({
			connectionId: "a1",
			code: "gateway_offline",
			notify: false,
		});
		ad.stop();
	});
});

describe("createQQOfficialAdapter — isAvailable", () => {
	it("enabled + 有 appId/appSecret → true", () => {
		const ad = createQQOfficialAdapter(adapterOpts());
		expect(ad.isAvailable(qqConnection(), qqTarget("group", "G1"))).toBe(true);
	});
	it("缺 appSecret → false", () => {
		const ad = createQQOfficialAdapter(adapterOpts());
		expect(ad.isAvailable(qqConnection({ appSecret: "" }), qqTarget("group", "G1"))).toBe(false);
	});
});

describe("createQQOfficialAdapter — start 之前", () => {
	it("send / probe / listAddressCandidates → unavailable(生产里登记即 start,这一支到不了)", async () => {
		const ad = createQQOfficialAdapter(adapterOpts());
		const sent = await ad.send(qqConnection(), qqTarget("group", "G1"), TEXT);
		expect(sent).toEqual({ ok: false, code: "unavailable", message: "适配器还没启动" });
		const probed = await ad.probe(qqConnection());
		expect(probed).toEqual({ ok: false, code: "unavailable", message: "适配器还没启动" });
		const listed = await ad.listAddressCandidates?.(
			qqConnection(),
			"channel",
			new AbortController().signal,
		);
		expect(listed).toEqual({ ok: false, code: "unavailable", message: "适配器还没启动" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("createQQOfficialAdapter — send 文本", () => {
	it("group:取 token → POST /v2/groups/{openid}/messages,QQBot 头 + msg_type 0", async () => {
		const ad = startedQQ();
		const r = await ad.send(qqConnection(), qqTarget("group", "G1"), TEXT);
		expect(r.ok).toBe(true);
		const msg = callsTo("/v2/groups/G1/messages");
		expect(msg).toHaveLength(1);
		const headers = new Headers(((msg[0] as unknown[])[1] as RequestInit).headers);
		expect(headers.get("authorization")).toBe("QQBot TKN");
		expect(headers.get("x-union-appid")).toBe("APPID");
		expect(bodyOf(msg[0] as unknown[])).toEqual({ content: "阿绫发布了动态", msg_type: 0 });
	});

	it("线上只带鉴权与内容类型:换 token、发消息、探活都不带浏览器身份与 Cookie", async () => {
		const ad = startedQQ();
		await ad.send(qqConnection(), qqTarget("group", "G1"), TEXT);
		await ad.probe(qqConnection());
		const wire = (suffix: string) => {
			const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith(suffix));
			if (!call) throw new Error(`no fetch call to ${suffix}`);
			return Object.fromEntries(new Headers((call[1] as RequestInit).headers));
		};
		expect(wire("getAppAccessToken")).toEqual({ "content-type": "application/json" });
		expect(wire("/v2/groups/G1/messages")).toEqual({
			authorization: "QQBot TKN",
			"x-union-appid": "APPID",
			"content-type": "application/json",
		});
		expect(wire("/gateway")).toEqual({ authorization: "QQBot TKN", "x-union-appid": "APPID" });
	});

	it("发消息的回应慢于客户端默认的 20 秒仍等得到(显式 300 秒的超时只为保住今天没有超时的行为)", async () => {
		vi.useFakeTimers();
		route((url, init) => {
			if (url.includes("getAppAccessToken"))
				return res(200, { access_token: "T", expires_in: 7200 });
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => resolve(res(200, { id: "SLOW" })), 30_000);
				(init.signal as AbortSignal).addEventListener("abort", () => {
					clearTimeout(timer);
					reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
				});
			});
		});
		const ad = startedQQ();
		const pending = ad.send(qqConnection(), qqTarget("group", "G1"), TEXT);
		await vi.advanceTimersByTimeAsync(30_000);
		expect((await pending).ok).toBe(true);
	});

	it("发消息的请求满 300 秒仍没回 → 客户端掐断,翻成 unavailable", async () => {
		vi.useFakeTimers();
		route((url, init) => {
			if (url.includes("getAppAccessToken"))
				return res(200, { access_token: "T", expires_in: 7200 });
			return hangUntilAborted(url, init);
		});
		const ad = startedQQ();
		const pending = ad.send(qqConnection(), qqTarget("group", "G1"), TEXT);
		await vi.advanceTimersByTimeAsync(300_000);
		expect(await pending).toMatchObject({ ok: false, code: "unavailable" });
	});

	it("private:POST /v2/users/{openid}/messages", async () => {
		const ad = startedQQ();
		const r = await ad.send(qqConnection(), qqTarget("private", "U1"), TEXT);
		expect(r.ok).toBe(true);
		expect(callsTo("/v2/users/U1/messages")).toHaveLength(1);
	});

	it("channel:POST /channels/{channelId}/messages,JSON content", async () => {
		const ad = startedQQ();
		const r = await ad.send(qqConnection(), qqTarget("channel", "C1"), TEXT);
		expect(r.ok).toBe(true);
		const msg = callsTo("/channels/C1/messages");
		expect(msg).toHaveLength(1);
		expect(bodyOf(msg[0] as unknown[]).content).toBe("阿绫发布了动态");
	});

	it("session 缺字段 → 直接失败,不发 token/REST", async () => {
		const ad = startedQQ();
		const r = await ad.send(qqConnection(), qqTarget("group", ""), TEXT);
		expect(r).toEqual({ ok: false, code: "invalid", message: "group: groupOpenid missing" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("送达带耗时;失败不带", async () => {
		const ad = startedQQ();
		expect(await ad.send(qqConnection(), qqTarget("group", "G1"), TEXT)).toEqual({
			ok: true,
			latencyMs: expect.any(Number),
		});
		expect(await ad.send(qqConnection(), qqTarget("group", ""), TEXT)).not.toHaveProperty(
			"latencyMs",
		);
	});

	it("空载荷 → invalid(平台对不对归派发器查)", async () => {
		const ad = startedQQ();
		const empty = await ad.send(qqConnection(), qqTarget("group", "G1"), {
			kind: "composite",
			segments: [],
		});
		expect(empty).toEqual({ ok: false, code: "invalid", message: "empty payload" });
	});

	it("取 token 被拒(HTTP 401)→ unauthorized,一条消息都没发", async () => {
		fetchMock.mockImplementation(async () => res(401, { message: "invalid appid" }));
		const ad = startedQQ();
		const r = await ad.send(qqConnection(), qqTarget("group", "G1"), TEXT);
		expect(r).toMatchObject({ ok: false, code: "unauthorized", upstreamCode: "http:401" });
		expect(!r.ok && r.message).toContain("取 App Access Token 失败");
		expect(callsTo("/messages")).toHaveLength(0);
	});

	it("取 token 连不上 → unavailable", async () => {
		fetchMock.mockImplementation(async () => {
			throw new Error("fetch failed");
		});
		const ad = startedQQ();
		const r = await ad.send(qqConnection(), qqTarget("group", "G1"), TEXT);
		expect(r).toMatchObject({ ok: false, code: "unavailable" });
		expect(r).not.toHaveProperty("upstreamCode");
	});

	it("发消息时连不上(fetch 抛错)→ unavailable", async () => {
		route(async (url) => {
			if (url.includes("getAppAccessToken"))
				return res(200, { access_token: "T", expires_in: 7200 });
			throw new Error("socket hang up");
		});
		const ad = startedQQ();
		const r = await ad.send(qqConnection(), qqTarget("group", "G1"), TEXT);
		// 话是请求客户端的话,底层原因仍在里面。
		expect(r).toMatchObject({ ok: false, code: "unavailable" });
		expect(!r.ok && r.message).toContain("socket hang up");
	});
});

describe("createQQOfficialAdapter — send 图片(群/C2C 两步上传)", () => {
	const IMG: NotificationPayload = {
		kind: "image",
		image: { buffer: Buffer.from("png-bytes"), mime: "image/png" },
		caption: "阿绫开播了",
	};

	it("group 图片:先 POST /files(base64 file_data)→ 再 POST /messages media(msg_type 7)", async () => {
		const ad = startedQQ();
		const r = await ad.send(qqConnection(), qqTarget("group", "G1"), IMG);
		expect(r.ok).toBe(true);
		const upload = callsTo("/v2/groups/G1/files");
		expect(upload).toHaveLength(1);
		const uploadBody = bodyOf(upload[0] as unknown[]);
		expect(uploadBody.file_type).toBe(1);
		expect(uploadBody.srv_send_msg).toBe(false);
		expect(uploadBody.file_data).toBe(Buffer.from("png-bytes").toString("base64"));
		const msg = callsTo("/v2/groups/G1/messages");
		expect(msg).toHaveLength(1);
		const msgBody = bodyOf(msg[0] as unknown[]);
		expect(msgBody.msg_type).toBe(7);
		expect(msgBody.media).toEqual({ file_uuid: "FUUID", file_info: "FILEINFO", ttl: 3600 });
		expect(msgBody.content).toBe("阿绫开播了");
	});

	it("group composite 卡片图+文案:合并成一条 media 消息", async () => {
		const ad = startedQQ();
		const r = await ad.send(qqConnection(), qqTarget("group", "G1"), {
			kind: "composite",
			segments: [
				{ kind: "image", buffer: Buffer.from("png-bytes"), mime: "image/png" },
				{ kind: "text", text: "阿绫开播了" },
			],
		});
		expect(r.ok).toBe(true);
		expect(callsTo("/v2/groups/G1/files")).toHaveLength(1);
		const msg = callsTo("/v2/groups/G1/messages");
		expect(msg).toHaveLength(1);
		const msgBody = bodyOf(msg[0] as unknown[]);
		expect(msgBody).toMatchObject({
			content: "阿绫开播了",
			msg_type: 7,
			media: { file_uuid: "FUUID", file_info: "FILEINFO", ttl: 3600 },
		});
	});

	it("channel 图片:multipart file_image 单条(body 是 FormData,无 content-type 头)", async () => {
		const ad = startedQQ();
		const r = await ad.send(qqConnection(), qqTarget("channel", "C1"), IMG);
		expect(r.ok).toBe(true);
		const msg = callsTo("/channels/C1/messages");
		expect(msg).toHaveLength(1);
		const init = msg[0]?.[1] as RequestInit;
		expect(init.body).toBeInstanceOf(FormData);
		expect(new Headers(init.headers).get("content-type")).toBeNull();
		// 频道不走 /files 两步上传。
		expect(callsTo("/files")).toHaveLength(0);
	});
});

describe("createQQOfficialAdapter — 图集 markdown 门控(按 botType)", () => {
	const GALLERY: NotificationPayload = {
		kind: "image-group",
		images: [
			{ url: "https://i0.hdslb.com/1.jpg", width: 800, height: 600 },
			{ url: "https://i0.hdslb.com/2.jpg", width: 1000, height: 1000 },
		],
		mergeForward: true,
	};

	it("私域 group:图集合并成一条 markdown(msg_type 2),不走 /files 上传", async () => {
		const ad = startedQQ();
		const r = await ad.send(qqConnection({ botType: "private" }), qqTarget("group", "G1"), GALLERY);
		expect(r.ok).toBe(true);
		expect(callsTo("/files")).toHaveLength(0); // markdown 不上传
		const msg = callsTo("/v2/groups/G1/messages");
		expect(msg).toHaveLength(1); // 一条搞定
		const body = bodyOf(msg[0] as unknown[]);
		expect(body.msg_type).toBe(2);
		const content = (body.markdown as { content: string }).content;
		expect(content).toContain("![图片 #800px #600px](https://i0.hdslb.com/1.jpg)");
		expect(content).toContain("![图片 #1000px #1000px](https://i0.hdslb.com/2.jpg)");
	});

	it("公域 group:图集走 N 条 media(每图 /files + /messages),不发 markdown", async () => {
		const ad = startedQQ();
		const r = await ad.send(qqConnection({ botType: "public" }), qqTarget("group", "G1"), GALLERY);
		expect(r.ok).toBe(true);
		expect(callsTo("/v2/groups/G1/files")).toHaveLength(2); // 两图各上传一次
		const msgs = callsTo("/v2/groups/G1/messages");
		expect(msgs).toHaveLength(2);
		expect(bodyOf(msgs[0] as unknown[]).msg_type).toBe(7); // media,非 markdown
	});

	it("私域 channel:图集不走 markdown(频道用频道消息 API,markdown 仅群/C2C)", async () => {
		const ad = startedQQ();
		const r = await ad.send(
			qqConnection({ botType: "private" }),
			qqTarget("channel", "C1"),
			GALLERY,
		);
		expect(r.ok).toBe(true);
		const msgs = callsTo("/channels/C1/messages");
		expect(msgs).toHaveLength(2); // 每图一条频道消息(image url)
		expect(bodyOf(msgs[0] as unknown[]).markdown).toBeUndefined();
	});
});

describe("createQQOfficialAdapter — A+ 投递语义 / 失败", () => {
	it("202 + 审核中 → DeliveryResult ok(已提交)", async () => {
		route(async (url) => {
			if (url.includes("getAppAccessToken"))
				return res(200, { access_token: "T", expires_in: 7200 });
			return res(202, {
				code: 304023,
				message: "waiting for audit",
				data: { message_audit: { audit_id: "A1" } },
			});
		});
		const ad = startedQQ();
		const r = await ad.send(qqConnection(), qqTarget("group", "G1"), TEXT);
		expect(r.ok).toBe(true);
	});

	it("4xx 业务错误 → DeliveryResult 失败(带 code)", async () => {
		route(async (url) => {
			if (url.includes("getAppAccessToken"))
				return res(200, { access_token: "T", expires_in: 7200 });
			return res(400, { code: 11293, message: "bad request" });
		});
		const ad = startedQQ();
		const r = await ad.send(qqConnection(), qqTarget("group", "G1"), TEXT);
		expect(r).toEqual({
			ok: false,
			code: "invalid",
			message: "code 11293: bad request",
			upstreamCode: 11293,
		});
	});

	it("被限流(HTTP 429)→ rate_limited", async () => {
		route(async (url) => {
			if (url.includes("getAppAccessToken"))
				return res(200, { access_token: "T", expires_in: 7200 });
			return res(429, { code: 22009, message: "msg limit exceed" });
		});
		const ad = startedQQ();
		const r = await ad.send(qqConnection(), qqTarget("group", "G1"), TEXT);
		expect(r).toMatchObject({ ok: false, code: "rate_limited", upstreamCode: 22009 });
	});

	it("私域图集(markdown)被拒 → 同一套码", async () => {
		route(async (url) => {
			if (url.includes("getAppAccessToken"))
				return res(200, { access_token: "T", expires_in: 7200 });
			return res(200, { code: 40034, message: "markdown not allowed" });
		});
		const ad = startedQQ();
		const r = await ad.send(qqConnection({ botType: "private" }), qqTarget("group", "G1"), {
			kind: "image-group",
			images: [{ url: "https://i0.example/a.png", width: 1, height: 1 }],
			mergeForward: false,
		});
		expect(r).toMatchObject({ ok: false, code: "unknown", upstreamCode: 40034 });
	});

	it("上传富媒体被拒 → 那一步的失败原样带出,不再发消息", async () => {
		route(async (url) => {
			if (url.includes("getAppAccessToken"))
				return res(200, { access_token: "T", expires_in: 7200 });
			if (url.endsWith("/files")) return res(403, { code: 11253, message: "no permission" });
			return res(200, { id: "MSG1" });
		});
		const ad = startedQQ();
		const r = await ad.send(qqConnection(), qqTarget("group", "G1"), {
			kind: "image",
			image: { buffer: Buffer.from("x"), mime: "image/png" },
		} as NotificationPayload);
		expect(r).toMatchObject({ ok: false, code: "unauthorized", upstreamCode: 11253 });
		expect(callsTo("/messages")).toHaveLength(0);
	});

	it("上传回了 2xx 却没有 file_info → invalid(回应不是约定的形状)", async () => {
		route(async (url) => {
			if (url.includes("getAppAccessToken"))
				return res(200, { access_token: "T", expires_in: 7200 });
			if (url.endsWith("/files")) return res(200, { file_uuid: "F" });
			return res(200, { id: "MSG1" });
		});
		const ad = startedQQ();
		const r = await ad.send(qqConnection(), qqTarget("group", "G1"), {
			kind: "image",
			image: { buffer: Buffer.from("x"), mime: "image/png" },
		} as NotificationPayload);
		expect(r).toEqual({ ok: false, code: "invalid", message: "上传成功但无 file_info" });
	});
});

describe("createQQOfficialAdapter — probe / 生命周期", () => {
	// 回归:probe 此前只读 WS 网关 isOnline() 状态 —— 首次启动 reconcile 刚起、握手还没
	// 跑完时必然 ok:false("网关连接中"),但实际推送走的是与 WS 网关无关的 REST 通道
	// (WS 只用来捞 openid),导致"报错但其实能通"的假阴性。改为真实探一次 REST
	// (取 token + 命中 /gateway 只读端点),不依赖 reconcile/WS 状态、也不发消息。
	it("未 reconcile,REST(token+/gateway)可达 → probe ok:true,且是真实网络往返而非读缓存状态", async () => {
		const ad = startedQQ();
		const p = await ad.probe(qqConnection());
		expect(p).toEqual({ ok: true, latencyMs: expect.any(Number) });
		expect(callsTo("/gateway")).toHaveLength(1);
	});

	it("取 App Access Token 失败 → probe ok:false(带错误信息)", async () => {
		fetchMock.mockImplementation(async () => res(401, { message: "invalid appid" }));
		const ad = startedQQ();
		const p = await ad.probe(qqConnection());
		expect(p).toMatchObject({ ok: false, code: "unauthorized", upstreamCode: "http:401" });
		expect(!p.ok && p.message).toContain("取 App Access Token 失败");
		expect(p).not.toHaveProperty("latencyMs");
	});

	it("换 token 的回应里没有 access_token → invalid", async () => {
		fetchMock.mockImplementation(async () => res(200, { code: 100016, message: "bad secret" }));
		const ad = startedQQ();
		expect(await ad.probe(qqConnection())).toMatchObject({ ok: false, code: "invalid" });
	});

	it("probe:平台不对 → invalid;/gateway 连不上 → unavailable", async () => {
		const ad = startedQQ();
		const wrong = { ...qqConnection(), adapterKey: "onebot" } as unknown as Connection;
		expect(await ad.probe(wrong)).toMatchObject({ ok: false, code: "invalid" });
		route(async (url) => {
			if (url.includes("getAppAccessToken"))
				return res(200, { access_token: "T", expires_in: 7200 });
			throw new Error("ENOTFOUND api.sgroup.qq.com");
		});
		const down = await ad.probe(qqConnection());
		expect(down).toMatchObject({ ok: false, code: "unavailable" });
		expect(!down.ok && down.message).toContain("ENOTFOUND api.sgroup.qq.com");
	});

	it("probe 的 /gateway 满 300 秒仍没回 → 客户端掐断,仍是 unavailable(不是 timeout)", async () => {
		vi.useFakeTimers();
		route((url, init) => {
			if (url.includes("getAppAccessToken"))
				return res(200, { access_token: "T", expires_in: 7200 });
			return hangUntilAborted(url, init);
		});
		const ad = startedQQ();
		const pending = ad.probe(qqConnection());
		await vi.advanceTimersByTimeAsync(300_000);
		expect(await pending).toMatchObject({ ok: false, code: "unavailable" });
	});

	it("token 换取成功但 /gateway 非 2xx → probe ok:false", async () => {
		route(async (url) => {
			if (url.includes("getAppAccessToken"))
				return res(200, { access_token: "T", expires_in: 7200 });
			return res(500, {});
		});
		const ad = startedQQ();
		const p = await ad.probe(qqConnection());
		expect(p).toEqual({
			ok: false,
			code: "unavailable",
			message: "HTTP 500",
			upstreamCode: "http:500",
		});
	});

	it("dispose 幂等不抛", () => {
		const ad = createQQOfficialAdapter(adapterOpts());
		expect(() => ad.stop()).not.toThrow();
		expect(() => ad.stop()).not.toThrow();
	});
});

/**
 * 空密钥的 adapter 现在**存得下**了(脱敏备份恢复回来就是这个样子:appSecret 被抹成
 * 空串)。于是 reconcile 必须自己挡住它 —— 否则一个 enabled 但没密钥的 adapter 会被
 * 拉起连接,拿着空 appSecret 反复去换 token、撞 QQ 网关,只换回一串鉴权失败。
 *
 * isAvailable 早就在挡(送不出去),但那只管**发消息**;建连是另一条路,之前只看 enabled。
 */
describe("createQQOfficialAdapter — reconcile 拒绝空密钥", () => {
	const tokenCalls = () =>
		fetchMock.mock.calls.filter((c) => String(c[0]).includes("getAppAccessToken"));

	it("appSecret 为空的 enabled adapter 不建连、不换 token", async () => {
		const ad = createQQOfficialAdapter(adapterOpts());

		reconcileAdapter(ad, [qqConnection({ appSecret: "" })]);
		await new Promise((r) => setTimeout(r, 0));

		expect(tokenCalls()).toHaveLength(0);
		ad.stop();
	});

	// 对照组:同样的等待窗口里,密钥正常的 adapter 确实会去换 token —— 证明上面的 0 次
	// 是被挡住了,而不是「还没来得及发」。
	it("appSecret 正常的 enabled adapter 照常建连", async () => {
		const ad = createQQOfficialAdapter(adapterOpts());

		reconcileAdapter(ad, [qqConnection()]);
		await vi.waitFor(() => expect(tokenCalls().length).toBeGreaterThan(0));

		ad.stop();
	});
});
