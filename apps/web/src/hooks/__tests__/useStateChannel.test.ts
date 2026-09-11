/**
 * 单元测试 — `handleStateEnvelope` 纯函数(WS `state` 频道 hydrate + config-changed)。
 *
 * 守护契约:
 *   - hydrate → 同步 invalidate ["globals"] / ["subscriptions"] / ["targets"]
 *   - config-changed scope=globals       → 仅 invalidate ["globals"]
 *   - config-changed scope=subscriptions → 仅 invalidate ["subscriptions"]
 *   - config-changed scope=targets       → 仅 invalidate ["targets"]
 *   - config-changed scope=secrets       → 一律不动(前端无对应缓存)
 *   - 非 state 频道帧 silent-drop
 */

import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { WsEnvelope } from "../../services/ws";
import { handleStateEnvelope } from "../useStateChannel";

function env(over: Partial<WsEnvelope> & { type: string }): WsEnvelope {
	return { ts: "2026-05-16T00:00:00.000Z", ...over };
}

interface SpyClient {
	qc: QueryClient;
	invalidate: ReturnType<typeof vi.fn>;
}

function spyClient(): SpyClient {
	const qc = new QueryClient();
	const invalidate = vi.fn(qc.invalidateQueries.bind(qc));
	qc.invalidateQueries = invalidate;
	return { qc, invalidate };
}

function keysOf(invalidate: ReturnType<typeof vi.fn>): unknown[][] {
	return invalidate.mock.calls.map((args) => (args[0] as { queryKey: unknown[] }).queryKey);
}

describe("handleStateEnvelope — state 频道分发", () => {
	let sc: SpyClient;
	beforeEach(() => {
		sc = spyClient();
	});

	it("非 state 频道:不 invalidate", () => {
		handleStateEnvelope(env({ type: "auth", event: "login-status-report" }), sc.qc);
		expect(sc.invalidate).not.toHaveBeenCalled();
	});

	/**
	 * 🔴 hydrate 是 WS 重连之后**唯一**的「赶上错过的变化」机制(不重放历史帧)。清单漏一
	 * 张表,那张表就一直停在断线那一刻:拓展页的装 / 卸 / 开关、连接表的增删,都得靠切页
	 * 或刷新才回来,而界面看上去一切正常。
	 */
	it("hydrate:每一张会被服务端改的表都在清单里 —— 漏一张就停在断线那一刻", () => {
		handleStateEnvelope(env({ type: "state", event: "hydrate" }), sc.qc);
		const keys = keysOf(sc.invalidate).map((k) => k[0]);
		expect(new Set(keys)).toEqual(
			new Set([
				"globals",
				"subscriptions",
				"targets",
				"connections",
				"extensions",
				"extension-status",
				"extension-bots",
			]),
		);
	});

	it("extension-changed:只失效那个拓展的 status 与 bots", () => {
		handleStateEnvelope(
			env({ type: "state", event: "extension-changed", data: { id: "bridge" } }),
			sc.qc,
		);
		expect(keysOf(sc.invalidate)).toEqual([
			["extension-status", "bridge"],
			["extension-bots", "bridge"],
		]);
	});

	it("extension-changed 没带 id:不动", () => {
		handleStateEnvelope(env({ type: "state", event: "extension-changed", data: {} }), sc.qc);
		expect(sc.invalidate).not.toHaveBeenCalled();
	});

	it("config-changed scope=globals:仅 invalidate [globals]", () => {
		handleStateEnvelope(
			env({ type: "state", event: "config-changed", data: { scope: "globals" } }),
			sc.qc,
		);
		expect(keysOf(sc.invalidate)).toEqual([["globals"]]);
	});

	it("config-changed scope=subscriptions:仅 invalidate [subscriptions]", () => {
		handleStateEnvelope(
			env({ type: "state", event: "config-changed", data: { scope: "subscriptions" } }),
			sc.qc,
		);
		expect(keysOf(sc.invalidate)).toEqual([["subscriptions"]]);
	});

	it("config-changed scope=targets:仅 invalidate [targets]", () => {
		handleStateEnvelope(
			env({ type: "state", event: "config-changed", data: { scope: "targets" } }),
			sc.qc,
		);
		expect(keysOf(sc.invalidate)).toEqual([["targets"]]);
	});

	/**
	 * 🔴 服务端**真的会发**这一档(`config/store.ts` 三处 `emit("config-changed", "connections")`)
	 * —— 建 / 改 / 删连接各一处。前端整条没人接,于是别处(另一个标签页、私聊指令、拓展
	 * 热装卸连带的清理)改了连接,这一页要等 staleTime 过去或切页才知道。
	 */
	it("config-changed scope=connections:仅 invalidate [connections]", () => {
		handleStateEnvelope(
			env({ type: "state", event: "config-changed", data: { scope: "connections" } }),
			sc.qc,
		);
		expect(keysOf(sc.invalidate)).toEqual([["connections"]]);
	});

	it("config-changed scope=secrets:不 invalidate(前端无对应 query)", () => {
		handleStateEnvelope(
			env({ type: "state", event: "config-changed", data: { scope: "secrets" } }),
			sc.qc,
		);
		expect(sc.invalidate).not.toHaveBeenCalled();
	});

	it("config-changed 但缺 scope:不 invalidate", () => {
		handleStateEnvelope(env({ type: "state", event: "config-changed", data: {} }), sc.qc);
		expect(sc.invalidate).not.toHaveBeenCalled();
	});

	it("不识别的 event:不 invalidate", () => {
		handleStateEnvelope(env({ type: "state", event: "subscribed" }), sc.qc);
		expect(sc.invalidate).not.toHaveBeenCalled();
	});
});
