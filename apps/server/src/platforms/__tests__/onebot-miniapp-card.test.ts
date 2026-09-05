/**
 * OneBot 适配器的「QQ 小程序卡」能力 —— 链接解析回小程序卡靠它。
 *
 * 守四件事:
 *   - 探测:拿**空参数**调 `get_mini_app_ark`,按 OneBot 11 的 retcode 判 —— 1404(不支持的
 *     动作)= 不支持;1400(参数错)= 支持,接口在;别的 = 未探测出来,带原因。零副作用,
 *     不真向腾讯要卡。认接口不认实现名:NapCat 只是今天唯一已知能签的,逻辑里不出现它。
 *   - 缓存:结果按适配器记住;reconcile 清掉重探。
 *   - 真发:先签 ark(`type: "bili"` + 四个字段),再把返回值当 `json` 段发进群。
 *   - 发不了:签卡收到 1404 → 翻成不支持、不发;别的失败只报这一条,缓存不动。
 *
 * fetch 用 vi.stubGlobal mock,只走 http transport —— 三种 transport 调 action 共一条路,
 * ws 的连接层在 adapters.test.ts 里守。
 */

import type {
	NotificationPayload,
	PushAdapter,
	PushTarget,
	ServiceContext,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
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
	};
}

function obAdapter(over: Record<string, unknown> = {}): PushAdapter {
	return {
		id: "a1",
		name: "ob",
		platform: "onebot",
		enabled: true,
		config: { transport: "http", baseUrl: "http://nb:3000", retryIntervalMs: 0, ...over },
	} as unknown as PushAdapter;
}

function obTarget(): PushTarget {
	return {
		id: "t1",
		name: "群",
		adapterId: "a1",
		platform: "onebot",
		scope: "group",
		enabled: true,
		session: { groupId: "123" },
	} as unknown as PushTarget;
}

const CARD: NotificationPayload = {
	kind: "miniapp-card",
	title: "【测试】一个视频",
	desc: "简介",
	picUrl: "https://i0.hdslb.com/cover.jpg",
	jumpUrl: "https://www.bilibili.com/video/BV1zMtU6uEEb",
};

/** 腾讯签回来的 ark(NapCat 原样交出 data);结构只要能 JSON 序列化就行。 */
const ARK = {
	app: "com.tencent.miniapp_01",
	prompt: "[QQ小程序]哔哩哔哩",
	config: { token: "signed" },
	meta: { detail_1: { qqdocurl: "https://b23.tv/abc" } },
};

function res(o: { ok: boolean; status?: number; json?: unknown }) {
	return {
		ok: o.ok,
		status: o.status ?? (o.ok ? 200 : 500),
		statusText: "",
		json: async () => o.json ?? {},
		text: async () => JSON.stringify(o.json ?? {}),
	};
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
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

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
	const c = ad.capabilities?.(obAdapter());
	if (!c) throw new Error("onebot adapter 没实现 capabilities");
	return c;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor: 超时");
		await sleep(10);
	}
}

