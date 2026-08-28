/**
 * 单元测试 — /api/qq/bind/* 扫码建 bot 端点。
 *
 * - POST /bind/start:创建绑定任务,返回 taskId + 二维码 data URL + 轮询间隔;
 *   bindKey 只存 server 内存,不出响应。
 * - POST /bind/poll:轮询;completed/expired 即消费掉任务(再问 404),上游故障
 *   保留任务可重试;任务 10 分钟 TTL。
 */
import { createCipheriv, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createQQRoute } from "../qq.js";
import type { RouteDeps } from "../types.js";

let fetchMock: ReturnType<typeof vi.fn>;
function res(status: number, body: unknown): Response {
	return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	delete process.env.BN_QQ_BIND_HOST;
});

function makeDeps(): RouteDeps {
	return {
		qqSessionRegistry: null,
		store: { getAdapters: () => [] },
		runtime: {
			serviceCtx: { logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } },
		},
	} as unknown as RouteDeps;
}

/** 按腾讯回传格式加密(nonce+ct+tag,base64)。 */
function encryptLikeTencent(plaintext: string, keyB64: string): string {
	const key = Buffer.from(keyB64, "base64");
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	return Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString("base64");
}

/** 抓 create_bind_task 预递的密钥,给完成态响应加密用。 */
function capturedBindKey(): string {
	const call = fetchMock.mock.calls.find(([url]) => String(url).includes("create_bind_task"));
	if (!call) throw new Error("create_bind_task 未被调用");
	return JSON.parse(String((call[1] as RequestInit).body)).key as string;
}

function mockCreateOk(taskId = "T1"): void {
	fetchMock.mockImplementationOnce(async () => res(200, { retcode: 0, data: { task_id: taskId } }));
}

async function startTask(app: ReturnType<typeof createQQRoute>): Promise<string> {
	mockCreateOk();
	const r = await app.request("/bind/start", { method: "POST" });
	expect(r.status).toBe(200);
	const body = (await r.json()) as { taskId: string };
	return body.taskId;
}

async function poll(app: ReturnType<typeof createQQRoute>, taskId: string): Promise<Response> {
	return await app.request("/bind/poll", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ taskId }),
	});
}

describe("POST /api/qq/bind/start", () => {
	it("返回 taskId + 二维码 data URL + 轮询间隔;bindKey 不出响应", async () => {
		mockCreateOk();
		const app = createQQRoute(makeDeps());
		const r = await app.request("/bind/start", { method: "POST" });
		expect(r.status).toBe(200);
		const body = (await r.json()) as Record<string, unknown>;
		expect(body.taskId).toBe("T1");
		expect(String(body.qr)).toMatch(/^data:image\//);
		expect(body.interval).toBe(2);
		expect(body).not.toHaveProperty("bindKey");
	});

	it("上游 retcode 非 0 → 502 带上游话", async () => {
		fetchMock.mockResolvedValueOnce(res(200, { retcode: 1001, msg: "系统繁忙" }));
		const app = createQQRoute(makeDeps());
		const r = await app.request("/bind/start", { method: "POST" });
		expect(r.status).toBe(502);
		expect(((await r.json()) as { message: string }).message).toContain("系统繁忙");
	});

	it("BN_QQ_BIND_HOST 逃生口:打到注入的 host", async () => {
		process.env.BN_QQ_BIND_HOST = "mirror.example.com";
		mockCreateOk();
		const app = createQQRoute(makeDeps());
		await app.request("/bind/start", { method: "POST" });
		expect(String((fetchMock.mock.calls[0] as [string])[0])).toBe(
			"https://mirror.example.com/lite/create_bind_task",
		);
	});
});

describe("POST /api/qq/bind/poll", () => {
	it("未知 taskId → 404", async () => {
		const app = createQQRoute(makeDeps());
		const r = await poll(app, "nope");
		expect(r.status).toBe(404);
	});

	it("pending → 保留任务,可继续轮", async () => {
		const app = createQQRoute(makeDeps());
		const taskId = await startTask(app);
		fetchMock.mockResolvedValueOnce(res(200, { retcode: 0, data: { status: 1 } }));
		expect(await (await poll(app, taskId)).json()).toEqual({ status: "pending" });
		fetchMock.mockResolvedValueOnce(res(200, { retcode: 0, data: { status: 1 } }));
		expect((await poll(app, taskId)).status).toBe(200);
	});

	it("completed → 回凭据并消费任务(再问 404)", async () => {
		const app = createQQRoute(makeDeps());
		const taskId = await startTask(app);
		fetchMock.mockImplementationOnce(async () =>
			res(200, {
				retcode: 0,
				data: {
					status: 2,
					bot_appid: "102000001",
					bot_encrypt_secret: encryptLikeTencent("S3cret", capturedBindKey()),
				},
			}),
		);
		const r = await poll(app, taskId);
		expect(await r.json()).toEqual({ status: "created", appId: "102000001", appSecret: "S3cret" });
		expect((await poll(app, taskId)).status).toBe(404);
	});

	it("expired → 消费任务(再问 404)", async () => {
		const app = createQQRoute(makeDeps());
		const taskId = await startTask(app);
		fetchMock.mockResolvedValueOnce(res(200, { retcode: 0, data: { status: 3 } }));
		expect(await (await poll(app, taskId)).json()).toEqual({ status: "expired" });
		expect((await poll(app, taskId)).status).toBe(404);
	});

	it("上游故障 → 502 且保留任务(下轮可重试)", async () => {
		const app = createQQRoute(makeDeps());
		const taskId = await startTask(app);
		fetchMock.mockResolvedValueOnce(res(500, {}));
		expect((await poll(app, taskId)).status).toBe(502);
		fetchMock.mockResolvedValueOnce(res(200, { retcode: 0, data: { status: 1 } }));
		expect(await (await poll(app, taskId)).json()).toEqual({ status: "pending" });
	});

	it("任务超 10 分钟 TTL → 404", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		const app = createQQRoute(makeDeps());
		const taskId = await startTask(app);
		vi.setSystemTime(1_000_000 + 11 * 60_000);
		expect((await poll(app, taskId)).status).toBe(404);
	});
});
