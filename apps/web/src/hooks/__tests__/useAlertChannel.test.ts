/**
 * 单元测试 — `handleLogEnvelope` 纯函数(WS `log` 频道 pipeline-error 分发)。
 *
 * 守护契约:
 *   - 非 log 频道帧 silent-drop
 *   - pipeline-error 之外的 event 不动 store
 *   - data 形状不符合 { source, message } 的 silent-drop(不是对象 / 缺格 / 格非 string)
 *   - 合法帧 push 到 useAlertStore
 */

import { beforeEach, describe, expect, it } from "vite-plus/test";
import type { WsEnvelope } from "../../services/ws";
import { useAlertStore } from "../../store/alerts";
import { handleLogEnvelope } from "../useAlertChannel";
import { eventFrameMaker } from "./ws-frames";

function resetStore(): void {
	useAlertStore.getState().clear();
}

const TS = "2026-05-16T00:00:00.000Z";

/** 服务端发来的一帧合法事件帧:形状按 contract 的事件表写全,缺 `ts` 补上。 */
const env = eventFrameMaker(TS);

/** 故意违反类型的坏帧(`data` 缺格 / 类型不对、事件名不存在、频道与事件名对不上),测 hook 的防御。 */
const malformed = (frame: object) => ({ ts: TS, ...frame }) as WsEnvelope;

describe("handleLogEnvelope — log 频道 pipeline-error", () => {
	beforeEach(resetStore);

	it("非 log 频道帧:不 push", () => {
		handleLogEnvelope(
			malformed({ type: "auth", event: "pipeline-error", data: { source: "x", message: "y" } }),
		);
		expect(useAlertStore.getState().items).toHaveLength(0);
	});

	it("log 频道但 event 不是 pipeline-error:不 push", () => {
		handleLogEnvelope(
			malformed({ type: "log", event: "log-line", data: { source: "x", message: "y" } }),
		);
		expect(useAlertStore.getState().items).toHaveLength(0);
	});

	it("合法 { source, message }:push 到 store", () => {
		handleLogEnvelope(
			env({
				type: "log",
				event: "pipeline-error",
				data: { source: "post-delivery", message: "boom" },
			}),
		);
		const items = useAlertStore.getState().items;
		expect(items).toHaveLength(1);
		expect(items[0].source).toBe("post-delivery");
		expect(items[0].message).toBe("boom");
	});

	it("data 不是对象:silent-drop", () => {
		handleLogEnvelope(malformed({ type: "log", event: "pipeline-error", data: "oops" }));
		expect(useAlertStore.getState().items).toHaveLength(0);
	});

	it("data 缺 message:silent-drop", () => {
		handleLogEnvelope(
			malformed({ type: "log", event: "pipeline-error", data: { source: "only-source" } }),
		);
		expect(useAlertStore.getState().items).toHaveLength(0);
	});

	it("source / message 任一非 string:silent-drop", () => {
		handleLogEnvelope(
			malformed({ type: "log", event: "pipeline-error", data: { source: "src", message: 42 } }),
		);
		handleLogEnvelope(
			malformed({ type: "log", event: "pipeline-error", data: { source: null, message: "msg" } }),
		);
		expect(useAlertStore.getState().items).toHaveLength(0);
	});

	it("连续 push:按时间倒序累计,id 不重复", () => {
		handleLogEnvelope(
			env({ type: "log", event: "pipeline-error", data: { source: "a", message: "1" } }),
		);
		handleLogEnvelope(
			env({ type: "log", event: "pipeline-error", data: { source: "b", message: "2" } }),
		);
		const items = useAlertStore.getState().items;
		expect(items).toHaveLength(2);
		// 新条目顶部插入,id 各不相同
		expect(items[0].source).toBe("b");
		expect(items[1].source).toBe("a");
		expect(items[0].id).not.toBe(items[1].id);
	});
});
