/**
 * 单元测试 — `handleLogEnvelope` 纯函数(WS `log` 频道 engine-error 分发)。
 *
 * 守护契约:
 *   - 非 log 频道帧 silent-drop
 *   - engine-error 之外的 event 不动 store
 *   - data 形状不符合 [source, message] 元组的 silent-drop(数组短 / 元素非 string)
 *   - 合法帧 push 到 useAlertStore
 */

import { beforeEach, describe, expect, it } from "vite-plus/test";
import type { WsEnvelope } from "../../services/ws";
import { useAlertStore } from "../../store/alerts";
import { handleLogEnvelope } from "../useAlertChannel";

function resetStore(): void {
	useAlertStore.getState().clear();
}

function env(over: Partial<WsEnvelope> & { type: string }): WsEnvelope {
	return { ts: "2026-05-16T00:00:00.000Z", ...over };
}

describe("handleLogEnvelope — log 频道 engine-error", () => {
	beforeEach(resetStore);

	it("非 log 频道帧:不 push", () => {
		handleLogEnvelope(env({ type: "auth", event: "engine-error", data: ["x", "y"] }));
		expect(useAlertStore.getState().items).toHaveLength(0);
	});

	it("log 频道但 event 不是 engine-error:不 push", () => {
		handleLogEnvelope(env({ type: "log", event: "log-line", data: ["x", "y"] }));
		expect(useAlertStore.getState().items).toHaveLength(0);
	});

	it("合法 [source, message]:push 到 store", () => {
		handleLogEnvelope(
			env({ type: "log", event: "engine-error", data: ["dynamic-engine", "boom"] }),
		);
		const items = useAlertStore.getState().items;
		expect(items).toHaveLength(1);
		expect(items[0].source).toBe("dynamic-engine");
		expect(items[0].message).toBe("boom");
	});

	it("data 不是数组:silent-drop", () => {
		handleLogEnvelope(env({ type: "log", event: "engine-error", data: "oops" }));
		expect(useAlertStore.getState().items).toHaveLength(0);
	});

	it("data 数组长度 < 2:silent-drop", () => {
		handleLogEnvelope(env({ type: "log", event: "engine-error", data: ["only-source"] }));
		expect(useAlertStore.getState().items).toHaveLength(0);
	});

	it("source / message 任一非 string:silent-drop", () => {
		handleLogEnvelope(env({ type: "log", event: "engine-error", data: ["src", 42] }));
		handleLogEnvelope(env({ type: "log", event: "engine-error", data: [null, "msg"] }));
		expect(useAlertStore.getState().items).toHaveLength(0);
	});

	it("连续 push:按时间倒序累计,id 不重复", () => {
		handleLogEnvelope(env({ type: "log", event: "engine-error", data: ["a", "1"] }));
		handleLogEnvelope(env({ type: "log", event: "engine-error", data: ["b", "2"] }));
		const items = useAlertStore.getState().items;
		expect(items).toHaveLength(2);
		// 新条目顶部插入,id 各不相同
		expect(items[0].source).toBe("b");
		expect(items[1].source).toBe("a");
		expect(items[0].id).not.toBe(items[1].id);
	});
});
