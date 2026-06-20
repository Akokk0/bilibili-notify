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

	it("hydrate:同步 invalidate 三个 query", () => {
		handleStateEnvelope(env({ type: "state", event: "hydrate" }), sc.qc);
		const keys = keysOf(sc.invalidate);
		expect(keys).toEqual([["globals"], ["subscriptions"], ["targets"]]);
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
