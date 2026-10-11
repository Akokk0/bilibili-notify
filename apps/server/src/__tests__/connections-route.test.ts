import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { settingsSegment } from "../bilibili/settings.js";
import { createSecretCellsReader } from "../push/connection-settings.js";
import { createConnectionsRoute } from "../routes/connections.js";
import type { RouteDeps } from "../routes/types.js";
import { createAppRuntime } from "../runtime/bootstrap.js";
import { fakeAdapterContext } from "./support/adapter-ctx.js";
import { registerBuiltinAdapterStubs } from "./support/builtin-adapter-stubs.js";
import { snapshotFor } from "./support/connection-snapshot.js";

/**
 * `GET /api/connections/capabilities` —— 面板「连接支持情况」读的那张表。索引一级:
 * 连接 id → 这条连接的能力。直连与拓展连接都列;取不到能力的连接不列;引擎还没起来是空表,不是错。
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
	it("按连接 id 一级列出,直连与拓展连接都在;取不到能力的不出现", async () => {
		const unknown = { state: "unknown" };
		const direct = {
			atAll: { state: "supported", checkedAt: 1 },
			inbound: { state: "supported", checkedAt: 1 },
			miniAppCard: { state: "supported", checkedAt: 1 },
		};
		const bridged = {
			atAll: { state: "unsupported", reason: "桥报的:这个 bot 发不了 @全体", checkedAt: 2 },
			inbound: unknown,
			miniAppCard: unknown,
		};
		const app = createConnectionsRoute(
			makeDeps({
				connections: [
					{ id: "ob", adapterKey: "onebot", platform: "onebot" },
					{ id: "bot", adapterKey: "bridge", platform: "telegram" },
					{ id: "qq", adapterKey: "qq-official", platform: "qq-official" },
				],
				engines: {
					connectionCapabilities: (id: string) =>
						id === "ob" ? direct : id === "bot" ? bridged : undefined,
				},
			}),
		);
		const res = await app.request("/capabilities");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ob: direct, bot: bridged });
	});

	it("引擎还没起来 → 空表,200", async () => {
		const app = createConnectionsRoute(
			makeDeps({ connections: [{ id: "ob", adapterKey: "onebot", platform: "onebot" }] }),
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
		const runtime = createAppRuntime(
			{
				server: { host: "127.0.0.1", port: 8787 },
				dataDir,
				logLevel: "silent",
			},
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
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
		runtime = createAppRuntime(
			{
				server: { host: "127.0.0.1", port: 8787 },
				dataDir,
				logLevel: "silent",
			},
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		// 内置三个适配器在场(真 schema、真候选,不连网)—— 配置仓据此验 settings,POST 据此抄快照。
		registerBuiltinAdapterStubs(runtime.adapterRegistry);
		app = createConnectionsRoute({
			runtime: {
				serviceCtx: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
				adapterRegistry: runtime.adapterRegistry,
			},
			store: runtime.configStore,
			connectionSecrets: createSecretCellsReader(runtime.adapterRegistry),
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
		adapterKey: "onebot",
		platformSnapshot: snapshotFor("onebot"),
		settings: {
			transport: "http",
			baseUrl: "http://127.0.0.1:3000",
			protocolVersion: "v11",
			headers: {},
			timeoutMs: 15_000,
			imageMinTimeoutMs: 30_000,
			mergeForwardMinTimeoutMs: 60_000,
			maxRetries: 0,
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

	const webhookBody = {
		id: "33333333-3333-4333-8333-333333333333",
		name: "钉钉",
		enabled: true,
		adapterKey: "webhook",
		platform: "dingtalk",
		settings: { url: "https://oapi.dingtalk.com/robot/send?access_token=tok", headers: {} },
	};

	it("POST 新建:平台快照由宿主从适配器的候选里抄,体里带来的 platformSnapshot / probeState 一律忽略", async () => {
		const res = await app.request(
			"/",
			jsonInit("POST", {
				...webhookBody,
				platformSnapshot: { label: "我伪造的", shortLabel: "伪", color: "#000" },
				probeState: { status: "reachable", lastCheckedAt: "2026-01-01T00:00:00.000Z" },
			}),
		);
		expect(res.status).toBe(200);
		const saved = runtime.configStore.getConnection(webhookBody.id);
		expect(saved?.platformSnapshot).toEqual(snapshotFor("dingtalk"));
		expect(saved).not.toHaveProperty("probeState");
		// 响应里的也是宿主抄的那份
		const rows = (await res.json()) as Array<{ id: string; platformSnapshot: unknown }>;
		expect(rows.find((r) => r.id === webhookBody.id)?.platformSnapshot).toEqual(
			snapshotFor("dingtalk"),
		);
		// 端点形态的连接带出它的托管目标
		expect(runtime.configStore.getTargets().map((t) => t.connectionId)).toEqual([webhookBody.id]);
	});

	it("POST 适配器不在场 → 503 unavailable,什么都没存", async () => {
		const res = await app.request(
			"/",
			jsonInit("POST", { ...webhookBody, adapterKey: "ghost-ext", platform: "telegram" }),
		);
		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({ code: "unavailable" });
		expect(runtime.configStore.getConnections()).toEqual([]);
	});

	it("POST 平台不在适配器的候选里 → 400 invalid,issues 点名 platform", async () => {
		const res = await app.request("/", jsonInit("POST", { ...webhookBody, platform: "telegram" }));
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			code: "invalid",
			issues: [{ path: ["platform"] }],
		});
		expect(runtime.configStore.getConnections()).toEqual([]);
	});

	it("POST 适配器没有候选口(拓展提供的)→ 填中性快照,平台名取体里的", async () => {
		runtime.adapterRegistry.register(
			{
				adapterKey: "fake-ext",
				settingsSchema: z.object({ token: z.string() }),
				isAvailable: () => true,
				send: async () => ({ ok: true, latencyMs: 1 }),
				probe: async () => ({ ok: true, latencyMs: 1 }),
				start() {},
				stop() {},
			},
			fakeAdapterContext().ctx,
		);
		const body = {
			id: "44444444-4444-4444-8444-444444444444",
			name: "借来的 bot",
			enabled: true,
			adapterKey: "fake-ext",
			platform: "telegram",
			settings: { token: "t" },
		};
		const res = await app.request("/", jsonInit("POST", body));
		expect(res.status).toBe(200);
		expect(runtime.configStore.getConnection(body.id)?.platformSnapshot).toEqual(
			snapshotFor("telegram"),
		);
	});

	it("POST 设置过不了适配器的规则 → 400 invalid,issues 的路径以 settings 打头", async () => {
		const res = await app.request(
			"/",
			jsonInit("POST", { ...webhookBody, settings: { url: "not-a-url" } }),
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			code: "invalid",
			issues: [{ path: ["settings", "url"] }],
		});
		expect(runtime.configStore.getConnections()).toEqual([]);
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
 * `POST /:id/probe` —— 探一次连接通不通、回报结果:探到了什么都回 200,体是 `Result<{ latencyMs }>`;
 * 请求本身不成(没这条连接、引擎没起)才是非 2xx。结果写进连接的 `probeState`(`unsupported` 也记)。
 */
