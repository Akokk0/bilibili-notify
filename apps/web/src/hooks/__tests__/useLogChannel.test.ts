/**
 * 单元测试 — `parseLogEnvelope` / `handleLogStreamEnvelope` 纯函数
 * (WS `log` 频道 → ["logs",{day:"live"}] 缓存 prepend)。
 *
 * 守护契约(镜像 useAlertChannel 的 silent-drop 风格):
 *   - 非 log 频道帧 → null / 不动缓存
 *   - 级别帧 data.msg 非 string → silent-drop
 *   - engine-error → 合成 level=error / name=source 一行
 *   - 合法帧 prepend(新→旧),封顶 LOG_CACHE_CAP
 */

import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { type LogsResponse, logsQueryKey } from "../../services/dashboard";
import type { WsEnvelope } from "../../services/ws";
import { handleLogStreamEnvelope, LOG_CACHE_CAP, parseLogEnvelope } from "../useLogChannel";

function env(over: Partial<WsEnvelope> & { type: string }): WsEnvelope {
	return { ts: "2026-05-17T00:00:00.000Z", ...over };
}

describe("parseLogEnvelope", () => {
	it("非 log 频道 → null", () => {
		expect(parseLogEnvelope(env({ type: "auth", event: "info", data: { msg: "x" } }))).toBeNull();
	});

	it("级别帧:取 msg/name/args", () => {
		const line = parseLogEnvelope(
			env({ type: "log", event: "warn", data: { msg: "disk", name: "bn:live", args: [1] } }),
		);
		expect(line).toEqual({
			ts: "2026-05-17T00:00:00.000Z",
			level: "warn",
			msg: "disk",
			name: "bn:live",
			args: [1],
		});
	});

	it("级别帧 msg 非 string → null(silent-drop)", () => {
		expect(parseLogEnvelope(env({ type: "log", event: "info", data: { msg: 42 } }))).toBeNull();
		expect(parseLogEnvelope(env({ type: "log", event: "info", data: undefined }))).toBeNull();
	});

	it("engine-error → 合成 level=error / name=source", () => {
		const line = parseLogEnvelope(
			env({ type: "log", event: "engine-error", data: ["dynamic-engine", "boom"] }),
		);
		expect(line).toEqual({
			ts: "2026-05-17T00:00:00.000Z",
			level: "error",
			name: "dynamic-engine",
			msg: "boom",
		});
	});

	it("engine-error data 形状不符 → null", () => {
		expect(parseLogEnvelope(env({ type: "log", event: "engine-error", data: "x" }))).toBeNull();
		expect(
			parseLogEnvelope(env({ type: "log", event: "engine-error", data: ["only"] })),
		).toBeNull();
		expect(
			parseLogEnvelope(env({ type: "log", event: "engine-error", data: [1, "m"] })),
		).toBeNull();
	});

	it("未知 event → null", () => {
		expect(parseLogEnvelope(env({ type: "log", event: "trace", data: { msg: "x" } }))).toBeNull();
	});
});

describe("handleLogStreamEnvelope", () => {
	it("合法帧 prepend(新→旧),非法帧不动缓存", () => {
		const qc = new QueryClient();
		handleLogStreamEnvelope(env({ type: "log", event: "info", data: { msg: "a" } }), qc);
		handleLogStreamEnvelope(env({ type: "log", event: "info", data: { msg: "b" } }), qc);
		handleLogStreamEnvelope(env({ type: "log", event: "info", data: { msg: 99 } }), qc); // drop
		const cached = qc.getQueryData<LogsResponse>(logsQueryKey());
		expect(cached?.entries.map((e) => e.msg)).toEqual(["b", "a"]);
	});

	it("超过 LOG_CACHE_CAP 截尾", () => {
		const qc = new QueryClient();
		for (let i = 0; i < LOG_CACHE_CAP + 50; i++) {
			handleLogStreamEnvelope(env({ type: "log", event: "info", data: { msg: `m${i}` } }), qc);
		}
		const cached = qc.getQueryData<LogsResponse>(logsQueryKey());
		expect(cached?.entries).toHaveLength(LOG_CACHE_CAP);
		expect(cached?.entries[0]?.msg).toBe(`m${LOG_CACHE_CAP + 49}`); // 最新在顶
	});
});
