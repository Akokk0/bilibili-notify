/**
 * 历史行 → wire view(`toHistoryView`)。REST 列表与 WS 两个事件共用这一处投影。
 *
 * 钉的是拓展行的身份(ADR-0019 决策 73)一路送到面板:这里一格格抄字段,漏抄 `extensionId` /
 * `externalId` 的话面板收到的就是一行「谁也不是」的 B 站行 —— 类型、写入测试都照样绿。
 */

import type { HistoryEntry } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { toHistoryView } from "../view.js";

const ROW: HistoryEntry = {
	id: "11111111-1111-4111-8111-111111111111",
	pushId: "22222222-2222-4222-8222-222222222222",
	ts: "2026-09-24T00:00:00.000Z",
	kind: "dynamic",
	subscriptionId: "33333333-3333-4333-8333-333333333333",
	targetId: null,
	status: "no-targets",
	messages: [{ payload: { kind: "text", text: "作品" }, role: "main" }],
};

describe("toHistoryView — 行的身份", () => {
	it("拓展行:拓展 id 与外部 id 带到面板,没有 uid", () => {
		const view = toHistoryView({
			...ROW,
			extensionId: "douyin",
			externalId: "123",
			unameSnapshot: "某抖音号",
		});
		expect(view).toMatchObject({
			extensionId: "douyin",
			externalId: "123",
			unameSnapshot: "某抖音号",
		});
		expect(view.uid).toBeUndefined();
	});

	it("B 站行:uid 照旧,拓展那两格没有", () => {
		const view = toHistoryView({ ...ROW, uid: "u1" });
		expect(view.uid).toBe("u1");
		expect(view.extensionId).toBeUndefined();
		expect(view.externalId).toBeUndefined();
	});
});
