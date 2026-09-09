/**
 * 拓展页要的两个只读口。
 *
 * 桥状态那个口**从配置那一头看起**,不是从活着的会话:面板最需要看见的恰恰是「配了但
 * 没连上」那一条 —— 而那条在会话表里根本不存在。从会话看起的话,用户填错 token 时面板
 * 会干干净净地什么都不显示。
 */

import type { BridgeStatusResponse, ExtensionsResponse } from "@bilibili-notify/contract";
import type { Connection, GlobalConfig } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import type { BridgeServer, BridgeSession } from "../../bridge/server.js";
import type { ConfigStore } from "../../config/store.js";
import type { ExtensionEntry } from "../../extensions/loader.js";
import { createExtensionsRoute } from "../extensions.js";

const BRIDGE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BRIDGE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function bridgeConnection(id: string): Connection {
	return {
		id,
		name: `桥 ${id}`,
		enabled: true,
		kind: "extension",
		extensionId: "bridge",
		config: { token: "t0ken", bridgeKind: "koishi" },
	} as Connection;
}

function directConnection(): Connection {
	return {
		id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		name: "onebot",
		enabled: true,
		kind: "direct",
		platform: "onebot",
		connector: "ws",
		config: {},
	} as unknown as Connection;
}

function session(connectionId: string): BridgeSession {
	return {
		connectionId,
		kind: "koishi",
		name: "家里那台",
		version: "0.1.0",
		bots: [
			{
				botId: "b1",
				platform: "telegram",
				capabilities: {
					atAll: "unsupported",
					inbound: "supported",
					forward: "unknown",
					miniAppCard: "unknown",
					shareCardLinks: "unknown",
				},
			},
		],
		connectedAt: 1_700_000_000_000,
		origin: "http://127.0.0.1:8787",
	};
}

function boot(
	over: {
		connections?: Connection[];
		live?: BridgeSession[];
		enabled?: boolean;
		entries?: ExtensionEntry[];
		status?: Record<string, unknown>;
	} = {},
) {
	const store = {
		getGlobals: () =>
			({ extensions: { bridge: { enabled: over.enabled ?? false } } }) as unknown as GlobalConfig,
		getConnections: () => over.connections ?? [],
	} as unknown as ConfigStore;
	const server = {
		getSession: (id: string) => (over.live ?? []).find((s) => s.connectionId === id),
	} as unknown as BridgeServer;
	return createExtensionsRoute({
		store,
		bridge: () => (over.live ? server : undefined),
		extensions: () => over.entries ?? [],
		status: (id) => over.status?.[id],
	});
}

/** 一条「装着、跑着」的拓展。 */
function running(id: string): ExtensionEntry {
	return {
		id,
		origin: "data",
		state: "running",
		manifest: {
			id,
			name: `${id} 拓展`,
			description: "一句话说明",
			version: "1.0.0",
			apiVersion: 1,
			provides: ["push"],
		},
	};
}

describe("GET /api/ext", () => {
	it("列的是**真装着的**那些,带上主人的开关与它现在的状态", async () => {
		const body = (await (
			await boot({ enabled: true, entries: [running("bridge")] }).request("/")
		).json()) as ExtensionsResponse;
		const bridge = body.extensions.find((e) => e.id === "bridge");
		expect(bridge?.enabled).toBe(true);
		expect(bridge?.state).toBe("running");
		expect(bridge?.version).toBe("1.0.0");
		expect(bridge?.provides).toEqual(["push"]);
	});

	it("一个都没装 → 空表。**没有写死的清单了** —— 拓展是装进来的", async () => {
		const body = (await (await boot().request("/")).json()) as ExtensionsResponse;
		expect(body.extensions).toEqual([]);
	});

	it("开关开着、却因为连败被自动停用 —— 两件事都要看得见", async () => {
		const body = (await (
			await boot({
				enabled: true,
				entries: [{ id: "bridge", origin: "data", state: "blocked", detail: "连续加载失败 3 次" }],
			}).request("/")
		).json()) as ExtensionsResponse;
		const bridge = body.extensions[0];
		expect(bridge?.enabled).toBe(true);
		expect(bridge?.state).toBe("blocked");
		expect(bridge?.detail).toContain("连续");
	});

	it("清单读不出来的那条:名字退回目录名,原因带着 —— 消失的东西没法排查", async () => {
		const body = (await (
			await boot({
				entries: [{ id: "junk", origin: "data", state: "unreadable", detail: "不是合法 JSON" }],
			}).request("/")
		).json()) as ExtensionsResponse;
		expect(body.extensions[0]?.name).toBe("junk");
		expect(body.extensions[0]?.detail).toContain("JSON");
	});

	it("每张卡都有名字 —— 卡片上总得印点什么", async () => {
		const body = (await (
			await boot({
				entries: [running("bridge"), { id: "junk", origin: "data", state: "unreadable" }],
			}).request("/")
		).json()) as ExtensionsResponse;
		for (const ext of body.extensions) expect(ext.name.length).toBeGreaterThan(0);
	});
});

