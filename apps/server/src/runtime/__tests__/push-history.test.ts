/**
 * `BilibiliPush.onSend` → `HistoryStore.record` 的字段搬运。
 *
 * 推送层只知道订阅 id / feature / target / 消息与结果;历史行还要「替谁发的」(B 站 uid,或拓展 id +
 * 外部 id)、UP 的名字头像快照、推送类型。这一层把它们拼齐:无目标那次照记(target: null),附加项的
 * role 与逐条结果原样带过去。
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
				? {
						// 外部 id 恰好也是 "u1" —— 拓展行照样不许把它写进 uid 那一格。
						subscription: makeExtensionSubscription({
							id: EXT_ID,
							extensionId: "douyin",
							externalId: "u1",
						}),
						// 拓展订阅的头像是面板里的相对地址,订阅一删文件就没了(ADR-0019 决策 74)。
						profile: { name: "某抖音号", avatar: `/api/subs/${EXT_ID}/avatar?v=abc` },
					}
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

	// 拓展行的身份是两格选填的 extensionId / externalId,不带 uid(ADR-0019 决策 73);只存名字快照、
	// 不存头像快照(决策 74)。
	it("拓展订阅 → 照记:带拓展 id 与外部 id、没有 uid、有名字快照、没有头像快照", () => {
		const info: PushSendInfo = {
			pushId: "p5",
			subscriptionId: EXT_ID,
			feature: "dynamic",
			kind: "dynamic",
			target,
			messages: [
				{
					payload: { kind: "text", text: "作品" },
					role: "main",
					result: { ok: true, latencyMs: 1 },
				},
			],
		};
		const input = historyRecordFromSend(info, lookups);
		expect(input).toMatchObject({
			pushId: "p5",
			kind: "dynamic",
			subscriptionId: EXT_ID,
			extensionId: "douyin",
			externalId: "u1",
			target: target.id,
			unameSnapshot: "某抖音号",
		});
		expect(input).not.toHaveProperty("uid");
		expect(input).not.toHaveProperty("uavatarSnapshot");
	});

	// 拓展还没报过资料时(订阅刚加、拓展没报资料更新)订阅上没有资料名字:行的名字快照退到主人填的
	// 别名(决策 77 的名字链,事件里的作者名这一层拿不到)。`notes` 是自由文字,不当名字用。
	describe("拓展行的名字快照:资料里没名字 → 主人填的别名", () => {
		const EXT_NO_PROFILE = "55555555-5555-4555-8555-555555555555";
		const info: PushSendInfo = {
			pushId: "p7",
			subscriptionId: EXT_NO_PROFILE,
			feature: "dynamic",
			kind: "dynamic",
			target,
			messages: [],
		};
		const lookupsWith = (
			over: { name?: string; notes?: string },
			profile?: { name?: string; avatar?: string },
		) => ({
			subscriptionOf: (id: string) =>
				id === EXT_NO_PROFILE
					? {
							subscription: makeExtensionSubscription({ id: EXT_NO_PROFILE, ...over }),
							profile,
						}
					: undefined,
		});

		it("没有资料 → 别名", () => {
			expect(historyRecordFromSend(info, lookupsWith({ name: "主人起的名" }))).toMatchObject({
				unameSnapshot: "主人起的名",
			});
		});

		it("资料里名字是空的 → 别名", () => {
			expect(
				historyRecordFromSend(info, lookupsWith({ name: "主人起的名" }, { name: "" })),
			).toMatchObject({ unameSnapshot: "主人起的名" });
		});

		it("资料里有名字 → 资料的名字压过别名", () => {
			expect(
				historyRecordFromSend(info, lookupsWith({ name: "主人起的名" }, { name: "报来的名" })),
			).toMatchObject({ unameSnapshot: "报来的名" });
		});

		it("别名也是空白 → 没有名字快照;备注不当名字用", () => {
			const input = historyRecordFromSend(
				info,
				lookupsWith({ name: "  ", notes: "推给一群,周末别推" }),
			);
			expect(input?.unameSnapshot).toBeUndefined();
		});

		it("B 站行不受影响:资料里没名字就没有快照,不拿别名顶", () => {
			const BILI = "66666666-6666-4666-8666-666666666666";
			const input = historyRecordFromSend(
				{ ...info, subscriptionId: BILI },
				{
					subscriptionOf: () => ({
						subscription: { ...makeEmptySubscription({ id: BILI, uid: "9" }), name: "别名" },
					}),
				},
			);
			expect(input?.unameSnapshot).toBeUndefined();
		});
	});

	it("B 站订阅的行不带拓展那两格", () => {
		const info: PushSendInfo = {
			pushId: "p6",
			subscriptionId: SUB_ID,
			feature: "dynamic",
			kind: "dynamic",
			target,
			messages: [],
		};
		const input = historyRecordFromSend(info, lookups);
		expect(input).not.toHaveProperty("extensionId");
		expect(input).not.toHaveProperty("externalId");
	});
});