describe("onebot — 小程序卡能力探测", () => {
	it("没探过 → 未探测", () => {
		const ad = createOnebotAdapter({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		expect(capsOf(ad)).toEqual({ miniAppCard: { state: "unknown" } });
	});

	it("空参数调 get_mini_app_ark;1404 = 这个实现没有这个接口 → 不支持,带原因", async () => {
		fetchMock.mockResolvedValueOnce(failFrame(1404, "不支持的api"));
		const ad = createOnebotAdapter({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		const caps = await ad.probeCapabilities?.(obAdapter());
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
		const ad = createOnebotAdapter({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		const caps = await ad.probeCapabilities?.(obAdapter());
		expect(caps?.miniAppCard).toMatchObject({ state: "supported" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("HTTP 404(把 action 当路径的实现)同样是不支持", async () => {
		fetchMock.mockResolvedValueOnce(res({ ok: false, status: 404 }));
		const ad = createOnebotAdapter({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		const caps = await ad.probeCapabilities?.(obAdapter());
		expect(caps?.miniAppCard).toMatchObject({ state: "unsupported" });
	});

	it("连不上、或回了别的错 → 仍是未探测,原因带出来;下次还会再探", async () => {
		fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
		const ad = createOnebotAdapter({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		const caps = await ad.probeCapabilities?.(obAdapter());
		expect(caps?.miniAppCard).toMatchObject({
			state: "unknown",
			reason: expect.stringMatching(/ECONNREFUSED/),
		});

		fetchMock.mockResolvedValueOnce(failFrame(200, "packet backend 未就绪"));
		const again = await ad.probeCapabilities?.(obAdapter());
		expect(again?.miniAppCard).toMatchObject({
			state: "unknown",
			reason: expect.stringMatching(/packet/),
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("探实过之后再探不出来 → 沿用上次的答案,不退回未探测", async () => {
		fetchMock.mockResolvedValueOnce(failFrame(1400));
		const ad = createOnebotAdapter({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		expect((await ad.probeCapabilities?.(obAdapter()))?.miniAppCard).toMatchObject({
			state: "supported",
		});

		// 反向 WS 的 bot 断一次连一次就探一次,撞上实现还没初始化完就是这一趟。
		fetchMock.mockRejectedValueOnce(new Error("ETIMEDOUT"));
		expect((await ad.probeCapabilities?.(obAdapter()))?.miniAppCard).toMatchObject({
			state: "supported",
		});
		expect(capsOf(ad).miniAppCard).toMatchObject({ state: "supported" });
	});

	it("第一次 reconcile 对 http 适配器直接探(它没有「连上」这一刻)", async () => {
		fetchMock.mockResolvedValueOnce(failFrame(1400));
		const ad = createOnebotAdapter({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		ad.reconcile?.([obAdapter()]);
		await waitFor(() => capsOf(ad).miniAppCard.state === "supported");
		expect(calledPath(0)).toBe("http://nb:3000/get_mini_app_ark");
		ad.dispose?.();
	});

	it("配置没变的 reconcile 不动缓存、不重探 —— 健康探测每五分钟写回 testStatus 就会触发一次", async () => {
		fetchMock.mockResolvedValueOnce(failFrame(1400));
		const ad = createOnebotAdapter({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		ad.reconcile?.([obAdapter()]);
		await waitFor(() => capsOf(ad).miniAppCard.state === "supported");

		ad.reconcile?.([obAdapter()]);
		ad.reconcile?.([obAdapter()]);
		await sleep(30);
		expect(capsOf(ad).miniAppCard.state).toBe("supported");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		ad.dispose?.();
	});

	it("配置变了(指向别的实现)→ 丢掉旧答案重探;适配器没了 → 答案一起没了", async () => {
		fetchMock.mockResolvedValueOnce(failFrame(1400));
		const ad = createOnebotAdapter({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		ad.reconcile?.([obAdapter()]);
		await waitFor(() => capsOf(ad).miniAppCard.state === "supported");

		fetchMock.mockResolvedValueOnce(failFrame(1404));
		ad.reconcile?.([obAdapter({ baseUrl: "http://other:3000" })]);
		await waitFor(() => capsOf(ad).miniAppCard.state === "unsupported");
		expect(calledPath(1)).toBe("http://other:3000/get_mini_app_ark");

		ad.reconcile?.([]);
		expect(capsOf(ad).miniAppCard.state).toBe("unknown");
		ad.dispose?.();
	});
});

describe("onebot — 发小程序卡", () => {
	it("先用 bili 模板签 ark,再把返回值当 json 段发进群;签成了就等于支持", async () => {
		fetchMock.mockResolvedValueOnce(okFrame(ARK)).mockResolvedValueOnce(okFrame());
		const ad = createOnebotAdapter({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		const r = await ad.send(obAdapter(), obTarget(), CARD);
		expect(r.ok).toBe(true);
		expect(calledPath(0)).toBe("http://nb:3000/get_mini_app_ark");
		expect(calledBody(0)).toEqual({
			type: "bili",
			title: CARD.kind === "miniapp-card" ? CARD.title : "",
			desc: "简介",
			picUrl: "https://i0.hdslb.com/cover.jpg",
			jumpUrl: "https://www.bilibili.com/video/BV1zMtU6uEEb",
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
		const ad = createOnebotAdapter({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		const r = await ad.send(obAdapter(), obTarget(), CARD);
		expect(r.ok).toBe(true);
		expect(calledBody(1).message).toEqual([{ type: "json", data: { data: JSON.stringify(ARK) } }]);
	});

	it("回来的东西怎么看都不像 ark(没有 app 字段)→ 不发,报失败", async () => {
		fetchMock.mockResolvedValueOnce(okFrame({ data: { foo: 1 } }));
		const ad = createOnebotAdapter({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		const r = await ad.send(obAdapter(), obTarget(), CARD);
		expect(r.ok).toBe(false);
		expect(r.err).toMatch(/ark/);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("实现把 ark 以字符串交出来 → 原样当 json 段的 data", async () => {
		const raw = JSON.stringify(ARK);
		fetchMock.mockResolvedValueOnce(okFrame(raw)).mockResolvedValueOnce(okFrame());
		const ad = createOnebotAdapter({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		await ad.send(obAdapter(), obTarget(), CARD);
		expect(calledBody(1).message).toEqual([{ type: "json", data: { data: raw } }]);
	});

	it("签卡收到 1404 → 不发、报这个实现发不了小程序卡,能力翻成不支持", async () => {
		fetchMock.mockResolvedValueOnce(failFrame(1404, "不支持的api"));
		const ad = createOnebotAdapter({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		const r = await ad.send(obAdapter(), obTarget(), CARD);
		expect(r.ok).toBe(false);
		expect(r.err).toMatch(/get_mini_app_ark/);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(capsOf(ad).miniAppCard.state).toBe("unsupported");
	});

	it("签卡失败但不是 1404(比如 packet 后端没起来)→ 只报这一条失败,支持与否的缓存不动", async () => {
		fetchMock.mockResolvedValueOnce(failFrame(1400));
		const ad = createOnebotAdapter({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		await ad.probeCapabilities?.(obAdapter());

		fetchMock.mockResolvedValueOnce(failFrame(200, "packet backend 未就绪"));
		const r = await ad.send(obAdapter(), obTarget(), CARD);
		expect(r.ok).toBe(false);
		expect(r.err).toMatch(/packet/);
		expect(capsOf(ad).miniAppCard.state).toBe("supported");
	});

	it("签回来的是空的 → 不发空 json 段,报失败", async () => {
		fetchMock.mockResolvedValueOnce(okFrame(undefined));
		const ad = createOnebotAdapter({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		const r = await ad.send(obAdapter(), obTarget(), CARD);
		expect(r.ok).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
