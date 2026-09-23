/**
 * `BilibiliPush.onSend` → `HistoryStore.record` 的字段搬运。
 *
 * 推送层只知道订阅 id / feature / target / 消息与结果;历史行还要 B 站 uid、UP 的名字头像快照、
 * 推送类型。这一层把它们拼齐:无目标那次照记(target: null),附加项的 role 与逐条结果原样带过去。
 */

import { makeEmptySubscription } from "@bilibili-notify/internal";
import type { PushSendInfo } from "@bilibili-notify/push";
import { describe, expect, it } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { historyRecordFromSend } from "../push-history.js";

const SUB_ID = "11111111-1111-4111-8111-111111111111";
const target = {
	id: "22222222-2222-4222-8222-222222222222",
	name: "群",
	connectionId: "a",
	platform: "onebot",
	scope: "group",
	enabled: true,
	session: {},
} as unknown as PushSendInfo["target"] & object;

const EXT_ID = "33333333-3333-4333-8333-333333333333";
const lookups = {
	subscriptionOf: (subscriptionId: string) =>
		subscriptionId === SUB_ID
			? {
					subscription: makeEmptySubscription({ id: SUB_ID, uid: "u1" }),
					profile: { name: "某UP", avatar: "http://a/x.jpg" },
				}
			: subscriptionId === EXT_ID
				? { subscription: makeExtensionSubscription({ id: EXT_ID, externalId: "u1" }) }
				: undefined,
};

describe("historyRecordFromSend", () => {
	it("有目标:pushId / kind / 订阅 id / 快照 / 消息逐条带 role 与结果", () => {
		const info: PushSendInfo = {
			pushId: "p1",
			subscriptionId: SUB_ID,
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
			subscriptionId: SUB_ID,
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
			subscriptionId: "44444444-4444-4444-8444-444444444444",
			feature: "dynamic",
			kind: "dynamic",
			target,
			messages: [],
		};
		expect(historyRecordFromSend(info, lookups)).toBeNull();
	});

	it("行的订阅 id 就是推送层带来的那个,uid 从订阅上取(推送层不再带 uid)", () => {
		const info: PushSendInfo = {
			pushId: "p4",
			subscriptionId: SUB_ID,
			feature: "dynamic",
			kind: "dynamic",
			target,
			messages: [],
		};
		expect(historyRecordFromSend(info, lookups)).toMatchObject({
			subscriptionId: SUB_ID,
			uid: "u1",
		});
	});

	// 拓展订阅没有 uid,而 `HistoryEntry.uid` 今天还是必填。它的历史行长什么样归 ④「接进推送链」
	// 那一片定(ADR-0019 决策 50);这一片里只有 B 站适配器调 broadcastToFeature,走不到这儿。
	it("拓展订阅 → 不记,返回 null", () => {
		const info: PushSendInfo = {
			pushId: "p5",
			subscriptionId: EXT_ID,
			feature: "dynamic",
			kind: "dynamic",
			target,
			messages: [],
		};
		expect(historyRecordFromSend(info, lookups)).toBeNull();
	});
});
