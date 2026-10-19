/**
 * OneBot 适配器的「QQ 小程序卡」能力 —— 链接解析回小程序卡靠它。
 *
 * 守四件事:
 *   - 探测:拿**空参数**调 `get_mini_app_ark`,按 OneBot 11 的 retcode 判 —— 1404(不支持的
 *     动作)= 不支持;1400(参数错)= 支持,接口在;别的 = 未探测出来,带原因。零副作用,
 *     不真向腾讯要卡。认接口不认实现名:NapCat 只是今天唯一已知能签的,逻辑里不出现它。
 *   - 缓存:结果按连接记住;配置变了或连接没了才丢。适配器不自己发起探测,也不管重探节奏与
 *     「探不出来沿用上次」—— 那两件归宿主(`push/__tests__/target-dispatcher.test.ts`)。
 *   - 真发:先签 ark(`type: "bili"` + 四个字段),再把返回值当 `json` 段发进群。
 *   - 发不了:签卡收到 1404 → 翻成不支持、不发;别的失败只报这一条,缓存不动。
 *
 * fetch 用 vi.stubGlobal mock,只走 http transport —— 三种 transport 调 action 共一条路,
 * ws 的连接层在 adapters.test.ts 里守。
 */

import type {
	Connection,
	NotificationPayload,
	PushTarget,
	ServiceContext,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reconcileAdapter } from "../../__tests__/support/adapter-ctx.js";
import { snapshotFor } from "../../__tests__/support/connection-snapshot.js";
import { createOnebotAdapter } from "../onebot.js";

function makeLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

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
		signal: new AbortController().signal,
		track: () => {},
	};
}

function obConnection(over: Record<string, unknown> = {}): Connection {
	return {
		id: "a1",
		name: "ob",
		adapterKey: "onebot",
		platform: "onebot",
		platformSnapshot: snapshotFor("onebot"),
		enabled: true,
		settings: { transport: "http", baseUrl: "http://nb:3000", retryIntervalMs: 0, ...over },
	} as unknown as Connection;
}

function obTarget(): PushTarget {
	return {
		id: "t1",
		name: "群",
		connectionId: "a1",
		scope: "group",
		enabled: true,
		kind: "session",
		address: "123",
	} as unknown as PushTarget;
}

const CARD: NotificationPayload = {
	kind: "miniapp-card",
	title: "【测试】一个视频",
	desc: "简介",
	picUrl: "https://i0.hdslb.com/cover.jpg",
	path: "pages/video/video?bvid=BV1zMtU6uEEb",
	jumpUrl: "https://www.bilibili.com/video/BV1zMtU6uEEb",
};

/** 腾讯签回来的 ark(NapCat 原样交出 data);结构只要能 JSON 序列化就行。 */
const ARK = {
	app: "com.tencent.miniapp_01",
	prompt: "[QQ小程序]哔哩哔哩",
	config: { token: "signed" },
	meta: { detail_1: { qqdocurl: "https://b23.tv/abc" } },
};

/** 真的 `Response`:请求客户端要读头和字节。 */
function res(o: { ok: boolean; status?: number; json?: unknown }): Response {
	return new Response(JSON.stringify(o.json ?? {}), { status: o.status ?? (o.ok ? 200 : 500) });
}

/** 生产里登记即 `start(ctx)`:适配器先拿到 `ctx.http` 才发得出请求。名单先空着,之后的 `reconcileAdapter` 走「连接变了」。 */
function startedOnebot(opts: Parameters<typeof createOnebotAdapter>[0]) {
	const ad = createOnebotAdapter(opts);
	reconcileAdapter(ad, []);
	return ad;
}

