import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createConnectionsRoute } from "../routes/connections.js";
import type { RouteDeps } from "../routes/types.js";
import { createAppRuntime } from "../runtime/bootstrap.js";

/**
 * `GET /api/connections/capabilities` —— 面板「连接支持情况」读的那张表。索引两级:
 * 连接 id → 平台名 → 能力。只列有能力概念的平台;引擎还没起来是空表,不是错。
 */
function makeDeps(over: { connections?: unknown[]; engines?: unknown }): RouteDeps {
	return {
		runtime: {
			serviceCtx: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
			engines: over.engines,
		},
		store: { getConnections: () => over.connections ?? [] },
		puppeteer: null,
		wsTicketStore: null,
	} as unknown as RouteDeps;
}

describe("connections route — GET /capabilities", () => {
	it("按连接 id → 平台名两级列出;没有能力概念的(官机 / webhook)不出现", async () => {
		const supported = { miniAppCard: { state: "supported", checkedAt: 1 } };
		const app = createConnectionsRoute(
			makeDeps({
				connections: [
					{ id: "ob", kind: "direct", platform: "onebot" },
					{ id: "qq", kind: "direct", platform: "qq-official" },
				],
				engines: {
					connectionCapabilities: (id: string) => (id === "ob" ? supported : undefined),
				},
			}),
		);
		const res = await app.request("/capabilities");
		expect(res.status).toBe(200);
		// 第二级的键取自那条连接自己的平台 —— 读它的一侧(一个目标 / 一条连接)也带着平台名,
		// 两边对得上才查得到。
		expect(await res.json()).toEqual({ ob: { onebot: supported } });
	});

	it("引擎还没起来 → 空表,200", async () => {
		const app = createConnectionsRoute(
			makeDeps({ connections: [{ id: "ob", kind: "direct", platform: "onebot" }] }),
		);
		const res = await app.request("/capabilities");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({});
	});
});

/**
 * 🔴 **「没有这条连接」是一个跨模块的判据。** 路由靠它把错分成 404 还是 400,而它此前是
 * 拿 `err.issues.message` 跟一句**手抄的字符串**比相等 —— store 那句改一个字,这里就静默
 * 变成 400,两边的测试却各自全绿。所以这条**不 mock store**:让它真抛一次。
 */
describe("connections route — PATCH 一条不存在的", () => {
	let dataDir: string;
	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-conn-route-"));
	});
	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("404,而且判据来自 store 自己抛的那个错", async () => {
		const runtime = createAppRuntime({
			server: { host: "127.0.0.1", port: 8787 },
			dataDir,
			logLevel: "silent",
		});
		await runtime.configStore.load();
		const app = createConnectionsRoute({
			runtime: {
				serviceCtx: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
			},
			store: runtime.configStore,
			puppeteer: null,
			wsTicketStore: null,
		} as unknown as RouteDeps);

		const res = await app.request("/nobody", {
			method: "PATCH",
			body: JSON.stringify({ name: "改个名" }),
			headers: { "content-type": "application/json" },
		});

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ code: "not_found", message: "没有 id 为 nobody 的连接" });
		await runtime.dispose();
	});
});