describe("connections route — POST /:id/probe", () => {
	function testApp(probe: unknown, opts: { engines?: boolean; known?: boolean } = {}) {
		const recordConnectionProbeState = vi.fn(async () => ({}));
		const app = createConnectionsRoute({
			runtime: {
				serviceCtx: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
				engines: opts.engines === false ? null : { probeConnection: vi.fn(async () => probe) },
			},
			store: {
				getConnections: () => (opts.known === false ? [] : [{ id: "c1", adapterKey: "onebot" }]),
				recordConnectionProbeState,
			},
			puppeteer: null,
			wsTicketStore: null,
		} as unknown as RouteDeps);
		return { app, recordConnectionProbeState };
	}

	it("没这条连接 → 404 not_found(请求级失败,不是 200)", async () => {
		const { app } = testApp({ ok: true, latencyMs: 5 }, { known: false });
		const res = await app.request("/c1/probe", { method: "POST" });
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ code: "not_found", message: "没有这条连接" });
	});

	it("引擎还没起 → 503 unavailable", async () => {
		const { app } = testApp({ ok: true, latencyMs: 5 }, { engines: false });
		const res = await app.request("/c1/probe", { method: "POST" });
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({
			code: "unavailable",
			message: "服务还没准备好，请稍后重试",
		});
	});

	it("通 → 200 { ok: true, latencyMs },并把结果写进 probeState", async () => {
		const { app, recordConnectionProbeState } = testApp({ ok: true, latencyMs: 12 });
		const res = await app.request("/c1/probe", { method: "POST" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, latencyMs: 12 });
		expect(recordConnectionProbeState).toHaveBeenCalledWith("c1", {
			status: "reachable",
			lastCheckedAt: expect.any(String),
			latencyMs: 12,
		});
	});

	it("不通 → 200 { ok: false, code, message },没有假的 latencyMs;probeState 记原话", async () => {
		const { app, recordConnectionProbeState } = testApp(
			fail("unauthorized", "拒绝连接", { upstreamCode: "http:401" }),
		);
		const res = await app.request("/c1/probe", { method: "POST" });
		expect(res.status).toBe(200);
		const body = await res.json();
		// 适配器给的码与 upstreamCode 原样过线。
		expect(body).toEqual({
			ok: false,
			code: "unauthorized",
			message: "拒绝连接",
			upstreamCode: "http:401",
		});
		expect(body).not.toHaveProperty("latencyMs");
		// 失败的原话填进 message,码不落盘。
		expect(recordConnectionProbeState).toHaveBeenCalledWith("c1", {
			status: "unreachable",
			lastCheckedAt: expect.any(String),
			message: "拒绝连接",
		});
	});

	it("平台没有探测协议(unsupported)→ 200 unsupported,probeState 也记成 unsupported", async () => {
		const { app, recordConnectionProbeState } = testApp(fail("unsupported", "no probe"));
		const res = await app.request("/c1/probe", { method: "POST" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			ok: false,
			code: "unsupported",
			message: "该平台不支持连接探测",
		});
		expect(recordConnectionProbeState).toHaveBeenCalledWith("c1", {
			status: "unsupported",
			lastCheckedAt: expect.any(String),
		});
	});
});
