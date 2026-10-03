/**
 * **历史行的身份**(ADR-0019 决策 73)。
 *
 * 一行历史记的是「BN 发出去了什么、替谁发的」。B 站行带 `uid`;拓展行带两格选填的
 * `extensionId` / `externalId`、**不带 `uid`** —— 外部 id 恰好是一串等于某个 B 站 uid 的数字时,
 * 塞进 `uid` 那一格就会在订阅删掉之后被认成那位 B 站 UP。
 *
 * 钉的是:拓展行读得进来且两格原样保留;B 站行照旧;老格式行读不进来(那是迁移器的事);
 * 推送种类那一格叫 `feature`、值就是特性键(⑬f),八把键都认,别的值与老的 `kind` 形状一律读不进来。
 */

import { describe, expect, it } from "vite-plus/test";
import { FEATURE_KEYS } from "../../constants.js";
import { HistoryEntrySchema } from "../history.js";

const BASE = {
	id: "11111111-1111-4111-8111-111111111111",
	pushId: "22222222-2222-4222-8222-222222222222",
	ts: "2026-09-24T00:00:00.000Z",
	feature: "post",
	subscriptionId: "33333333-3333-4333-8333-333333333333",
	targetId: "44444444-4444-4444-8444-444444444444",
	status: "delivered",
	messages: [{ payload: { kind: "text", text: "卡片" }, role: "main" }],
} as const;

describe("HistoryEntrySchema — 推送种类那一格是特性键", () => {
	it.each(FEATURE_KEYS)("feature %s 读得进来", (feature) => {
		expect(HistoryEntrySchema.parse({ ...BASE, feature }).feature).toBe(feature);
	});

	it("不是特性键的值读不进来(含 0.x 的推送种类名)", () => {
		for (const feature of ["dynamic", "live", "live-ongoing", "live-end", "guard", "sc", "nope"]) {
			expect(HistoryEntrySchema.safeParse({ ...BASE, feature }).success, feature).toBe(false);
		}
	});

	it("0.x 最新形状的行(带 `kind`、没有 `feature`)读不进来 —— 那是迁移器的事", () => {
		const { feature: _gone, ...rest } = BASE;
		expect(HistoryEntrySchema.safeParse({ ...rest, kind: "dynamic" }).success).toBe(false);
	});
});

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

	// 0.x 的老行(一行 = 一个目标 × 一条消息,带 `source` / `result` / `payload`)由迁移器在搬家时改写
	// (`apps/server/src/migration/history.ts`,等价性在 `migration/__tests__/zero-generation-history.test.ts` 钉着)。
	// 活的 schema 不再认老形状:没人改写就拿到这样的行,是该报错的 —— 静默映射等于把迁移器该做的事又在读这头做一遍。
	it("老格式行(source / result / payload)读不进来 —— 那是迁移器的事,活 schema 只认现在的形状", () => {
		const legacy = {
			id: BASE.id,
			ts: BASE.ts,
			source: "live-summary",
			uid: "u7",
			subscriptionId: BASE.subscriptionId,
			targetIds: [BASE.targetId],
			payload: { kind: "text", text: "词云" },
			result: { ok: true, per: [{ ok: true, latencyMs: 4 }] },
			unameSnapshot: "老UP",
		};
		expect(HistoryEntrySchema.safeParse(legacy).success).toBe(false);
	});
});
