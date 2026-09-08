import { describe, expect, it, vi } from "vite-plus/test";
import { createConnectionsRoute } from "../routes/connections.js";
import type { RouteDeps } from "../routes/types.js";

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
