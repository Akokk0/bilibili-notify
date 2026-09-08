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
import { createExtensionsRoute } from "../extensions.js";

const BRIDGE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BRIDGE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function bridgeConnection(id: string): Connection {
	return {
		id,
		name: `桥 ${id}`,
		enabled: true,
		kind: "bridge",
		connector: "bridge",
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
	over: { connections?: Connection[]; live?: BridgeSession[]; enabled?: boolean } = {},
) {
	const store = {
		getGlobals: () =>
			({ extensions: { bridge: { enabled: over.enabled ?? false } } }) as unknown as GlobalConfig,
		getConnections: () => over.connections ?? [],
	} as unknown as ConfigStore;
	const server = {
		getSession: (id: string) => (over.live ?? []).find((s) => s.connectionId === id),
	} as unknown as BridgeServer;
	return createExtensionsRoute({ store, bridge: () => (over.live ? server : undefined) });
}

describe("GET /api/extensions", () => {
	it("列出模块,带上开没开", async () => {
		const res = await boot({ enabled: true }).request("/");
		const body = (await res.json()) as ExtensionsResponse;
		expect(body.extensions.map((e) => e.id)).toContain("bridge");
		expect(body.extensions.find((e) => e.id === "bridge")?.enabled).toBe(true);
	});

	it("没开就是没开 —— 缺失也是没开", async () => {
		const res = await boot().request("/");
		const body = (await res.json()) as ExtensionsResponse;
		expect(body.extensions.find((e) => e.id === "bridge")?.enabled).toBe(false);
	});

	it("每张卡都有名字与一句话说明 —— 卡片上印的就是它们", async () => {
		const body = (await (await boot().request("/")).json()) as ExtensionsResponse;
		for (const ext of body.extensions) {
			expect(ext.name.length).toBeGreaterThan(0);
			expect(ext.description.length).toBeGreaterThan(0);
		}
	});
});

describe("GET /api/extensions/bridge", () => {
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
