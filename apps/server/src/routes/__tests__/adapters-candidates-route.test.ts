/**
 * 单元测试 — `GET /api/adapters/:adapterKey/candidates`:这个适配器此刻供挑的连接候选
 * (ADR-0024 决策 4)。内置与拓展同一个口;路由只问登记表的视图(出口咽喉,决策 13)。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectionCandidate, PlatformAdapter } from "@bilibili-notify/internal";
import { neutralPlatformDescriptor } from "@bilibili-notify/internal";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fakeAdapterContext } from "../../__tests__/support/adapter-ctx.js";
import { createWebhookAdapter } from "../../platforms/webhook.js";
import { createAppRuntime } from "../../runtime/bootstrap.js";
import { createAdaptersRoute } from "../adapters.js";
import type { RouteDeps } from "../types.js";

function logger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function appOf(adapters: readonly PlatformAdapter[], log = logger()) {
	const dataRoot = await mkdtemp(join(tmpdir(), "bn-candidates-"));
	const runtime = createAppRuntime(
		{ server: { host: "127.0.0.1", port: 8787 }, dataDir: dataRoot, logLevel: "silent" },
		{ dataRoot },
		{ integrationSettings: [] },
	);
	cleanups.push(async () => {
		await runtime.dispose();
		await rm(dataRoot, { recursive: true, force: true });
	});
	await runtime.configStore.load();
	for (const adapter of adapters)
		await runtime.adapterRegistry.register(adapter, fakeAdapterContext().ctx);
	const deps = {
		runtime: { ...runtime, serviceCtx: { ...runtime.serviceCtx, logger: log } },
	} as unknown as RouteDeps;
	return {
		app: createAdaptersRoute(deps, { extensions: () => [] }),
		log,
		store: runtime.configStore,
	};
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

	it("列候选按适配器与平台刷新所有连接快照,保留设置和没出现的平台,重读后仍在", async () => {
		const platform = {
			...neutralPlatformDescriptor("chat"),
			label: "新平台",
			shortLabel: "新",
			color: "#123456",
			scopes: ["private" as const],
		};
		const { app, store } = await appOf([
			extensionAdapter("relay", async () => [
				{ name: "新候选", platform, settings: { token: "candidate" } },
			]),
		]);
		const old = neutralPlatformDescriptor("chat");
		const ids = [
			"11111111-1111-4111-8111-111111111111",
			"22222222-2222-4222-8222-222222222222",
			"33333333-3333-4333-8333-333333333333",
		];
		for (const [index, id] of ids.entries()) {
			await store.createConnection(
				{
					id,
					name: "原名",
					enabled: false,
					adapterKey: index === 2 ? "elsewhere" : "relay",
					platform: index === 1 ? "absent" : "chat",
					settings: { token: "saved" },
				},
				old,
			);
		}
		expect((await app.request("/relay/candidates")).status).toBe(200);
		await store.load();
		const [changed, absent, elsewhere] = store.getConnections();
		expect(changed).toMatchObject({
			name: "原名",
			enabled: false,
			settings: { token: "saved" },
			platformSnapshot: {
				label: "新平台",
				shortLabel: "新",
				color: "#123456",
				scopes: ["private"],
			},
		});
		expect(absent?.platformSnapshot.label).toBe(old.label);
		expect(elsewhere?.platformSnapshot.label).toBe(old.label);
		expect(changed?.platformSnapshot).not.toHaveProperty("platform");
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
