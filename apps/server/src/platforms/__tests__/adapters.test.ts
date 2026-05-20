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

import type { NotificationPayload, PushAdapter, PushTarget } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOnebotAdapter } from "../onebot.js";
import { createWebhookAdapter } from "../webhook.js";

function makeLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

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
afterEach(() => {
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
		config: { baseUrl: "http://nb:3000/", accessToken: "tok", retryIntervalMs: 0, ...over },
	} as unknown as PushAdapter;
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
		const ad = createOnebotAdapter({ logger: makeLogger() });
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
		const ad = createOnebotAdapter({ logger: makeLogger() });
		await ad.send(obAdapter(), obTarget({ scope: "private", session: { userId: "456" } }), TEXT);
		expect(fetchMock.mock.calls[0]?.[0]).toBe("http://nb:3000/send_private_msg");
		expect(lastBody().user_id).toBe(456);
	});

	it("opts.private 覆盖 group scope", async () => {
		fetchMock.mockResolvedValueOnce(res({ ok: true, json: { status: "ok", retcode: 0 } }));
		const ad = createOnebotAdapter({ logger: makeLogger() });
		await ad.send(obAdapter(), obTarget({ session: { userId: "789" } }), TEXT, { private: true });
		expect(fetchMock.mock.calls[0]?.[0]).toBe("http://nb:3000/send_private_msg");
		expect(lastBody().user_id).toBe(789);
	});

	it("private 缺 userId / group 缺 groupId → ok:false 且不发请求", async () => {
		const ad = createOnebotAdapter({ logger: makeLogger() });
		const p = await ad.send(obAdapter(), obTarget({ scope: "private", session: {} }), TEXT);
		expect(p).toMatchObject({ ok: false, err: "private: userId missing" });
		const g = await ad.send(obAdapter(), obTarget({ session: {} }), TEXT);
		expect(g).toMatchObject({ ok: false, err: "group: groupId missing" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("空 composite payload → empty payload,不发请求", async () => {
		const ad = createOnebotAdapter({ logger: makeLogger() });
		const r = await ad.send(obAdapter(), obTarget(), { kind: "composite", segments: [] });
		expect(r).toMatchObject({ ok: false, err: "empty payload" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("composite 段 → OneBot segment(text/image base64/link/at-all)", async () => {
		fetchMock.mockResolvedValueOnce(res({ ok: true, json: { status: "ok", retcode: 0 } }));
		const ad = createOnebotAdapter({ logger: makeLogger() });
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
});

describe("onebot — 失败与重试", () => {
	it("retcode!=0:ok:false,err 取 wording,logger.warn", async () => {
		fetchMock.mockResolvedValueOnce(
			res({ ok: true, json: { status: "failed", retcode: 1404, wording: "无权限" } }),
		);
		const logger = makeLogger();
		const r = await createOnebotAdapter({ logger }).send(obAdapter(), obTarget(), TEXT);
		expect(r).toMatchObject({ ok: false, err: "无权限" });
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});

	it("HTTP 非 2xx → ok:false err=HTTP <status>", async () => {
		fetchMock.mockResolvedValueOnce(res({ ok: false, status: 500, statusText: "Internal" }));
		const r = await createOnebotAdapter({ logger: makeLogger() }).send(
			obAdapter(),
			obTarget(),
			TEXT,
		);
		expect(r).toMatchObject({ ok: false, err: "HTTP 500 Internal" });
	});

	it("fetch 抛错 → ok:false,展开 cause code,logger.warn", async () => {
		const cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
		fetchMock.mockRejectedValueOnce(Object.assign(new Error("fetch failed"), { cause }));
		const logger = makeLogger();
		const r = await createOnebotAdapter({ logger }).send(obAdapter(), obTarget(), TEXT);
		expect(r.ok).toBe(false);
		expect(r.err).toContain("ECONNREFUSED");
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});

	it("retryTimes:首次失败后重试成功(fetch 调用 2 次)", async () => {
		fetchMock
			.mockResolvedValueOnce(res({ ok: true, json: { status: "failed", retcode: 1 } }))
			.mockResolvedValueOnce(res({ ok: true, json: { status: "ok", retcode: 0 } }));
		const ad = createOnebotAdapter({ logger: makeLogger() });
		const r = await ad.send(obAdapter({ retryTimes: 1, retryIntervalMs: 0 }), obTarget(), TEXT);
		expect(r.ok).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("wrong platform → ok:false", async () => {
		const ad = createOnebotAdapter({ logger: makeLogger() });
		const r = await ad.send(obAdapter(), obTarget({ platform: "webhook" }), TEXT);
		expect(r.ok).toBe(false);
		expect(r.err).toMatch(/wrong platform/);
	});
});

describe("onebot — isAvailable / probe", () => {
	it("isAvailable:平台匹配+启用+baseUrl 非空", () => {
		const ad = createOnebotAdapter({ logger: makeLogger() });
		expect(ad.isAvailable(obAdapter(), obTarget())).toBe(true);
		expect(ad.isAvailable(obAdapter({}), obTarget({ enabled: false }))).toBe(false);
		expect(ad.isAvailable(obAdapter({ baseUrl: "" }), obTarget())).toBe(false);
	});

	it("probe:/get_status ok → ok:true;retcode!=0 → ok:false", async () => {
		fetchMock.mockResolvedValueOnce(res({ ok: true, json: { status: "ok", retcode: 0 } }));
		const ad = createOnebotAdapter({ logger: makeLogger() });
		expect((await ad.probe(obAdapter())).ok).toBe(true);
		expect(fetchMock.mock.calls[0]?.[0]).toBe("http://nb:3000/get_status");

		fetchMock.mockResolvedValueOnce(res({ ok: true, json: { status: "failed", retcode: 9 } }));
		expect((await ad.probe(obAdapter())).ok).toBe(false);
	});

	it("probe:wrong platform → ok:false", async () => {
		const ad = createOnebotAdapter({ logger: makeLogger() });
		const wrong = { ...obAdapter(), platform: "webhook" } as unknown as PushAdapter;
		const r = await ad.probe(wrong);
		expect(r).toMatchObject({ ok: false });
		expect(r.err).toMatch(/wrong platform/);
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
