/**
 * `BilibiliPush.onSend` → `HistoryStore.record` 的字段搬运。
 *
 * 推送层只知道 uid / feature / target / 消息与结果;历史行还要订阅 id、UP 的名字头像快照、
 * 推送类型。这一层把它们拼齐:无目标那次照记(target: null),附加项的 role 与逐条结果原样带过去。
 */

import type { PushSendInfo } from "@bilibili-notify/push";
import { describe, expect, it } from "vite-plus/test";
import { historyRecordFromSend } from "../push-history.js";

const SUB_ID = "11111111-1111-4111-8111-111111111111";
const target = {
	id: "22222222-2222-4222-8222-222222222222",
	name: "群",
	adapterId: "a",
	platform: "onebot",
	scope: "group",
	enabled: true,
	session: {},
} as unknown as PushSendInfo["target"] & object;

const lookups = {
	subscriptionOf: (uid: string) =>
		uid === "u1" ? { id: SUB_ID, profile: { name: "某UP", avatar: "http://a/x.jpg" } } : undefined,
};

describe("historyRecordFromSend", () => {
	it("有目标:pushId / kind / 订阅 id / 快照 / 消息逐条带 role 与结果", () => {
		const info: PushSendInfo = {
			pushId: "p1",
			uid: "u1",
			feature: "liveEnd",
			kind: "live-end",
			target,
			messages: [
				{ payload: { kind: "text", text: "卡" }, role: "main", result: { ok: true, latencyMs: 3 } },
				{
					payload: { kind: "text", text: "词云" },
					role: "extra",
					result: { ok: false, latencyMs: 9, err: "boom" },
				},
			],
		};
		expect(historyRecordFromSend(info, lookups)).toEqual({
			pushId: "p1",
			kind: "live-end",
			uid: "u1",
			subscriptionId: SUB_ID,
			target: target.id,
			messages: [
				{ payload: { kind: "text", text: "卡" }, role: "main", result: { ok: true, latencyMs: 3 } },
				{
					payload: { kind: "text", text: "词云" },
					role: "extra",
					result: { ok: false, latencyMs: 9, err: "boom" },
				},
			],
			unameSnapshot: "某UP",
			uavatarSnapshot: "http://a/x.jpg",
		});
	});

	it("无目标:target null、消息没有结果", () => {
		const info: PushSendInfo = {
			pushId: "p2",
			uid: "u1",
			feature: "dynamic",
			kind: "dynamic",
			target: null,
			messages: [{ payload: { kind: "text", text: "卡" }, role: "main" }],
		};
		expect(historyRecordFromSend(info, lookups)).toMatchObject({
			target: null,
			messages: [{ payload: { kind: "text", text: "卡" }, role: "main" }],
		});
		expect(historyRecordFromSend(info, lookups)?.messages[0]).not.toHaveProperty("result");
	});

	it("查不到订阅(推送中途被删)→ 没有订阅 id 就不记,返回 null", () => {
		const info: PushSendInfo = {
			pushId: "p3",
			uid: "ghost",
			feature: "dynamic",
			kind: "dynamic",
			target,
			messages: [],
		};
		expect(historyRecordFromSend(info, lookups)).toBeNull();
	});
});
