/**
 * 单元测试 — `GET /api/adapters/:adapterKey/candidates`:这个适配器此刻供挑的连接候选
 * (ADR-0024 决策 4)。内置与拓展同一个口;路由只问登记表的视图(出口咽喉,决策 13)。
 */
import type { ConnectionCandidate, PlatformAdapter } from "@bilibili-notify/internal";
import { neutralPlatformDescriptor } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { fakeAdapterContext } from "../../__tests__/support/adapter-ctx.js";
import { createWebhookAdapter } from "../../platforms/webhook.js";
import { createPlatformAdapterRegistry } from "../../push/registry.js";
import { createAdaptersRoute } from "../adapters.js";
import type { RouteDeps } from "../types.js";

function logger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

async function appOf(adapters: readonly PlatformAdapter[], log = logger()) {
	const adapterRegistry = createPlatformAdapterRegistry();
	for (const adapter of adapters) await adapterRegistry.register(adapter, fakeAdapterContext().ctx);
	const deps = {
		runtime: { adapterRegistry, serviceCtx: { logger: log } },
	} as unknown as RouteDeps;
	return { app: createAdaptersRoute(deps), log };
}

/** 手写的拓展适配器:只有键、启停与候选口。 */
function extensionAdapter(
	adapterKey: string,
	listConnectionCandidates: PlatformAdapter["listConnectionCandidates"],
) {
	return {
		adapterKey,
		start: () => {},
		stop: () => {},
		listConnectionCandidates,
	} as unknown as PlatformAdapter;
}

describe("GET /:adapterKey/candidates", () => {
	// 验红:路由里把候选口换成别的(例如恒回空表),这条红。
	it("内置 webhook:四个模板候选(飞书、钉钉、企业微信、通用),不带 boundConnectionId", async () => {
		const { app } = await appOf([createWebhookAdapter({ logger: logger() })]);
		const res = await app.request("/webhook/candidates");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { candidates: ConnectionCandidate[] };
		expect(body.candidates.map((c) => c.platform.platform).sort()).toEqual([
			"dingtalk",
			"feishu",
			"generic",
			"wecom",
		]);
		expect(body.candidates.map((c) => c.name).sort()).toEqual(
			["企业微信机器人", "未指明的 HTTP 端点", "钉钉机器人", "飞书机器人"].sort(),
		);
		for (const c of body.candidates) {
			expect(c.settings).toEqual({ url: "https://example.com/hook", headers: {} });
			expect("boundConnectionId" in c).toBe(false);
		}
	});

	it("拓展在跑:列它交的候选,原样下发(含 via / boundConnectionId)", async () => {
		const candidate: ConnectionCandidate = {
			name: "小电视",
			platform: neutralPlatformDescriptor("telegram"),
			settings: { link: "l1", botId: "b1" },
			via: "家里那台",
			boundConnectionId: "c1",
		};
		const { app } = await appOf([extensionAdapter("bridge", async () => [candidate])]);
		const res = await app.request("/bridge/candidates");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ candidates: [candidate] });
	});

	it("适配器不在登记表 → 503 unavailable", async () => {
		const { app } = await appOf([]);
		const res = await app.request("/bridge/candidates");
		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({ code: "unavailable" });
	});

	it("候选口抛了 → 503 unavailable,并记一行 error", async () => {
		const { app, log } = await appOf([
			extensionAdapter("bridge", async () => {
				throw new Error("桥炸了");
			}),
		]);
		const res = await app.request("/bridge/candidates");
		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({ code: "unavailable", message: "桥炸了" });
		expect(log.error).toHaveBeenCalledTimes(1);
		expect(String(log.error.mock.calls[0]?.[0])).toContain("桥炸了");
	});
});