describe("GET /api/ext/:id/status", () => {
	it("拓展交上来什么就下发什么 —— 形状第一版不约束(决策 36)", async () => {
		const res = await boot({
			entries: [running("bridge")],
			status: { bridge: { sessions: [{ connectionId: "a", connected: false }] } },
		}).request("/bridge/status");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ sessions: [{ connectionId: "a", connected: false }] });
	});

	/**
	 * 「没这个拓展」与「它没交过数据」都是 404 而不是空对象 —— 面板要能把这两件事
	 * 与「交上来的就是一张空表」分开说。
	 */
	it("没跑 / 没交过 → 404,不是空对象", async () => {
		expect((await boot({ entries: [running("bridge")] }).request("/bridge/status")).status).toBe(
			404,
		);
		expect((await boot().request("/nobody/status")).status).toBe(404);
	});

	it("**现取** —— 拓展给的是个函数,两次问拿到的是两次的真相", async () => {
		let n = 0;
		const app = boot({ status: {} });
		expect(app).toBeDefined();
		const counted = createExtensionsRoute({
			store: {
				getGlobals: () => ({ extensions: {} }) as unknown as GlobalConfig,
				getConnections: () => [],
			} as unknown as ConfigStore,
			bridge: () => undefined,
			extensions: () => [],
			status: () => ({ n: ++n }),
		});
		expect(await (await counted.request("/x/status")).json()).toEqual({ n: 1 });
		expect(await (await counted.request("/x/status")).json()).toEqual({ n: 2 });
	});
});

describe("GET /api/ext/bridge", () => {
	it("配了但没连上的照样列出来 —— 那正是用户要看见的一条", async () => {
		const res = await boot({ connections: [bridgeConnection(BRIDGE_A)] }).request("/bridge");
		const body = (await res.json()) as BridgeStatusResponse;
		expect(body.sessions).toEqual([{ connectionId: BRIDGE_A, connected: false, bots: [] }]);
	});

	it("连上的带着桥自报的元信息与 bot 名单", async () => {
		const res = await boot({
			connections: [bridgeConnection(BRIDGE_A)],
			live: [session(BRIDGE_A)],
		}).request("/bridge");
		const body = (await res.json()) as BridgeStatusResponse;
		expect(body.sessions[0]).toMatchObject({
			connectionId: BRIDGE_A,
			connected: true,
			kind: "koishi",
			name: "家里那台",
			version: "0.1.0",
		});
		expect(body.sessions[0]?.bots[0]?.capabilities.inbound).toBe("supported");
	});

	it("两条接入各算各的:一条连着一条没有", async () => {
		const res = await boot({
			connections: [bridgeConnection(BRIDGE_A), bridgeConnection(BRIDGE_B)],
			live: [session(BRIDGE_B)],
		}).request("/bridge");
		const body = (await res.json()) as BridgeStatusResponse;
		expect(body.sessions.map((s) => [s.connectionId, s.connected])).toEqual([
			[BRIDGE_A, false],
			[BRIDGE_B, true],
		]);
	});

	it("直连不在这张表里 —— 它们不是桥", async () => {
		const res = await boot({
			connections: [directConnection(), bridgeConnection(BRIDGE_A)],
		}).request("/bridge");
		const body = (await res.json()) as BridgeStatusResponse;
		expect(body.sessions.map((s) => s.connectionId)).toEqual([BRIDGE_A]);
	});

	it("端点还没装配起来 → 全都算没连着,不是报错", async () => {
		const res = await boot({ connections: [bridgeConnection(BRIDGE_A)] }).request("/bridge");
		expect(res.status).toBe(200);
	});
});
