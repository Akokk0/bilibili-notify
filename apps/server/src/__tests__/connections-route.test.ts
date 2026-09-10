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
		await runtime.dispose();
	});
});
