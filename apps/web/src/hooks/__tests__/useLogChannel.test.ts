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
import { describe, expect, it } from "vite-plus/test";
import { type LogsResponse, logsQueryKey } from "../../services/dashboard";
import type { WsEnvelope } from "../../services/ws";
import { handleLogStreamEnvelope, LOG_CACHE_CAP, parseLogEnvelope } from "../useLogChannel";
import { eventFrameMaker } from "./ws-frames";

const TS = "2026-05-17T00:00:00.000Z";

/** 服务端发来的一帧合法事件帧:形状按 contract 的事件表写全,缺 `ts` 补上。 */
const env = eventFrameMaker(TS);

/** 故意违反类型的坏帧(`data` 缺格 / 类型不对、事件名不存在、频道与事件名对不上),测 hook 的防御。 */
const malformed = (frame: object) => ({ ts: TS, ...frame }) as WsEnvelope;

describe("parseLogEnvelope", () => {
	it("非 log 频道 → null", () => {
		expect(
			parseLogEnvelope(malformed({ type: "auth", event: "info", data: { msg: "x" } })),
		).toBeNull();
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
		expect(
			parseLogEnvelope(malformed({ type: "log", event: "info", data: { msg: 42 } })),
		).toBeNull();
		expect(parseLogEnvelope(malformed({ type: "log", event: "info", data: undefined }))).toBeNull();
	});

	it("engine-error → 合成 level=error / name=source", () => {
		const line = parseLogEnvelope(
			env({
				type: "log",
				event: "engine-error",
				data: { source: "dynamic-engine", message: "boom" },
			}),
		);
		expect(line).toEqual({
			ts: "2026-05-17T00:00:00.000Z",
			level: "error",
			name: "dynamic-engine",
			msg: "boom",
		});
	});

	it("engine-error data 形状不符 → null", () => {
		expect(
			parseLogEnvelope(malformed({ type: "log", event: "engine-error", data: "x" })),
		).toBeNull();
		expect(
			parseLogEnvelope(malformed({ type: "log", event: "engine-error", data: { source: "only" } })),
		).toBeNull();
		expect(
			parseLogEnvelope(
				malformed({ type: "log", event: "engine-error", data: { source: 1, message: "m" } }),
			),
		).toBeNull();
	});

	it("未知 event → null", () => {
		expect(
			parseLogEnvelope(malformed({ type: "log", event: "trace", data: { msg: "x" } })),
		).toBeNull();
	});
});

describe("handleLogStreamEnvelope", () => {
	it("合法帧 prepend(新→旧),非法帧不动缓存", () => {
		const qc = new QueryClient();
		handleLogStreamEnvelope(env({ type: "log", event: "info", data: { msg: "a", args: [] } }), qc);
		handleLogStreamEnvelope(env({ type: "log", event: "info", data: { msg: "b", args: [] } }), qc);
		handleLogStreamEnvelope(malformed({ type: "log", event: "info", data: { msg: 99 } }), qc); // drop
		const cached = qc.getQueryData<LogsResponse>(logsQueryKey());
		expect(cached?.entries.map((e) => e.msg)).toEqual(["b", "a"]);
	});

	it("超过 LOG_CACHE_CAP 截尾", () => {
		const qc = new QueryClient();
		for (let i = 0; i < LOG_CACHE_CAP + 50; i++) {
			handleLogStreamEnvelope(
				env({ type: "log", event: "info", data: { msg: `m${i}`, args: [] } }),
				qc,
			);
		}
		const cached = qc.getQueryData<LogsResponse>(logsQueryKey());
		expect(cached?.entries).toHaveLength(LOG_CACHE_CAP);
		expect(cached?.entries[0]?.msg).toBe(`m${LOG_CACHE_CAP + 49}`); // 最新在顶
	});
});