const okFrame = (data?: unknown) => res({ ok: true, json: { status: "ok", retcode: 0, data } });
const failFrame = (retcode: number, message = "") =>
	res({ ok: true, json: { status: "failed", retcode, message } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** 假 fetch:不回应,直到请求客户端的超时中止它。 */
function hangUntilAborted(_url: URL, init: RequestInit): Promise<Response> {
	return new Promise((_resolve, reject) => {
		(init.signal as AbortSignal).addEventListener("abort", () => {
			reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
		});
	});
}

function calledPath(i: number): string {
	return String(fetchMock.mock.calls[i]?.[0]);
}
function calledBody(i: number): Record<string, unknown> {
	const init = fetchMock.mock.calls[i]?.[1] as { body: string } | undefined;
	if (!init) throw new Error(`第 ${i} 次 fetch 没发生`);
	return JSON.parse(init.body);
}

/** 读能力快照;适配器没实现就是测试写错了地方,直接炸。 */
function capsOf(ad: ReturnType<typeof createOnebotAdapter>) {
	const c = ad.capabilities?.(obConnection());
	if (!c) throw new Error("onebot adapter 没实现 capabilities");
	return c;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("onebot — 小程序卡能力探测", () => {
	it("没探过 → 未探测", () => {
		const ad = startedOnebot({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		expect(capsOf(ad).miniAppCard).toEqual({ state: "unknown" });
	});

	it("空参数调 get_mini_app_ark;1404 = 这个实现没有这个接口 → 不支持,带原因", async () => {
		fetchMock.mockResolvedValueOnce(failFrame(1404, "不支持的api"));
		const ad = startedOnebot({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		const caps = await ad.probeCapabilities?.(obConnection());
		expect(calledPath(0)).toBe("http://nb:3000/get_mini_app_ark");
		expect(calledBody(0)).toEqual({});
		expect(caps?.miniAppCard).toMatchObject({ state: "unsupported" });
		expect(caps?.miniAppCard.state === "unsupported" && caps.miniAppCard.reason).toMatch(
			/get_mini_app_ark/,
		);
		// 探过就记住,不再打接口。
		expect(capsOf(ad)).toEqual(caps);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("1400 = 接口在、只是嫌参数空 → 支持;没真向腾讯要过卡", async () => {
		fetchMock.mockResolvedValueOnce(failFrame(1400, "参数错误"));
		const ad = startedOnebot({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		const caps = await ad.probeCapabilities?.(obConnection());
		expect(caps?.miniAppCard).toMatchObject({ state: "supported" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("HTTP 404(把 action 当路径的实现)同样是不支持", async () => {
		fetchMock.mockResolvedValueOnce(res({ ok: false, status: 404 }));
		const ad = startedOnebot({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		const caps = await ad.probeCapabilities?.(obConnection());
		expect(caps?.miniAppCard).toMatchObject({ state: "unsupported" });
	});

	it("连不上、或回了别的错 → 如实回「还不知道」,原因带出来;每问一次都真探(节奏归宿主)", async () => {
		fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
		const ad = startedOnebot({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		const caps = await ad.probeCapabilities?.(obConnection());
		expect(caps?.miniAppCard).toMatchObject({
			state: "unknown",
			reason: expect.stringMatching(/ECONNREFUSED/),
		});

		fetchMock.mockResolvedValueOnce(failFrame(200, "packet backend 未就绪"));
		const again = await ad.probeCapabilities?.(obConnection());
		expect(again?.miniAppCard).toMatchObject({
			state: "unknown",
			reason: expect.stringMatching(/packet/),
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("探实过之后再探不出来 → 如实回「还不知道」;沿用上次的答案是宿主的事", async () => {
		fetchMock.mockResolvedValueOnce(failFrame(1400));
		const ad = startedOnebot({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		expect((await ad.probeCapabilities?.(obConnection()))?.miniAppCard).toMatchObject({
			state: "supported",
		});

		fetchMock.mockRejectedValueOnce(new Error("ETIMEDOUT"));
		expect((await ad.probeCapabilities?.(obConnection()))?.miniAppCard).toMatchObject({
			state: "unknown",
		});
	});

	it("reconcile 不自己探能力:http 连接第一次对账也不打接口,探不探由宿主定", async () => {
		const ad = startedOnebot({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		reconcileAdapter(ad, [obConnection()]);
		await sleep(30);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(capsOf(ad).miniAppCard).toEqual({ state: "unknown" });
		ad.stop();
	});

	it("配置没变的 reconcile 不动缓存 —— 健康探测写回 probeState 就会触发一次", async () => {
		fetchMock.mockResolvedValueOnce(failFrame(1400));
		const ad = startedOnebot({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		reconcileAdapter(ad, [obConnection()]);
		await ad.probeCapabilities?.(obConnection());
		expect(capsOf(ad).miniAppCard.state).toBe("supported");

		reconcileAdapter(ad, [obConnection()]);
		reconcileAdapter(ad, [obConnection()]);
		await sleep(30);
		expect(capsOf(ad).miniAppCard.state).toBe("supported");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		ad.stop();
	});

	it("配置变了(指向别的实现)→ 丢掉旧答案、不自己重探;连接没了 → 答案一起没了", async () => {
		fetchMock.mockResolvedValueOnce(failFrame(1400));
		const ad = startedOnebot({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		reconcileAdapter(ad, [obConnection()]);
		await ad.probeCapabilities?.(obConnection());
		expect(capsOf(ad).miniAppCard.state).toBe("supported");

		reconcileAdapter(ad, [obConnection({ baseUrl: "http://other:3000" })]);
		await sleep(30);
		expect(capsOf(ad).miniAppCard.state).toBe("unknown");
		expect(fetchMock).toHaveBeenCalledTimes(1);

		fetchMock.mockResolvedValueOnce(failFrame(1404));
		await ad.probeCapabilities?.(obConnection({ baseUrl: "http://other:3000" }));
		expect(calledPath(1)).toBe("http://other:3000/get_mini_app_ark");
		expect(capsOf(ad).miniAppCard.state).toBe("unsupported");

		reconcileAdapter(ad, []);
		expect(capsOf(ad).miniAppCard.state).toBe("unknown");
		ad.stop();
	});
});

describe("onebot — 发小程序卡", () => {
	it("先用 bili 模板签 ark,再把返回值当 json 段发进群;签成了就等于支持", async () => {
		fetchMock.mockResolvedValueOnce(okFrame(ARK)).mockResolvedValueOnce(okFrame());
		const ad = startedOnebot({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		const r = await ad.send(obConnection(), obTarget(), CARD);
		expect(r.ok).toBe(true);
		expect(calledPath(0)).toBe("http://nb:3000/get_mini_app_ark");
		// 签卡请求里 jumpUrl 是**小程序页面路径**、webUrl 才是网页链接(QQ 客户端源码里
		// 前者接的是 OpenSDK 的 mini_program_path,后者接的是 url,签回来落到 qqdocurl)。
		// 把网址填进 jumpUrl 签出来的卡点开是「页面不存在」—— 2026-09-07 群友反馈那次。
		expect(calledBody(0)).toEqual({
			type: "bili",
			title: CARD.kind === "miniapp-card" ? CARD.title : "",
			desc: "简介",
			picUrl: "https://i0.hdslb.com/cover.jpg",
			jumpUrl: "pages/video/video?bvid=BV1zMtU6uEEb",
			webUrl: "https://www.bilibili.com/video/BV1zMtU6uEEb",
		});
		expect(calledPath(1)).toBe("http://nb:3000/send_group_msg");
		expect(calledBody(1)).toEqual({
			group_id: 123,
			message: [{ type: "json", data: { data: JSON.stringify(ARK) } }],
		});
		expect(capsOf(ad).miniAppCard.state).toBe("supported");
	});

	it("NapCat 把 ark 又套了一层 data 交出来(真机踩到:整层发出去腾讯直接吞)→ 剥掉再发", async () => {
		fetchMock.mockResolvedValueOnce(okFrame({ data: ARK })).mockResolvedValueOnce(okFrame());
		const ad = startedOnebot({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		const r = await ad.send(obConnection(), obTarget(), CARD);
		expect(r.ok).toBe(true);
		expect(calledBody(1).message).toEqual([{ type: "json", data: { data: JSON.stringify(ARK) } }]);
	});

	it("回来的东西怎么看都不像 ark(没有 app 字段)→ 不发,报失败", async () => {
		fetchMock.mockResolvedValueOnce(okFrame({ data: { foo: 1 } }));
		const ad = startedOnebot({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		const r = await ad.send(obConnection(), obTarget(), CARD);
		// 回了成功、内容却不是约定的形状。
		expect(r).toEqual({ ok: false, code: "invalid", message: "签小程序卡失败: 返回的不是 ark" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("实现把 ark 以字符串交出来 → 原样当 json 段的 data", async () => {
		const raw = JSON.stringify(ARK);
		fetchMock.mockResolvedValueOnce(okFrame(raw)).mockResolvedValueOnce(okFrame());
		const ad = startedOnebot({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		await ad.send(obConnection(), obTarget(), CARD);
		expect(calledBody(1).message).toEqual([{ type: "json", data: { data: raw } }]);
	});

	it("签卡收到 1404 → 不发、报这个实现发不了小程序卡,能力翻成不支持", async () => {
		fetchMock.mockResolvedValueOnce(failFrame(1404, "不支持的api"));
		const ad = startedOnebot({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		const r = await ad.send(obConnection(), obTarget(), CARD);
		expect(r).toMatchObject({ ok: false, code: "unsupported", upstreamCode: 1404 });
		expect(!r.ok && r.message).toMatch(/get_mini_app_ark/);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(capsOf(ad).miniAppCard.state).toBe("unsupported");
	});

	it("签卡收到 HTTP 404(把 action 当路径的实现)→ 同样是 unsupported,码写成 http:404", async () => {
		fetchMock.mockResolvedValueOnce(res({ ok: false, status: 404 }));
		const ad = startedOnebot({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		const r = await ad.send(obConnection(), obTarget(), CARD);
		expect(r).toMatchObject({ ok: false, code: "unsupported", upstreamCode: "http:404" });
		expect(capsOf(ad).miniAppCard.state).toBe("unsupported");
	});

	it("签卡超时 → timeout(卡还没发出去,不是「结果未知」)", async () => {
		fetchMock.mockImplementationOnce(hangUntilAborted);
		const ad = startedOnebot({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		const r = await ad.send(obConnection({ timeoutMs: 50 }), obTarget(), CARD);
		expect(r).toMatchObject({ ok: false, code: "timeout" });
		expect(!r.ok && r.message).toMatch(/^签小程序卡失败: .*超时/);
		expect(!r.ok && r.message).not.toMatch(/结果未知/);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("签卡时连不上 → unavailable", async () => {
		fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
		const ad = startedOnebot({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		const r = await ad.send(obConnection(), obTarget(), CARD);
		expect(r).toMatchObject({ ok: false, code: "unavailable" });
		// 话是客户端的:前缀说明哪一步,底层原因跟在后面。
		expect(!r.ok && r.message).toMatch(/^签小程序卡失败: .*ECONNREFUSED/);
	});

	it("卡签好了、发出去之后超时 → indeterminate", async () => {
		fetchMock.mockResolvedValueOnce(okFrame(ARK)).mockImplementationOnce(hangUntilAborted);
		const ad = startedOnebot({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		const r = await ad.send(obConnection({ timeoutMs: 50 }), obTarget(), CARD);
		expect(r).toMatchObject({ ok: false, code: "indeterminate" });
	});

	it("签卡失败但不是 1404(比如 packet 后端没起来)→ 只报这一条失败,支持与否的缓存不动", async () => {
		fetchMock.mockResolvedValueOnce(failFrame(1400));
		const ad = startedOnebot({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		await ad.probeCapabilities?.(obConnection());

		fetchMock.mockResolvedValueOnce(failFrame(200, "packet backend 未就绪"));
		const r = await ad.send(obConnection(), obTarget(), CARD);
		expect(r).toEqual({
			ok: false,
			code: "unknown",
			message: "签小程序卡失败: packet backend 未就绪",
			upstreamCode: 200,
		});
		expect(capsOf(ad).miniAppCard.state).toBe("supported");
	});

	it("签回来的是空的 → 不发空 json 段,报失败", async () => {
		fetchMock.mockResolvedValueOnce(okFrame(undefined));
		const ad = startedOnebot({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		const r = await ad.send(obConnection(), obTarget(), CARD);
		expect(r.ok).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
