import { describe, expect, it, vi } from "vite-plus/test";
import { createConnectionsRoute } from "../routes/connections.js";
import type { RouteDeps } from "../routes/types.js";

/**
 * `GET /api/connections/capabilities` —— 面板「适配器支持情况」读的那张表。按 adapter id 索引,
 * 只列有能力概念的平台;引擎还没起来是空表,不是错。
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

describe("adapters route — GET /capabilities", () => {
	it("按 adapter id 列出有能力概念的平台;没有的(官机 / webhook)不出现", async () => {
		const supported = { miniAppCard: { state: "supported", checkedAt: 1 } };
		const app = createConnectionsRoute(
			makeDeps({
				connections: [
					{ id: "ob", platform: "onebot" },
					{ id: "qq", platform: "qq-official" },
				],
				engines: {
					connectionCapabilities: (id: string) => (id === "ob" ? supported : undefined),
				},
			}),
		);
		const res = await app.request("/capabilities");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ob: supported });
	});

	it("引擎还没起来 → 空表,200", async () => {
		const app = createConnectionsRoute(
			makeDeps({ connections: [{ id: "ob", platform: "onebot" }] }),
		);
		const res = await app.request("/capabilities");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({});
	});
});