function jsonInit(method: string, body: unknown): RequestInit {
	return {
		method,
		headers: { "content-type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	};
}

/** 真 store + 真路由:失败的码来自 store 自己抛的那个错,不是测试替身编的。 */
describe("connections route — 写入的失败(真 store)", () => {
	let dataDir: string;
	let runtime: ReturnType<typeof createAppRuntime>;
	let app: ReturnType<typeof createConnectionsRoute>;
	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-conn-route-w-"));
		runtime = createAppRuntime({
			server: { host: "127.0.0.1", port: 8787 },
			dataDir,
			logLevel: "silent",
		});
		await runtime.configStore.load();
		app = createConnectionsRoute({
			runtime: {
				serviceCtx: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
			},
			store: runtime.configStore,
			puppeteer: null,
			wsTicketStore: null,
		} as unknown as RouteDeps);
	});
	afterEach(async () => {
		await runtime.dispose();
		await rm(dataDir, { recursive: true, force: true });
	});

	const onebot = {
		id: "11111111-1111-4111-8111-111111111111",
		name: "NapCat",
		platform: "onebot",
		enabled: true,
		kind: "direct",
		connector: "http",
		config: {
			transport: "http",
			baseUrl: "http://127.0.0.1:3000",
			protocolVersion: "v11",
			headers: {},
			timeoutMs: 15_000,
			imageMinTimeoutMs: 30_000,
			forwardMinTimeoutMs: 60_000,
			retryTimes: 0,
			retryIntervalMs: 1_000,
		},
	};

	it("POST 体不是合法 JSON → 400 invalid", async () => {
		const res = await app.request("/", jsonInit("POST", "{oops"));
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ code: "invalid", message: "请求体不是合法的 JSON" });
	});

	it("POST 校验不过 → 400 invalid,顶上一句中文 + 逐格 issues,不带 scope", async () => {
		const res = await app.request("/", jsonInit("POST", { id: "not-a-uuid" }));
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			code: string;
			message: string;
			issues: unknown[];
			scope?: string;
		};
		expect(body.code).toBe("invalid");
		expect(body.message).toMatch(/^连接有 \d+ 格不合法：/);
		expect(body.issues.length).toBeGreaterThan(0);
		expect(body).not.toHaveProperty("scope");
	});

	it("PATCH 体不是对象 → 400 invalid", async () => {
		const res = await app.request("/x", jsonInit("PATCH", "[1]"));
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "invalid" });
	});

	it("PATCH 想改连接的平台 → 400 invalid(身份格不许改)", async () => {
		await runtime.configStore.upsertConnection(onebot as never);
		const res = await app.request(`/${onebot.id}`, jsonInit("PATCH", { platform: "qq-official" }));
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "invalid" });
	});

	it("DELETE 没这条连接 → 404 not_found", async () => {
		const res = await app.request("/ghost", { method: "DELETE" });
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ code: "not_found", message: "没有这条连接" });
	});

	it("DELETE 还被推送目标引用着 → 409 conflict,话里说清怎么办", async () => {
		await runtime.configStore.upsertConnection(onebot as never);
		await runtime.configStore.upsertTarget({
			id: "22222222-2222-4222-8222-222222222222",
			name: "群聊",
			connectionId: onebot.id,
			kind: "session",
			platform: "onebot",
			scope: "group",
			enabled: true,
			address: "10001",
		} as never);
		const res = await app.request(`/${onebot.id}`, { method: "DELETE" });
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({
			code: "conflict",
			message: "这条连接还被 1 个推送目标用着，先解除引用再删",
		});
	});
});

/**
 * `POST /:id/test` —— 试一次、回报结果:探到了什么都回 200,体是 `Result<{ latencyMs }>`;
 * 请求本身不成(没这条连接、引擎没起)才是非 2xx。写盘的 `testStatus` 是盘上的老格式,仍读 `err`。
 */
describe("connections route — POST /:id/test", () => {
	function testApp(probe: unknown, opts: { engines?: boolean; known?: boolean } = {}) {
		const patchConnection = vi.fn(async () => ({}));
		const app = createConnectionsRoute({
			runtime: {
				serviceCtx: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
				engines: opts.engines === false ? null : { probeConnection: vi.fn(async () => probe) },
			},
			store: {
				getConnections: () => (opts.known === false ? [] : [{ id: "c1", kind: "direct" }]),
				patchConnection,
			},
			puppeteer: null,
			wsTicketStore: null,
		} as unknown as RouteDeps);
		return { app, patchConnection };
	}

	it("没这条连接 → 404 not_found(请求级失败,不是 200)", async () => {
		const { app } = testApp({ ok: true, latencyMs: 5 }, { known: false });
		const res = await app.request("/c1/test", { method: "POST" });
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ code: "not_found", message: "没有这条连接" });
	});

	it("引擎还没起 → 503 unavailable", async () => {
		const { app } = testApp({ ok: true, latencyMs: 5 }, { engines: false });
		const res = await app.request("/c1/test", { method: "POST" });
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({
			code: "unavailable",
			message: "服务还没准备好，请稍后重试",
		});
	});

	it("通 → 200 { ok: true, latencyMs },并把结果写进 testStatus", async () => {
		const { app, patchConnection } = testApp({ ok: true, latencyMs: 12 });
		const res = await app.request("/c1/test", { method: "POST" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, latencyMs: 12 });
		expect(patchConnection).toHaveBeenCalledWith("c1", {
			testStatus: expect.objectContaining({ ok: true, latencyMs: 12 }),
		});
	});

	it("不通 → 200 { ok: false, code, message },没有假的 latencyMs;盘上仍写 err", async () => {
		const { app, patchConnection } = testApp({ ok: false, latencyMs: 30, err: "拒绝连接" });
		const res = await app.request("/c1/test", { method: "POST" });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ ok: false, code: "unavailable", message: "拒绝连接" });
		expect(body).not.toHaveProperty("latencyMs");
		// 盘上的老格式一字不动:testStatus.err(改盘上形状是另一期的事)。
		expect(patchConnection).toHaveBeenCalledWith("c1", {
			testStatus: expect.objectContaining({ ok: false, latencyMs: 30, err: "拒绝连接" }),
		});
	});

	it("平台没有探测协议(ok: null)→ 200 unsupported,不写 testStatus", async () => {
		const { app, patchConnection } = testApp({ ok: null, latencyMs: 0, err: "no probe" });
		const res = await app.request("/c1/test", { method: "POST" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			ok: false,
			code: "unsupported",
			message: "该平台不支持连接探测",
		});
		expect(patchConnection).not.toHaveBeenCalled();
	});
});
