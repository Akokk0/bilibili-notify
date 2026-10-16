/**
 * 特别关注名单的条目形状(3b-16):`{ id, note?, features }`。
 *
 * 验红(施工时逐条真改坏跑过):`features` 的枚举换成 `FeatureKeySchema` → 「只许两把」红;
 * 去掉 `.min(1)` → 「至少一把」红;`id` 加回 `/^\d+$/` → 「id 中立」红。
 */

import { describe, expect, it } from "vite-plus/test";
import { EXTERNAL_ID_MAX, SpecialViewerSchema, SubscriptionSchema } from "../subscriptions";

describe("SpecialViewerSchema", () => {
	it("收 { id, features },note 可选", () => {
		expect(SpecialViewerSchema.parse({ id: "123", features: ["viewerChat"] })).toEqual({
			id: "123",
			features: ["viewerChat"],
		});
		expect(
			SpecialViewerSchema.parse({
				id: "123",
				note: "老朋友",
				features: ["viewerChat", "viewerEnter"],
			}),
		).toEqual({ id: "123", note: "老朋友", features: ["viewerChat", "viewerEnter"] });
	});

	it("features 只许这两把,别的特性键(哪怕是活的)不收", () => {
		expect(SpecialViewerSchema.safeParse({ id: "1", features: ["post"] }).success).toBe(false);
		expect(SpecialViewerSchema.safeParse({ id: "1", features: ["superchat"] }).success).toBe(false);
		expect(SpecialViewerSchema.safeParse({ id: "1", features: ["danmaku"] }).success).toBe(false);
	});

	it("features 至少一把", () => {
		expect(SpecialViewerSchema.safeParse({ id: "1", features: [] }).success).toBe(false);
		expect(SpecialViewerSchema.safeParse({ id: "1" }).success).toBe(false);
	});

	it("id 中立:不认数字规矩,只限非空、限长", () => {
		expect(
			SpecialViewerSchema.safeParse({ id: "MS4wLjAB-sec", features: ["viewerEnter"] }).success,
		).toBe(true);
		expect(SpecialViewerSchema.safeParse({ id: "", features: ["viewerEnter"] }).success).toBe(
			false,
		);
		expect(
			SpecialViewerSchema.safeParse({ id: "1".repeat(EXTERNAL_ID_MAX), features: ["viewerEnter"] })
				.success,
		).toBe(true);
		expect(
			SpecialViewerSchema.safeParse({
				id: "1".repeat(EXTERNAL_ID_MAX + 1),
				features: ["viewerEnter"],
			}).success,
		).toBe(false);
	});

	it("0.x 的旧形状 { uid, kinds } 不再收", () => {
		expect(SpecialViewerSchema.safeParse({ uid: "1", kinds: ["danmaku"] }).success).toBe(false);
	});
});

describe("Subscription.specialViewers", () => {
	const base = {
		id: "11111111-1111-4111-8111-111111111111",
		identity: { sourceKey: "bilibili", externalId: "10001" },
		enabled: true,
		routing: {
			post: [],
			liveStart: [],
			liveStreaming: [],
			liveEnd: [],
			membership: [],
			superchat: [],
			viewerChat: [],
			viewerEnter: [],
		},
		overrides: {},
	};

	it("缺着就是空名单", () => {
		expect(SubscriptionSchema.parse(base).specialViewers).toEqual([]);
	});

	it("带着名单原样收下", () => {
		const parsed = SubscriptionSchema.parse({
			...base,
			specialViewers: [{ id: "42", features: ["viewerEnter"] }],
		});
		expect(parsed.specialViewers).toEqual([{ id: "42", features: ["viewerEnter"] }]);
	});
});
