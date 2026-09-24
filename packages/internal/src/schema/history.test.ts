/**
 * **历史行的身份**(ADR-0019 决策 73)。
 *
 * 一行历史记的是「BN 发出去了什么、替谁发的」。B 站行带 `uid`;拓展行带两格选填的
 * `extensionId` / `externalId`、**不带 `uid`** —— 外部 id 恰好是一串等于某个 B 站 uid 的数字时,
 * 塞进 `uid` 那一格就会在订阅删掉之后被认成那位 B 站 UP。
 *
 * 钉的是:拓展行读得进来且两格原样保留;B 站行与老格式行照旧。
 */

import { describe, expect, it } from "vite-plus/test";
import { HistoryEntrySchema } from "./history.js";

const BASE = {
	id: "11111111-1111-4111-8111-111111111111",
	pushId: "22222222-2222-4222-8222-222222222222",
	ts: "2026-09-24T00:00:00.000Z",
	kind: "dynamic",
	subscriptionId: "33333333-3333-4333-8333-333333333333",
	targetId: "44444444-4444-4444-8444-444444444444",
	status: "delivered",
	messages: [{ payload: { kind: "text", text: "卡片" }, role: "main" }],
} as const;

describe("HistoryEntrySchema — 行的身份", () => {
	it("拓展行:带拓展 id 与外部 id、没有 uid → 读得进来,两格原样保留", () => {
		const parsed = HistoryEntrySchema.parse({
			...BASE,
			extensionId: "douyin",
			externalId: "123",
			unameSnapshot: "某抖音号",
		});
		expect(parsed.extensionId).toBe("douyin");
		expect(parsed.externalId).toBe("123");
		expect(parsed.uid).toBeUndefined();
		expect(parsed.unameSnapshot).toBe("某抖音号");
	});

	it("B 站行照旧:有 uid、没有拓展那两格", () => {
		const parsed = HistoryEntrySchema.parse({ ...BASE, uid: "u1" });
		expect(parsed.uid).toBe("u1");
		expect(parsed).not.toHaveProperty("extensionId");
		expect(parsed).not.toHaveProperty("externalId");
	});

	it("老格式行(source / result / payload)照样读得进来,映射成 B 站行", () => {
		const parsed = HistoryEntrySchema.parse({
			id: BASE.id,
			ts: BASE.ts,
			source: "live-summary",
			uid: "u7",
			subscriptionId: BASE.subscriptionId,
			targetIds: [BASE.targetId],
			payload: { kind: "text", text: "词云" },
			result: { ok: true, per: [{ ok: true, latencyMs: 4 }] },
			unameSnapshot: "老UP",
		});
		expect(parsed).toMatchObject({
			pushId: BASE.id,
			kind: "live-end",
			uid: "u7",
			targetId: BASE.targetId,
			status: "delivered",
			unameSnapshot: "老UP",
		});
		expect(parsed.extensionId).toBeUndefined();
		expect(parsed.externalId).toBeUndefined();
	});
});
