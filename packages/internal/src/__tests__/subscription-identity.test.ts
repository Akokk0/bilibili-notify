/**
 * 订阅的身份(ADR-0021 决策 14):每条订阅带 `identity`,`subscriptionIdentityOf` 是全仓唯一的读法;
 * `identityColor` 换读法不换颜色;拓展 id 不许用内置集成的保留 id。
 */

import { describe, expect, it } from "vite-plus/test";
import {
	identityColor,
	RESERVED_EXTENSION_IDS,
	sameIdentity,
	subscriptionIdentityOf,
} from "../identity";
import { ExtensionIdSchema } from "../schema/extension-manifest";
import { makeEmptySubscription, SubscriptionSchema } from "../schema/subscriptions";

describe("subscriptionIdentityOf", () => {
	it("B 站订阅:来源是 bilibili,外部 id 是 uid", () => {
		const sub = makeEmptySubscription({
			id: "5c9c3a8e-2f4f-4a51-9d57-1f2a3b4c5d6e",
			identity: { sourceKey: "bilibili", externalId: "12345" },
		});
		expect(subscriptionIdentityOf(sub)).toEqual({ sourceKey: "bilibili", externalId: "12345" });
	});

	it("拓展订阅:来源是拓展 id(不加前缀),外部 id 原样", () => {
		const sub = makeEmptySubscription({
			id: "5c9c3a8e-2f4f-4a51-9d57-1f2a3b4c5d6e",
			identity: { sourceKey: "douyin", externalId: "MS4w" },
		});
		expect(subscriptionIdentityOf(sub)).toEqual({ sourceKey: "douyin", externalId: "MS4w" });
	});

	it("就是读订阅上的那一格,什么都不推断(不看别的键)", () => {
		const identity = { sourceKey: "douyin", externalId: "MS4w" };
		expect(subscriptionIdentityOf({ identity })).toBe(identity);
	});

	it("同一串外部 id 挂在不同来源下是两个人", () => {
		const bili = subscriptionIdentityOf({
			identity: { sourceKey: "bilibili", externalId: "12345" },
		});
		const ext = subscriptionIdentityOf({
			identity: { sourceKey: "douyin", externalId: "12345" },
		});
		expect(sameIdentity(bili, ext)).toBe(false);
		expect(sameIdentity(bili, { sourceKey: "bilibili", externalId: "12345" })).toBe(true);
	});
});

describe("identityColor", () => {
	it("由描述符声明按外部 id 取色，来源键不决定规则", () => {
		expect(
			identityColor({ sourceKey: "library", externalId: "12345" }, { colorByExternalId: true }),
		).toBe("#fb7299");
	});
	it("B 站按外部 id、拓展按「拓展 id:外部 id」取色", () => {
		const before = [
			{
				identity: { sourceKey: "bilibili", externalId: "12345" },
				color: "#fb7299",
			},
			{ identity: { sourceKey: "douyin", externalId: "12345" }, color: "#ffaf7b" },
		];
		for (const { identity, color } of before)
			expect(
				identityColor(identity, { colorByExternalId: identity.sourceKey === "bilibili" }),
			).toBe(color);
	});
});

describe("保留 id", () => {
	it("通用 ID 校验保留核心名，集成名由宿主校验", () => {
		for (const id of RESERVED_EXTENSION_IDS) {
			expect(ExtensionIdSchema.safeParse(id).success, id).toBe(false);
		}
		for (const id of ["core", "image", "ai"]) {
			expect(RESERVED_EXTENSION_IDS, id).toContain(id);
			expect(ExtensionIdSchema.safeParse(id).success, id).toBe(false);
		}
		for (const id of ["douyin", "bilibili", "onebot", "qq-official", "webhook"]) {
			expect(ExtensionIdSchema.safeParse(id).success).toBe(true);
		}
	});
});

describe("特别关注是公共形状", () => {
	it("拓展来源的订阅没写这一格,读进来是空表", () => {
		const bili = makeEmptySubscription({
			id: "5c9c3a8e-2f4f-4a51-9d57-1f2a3b4c5d6e",
			identity: { sourceKey: "bilibili", externalId: "1" },
		});
		const { specialViewers: _special, identity: _identity, ...common } = bili;
		const parsed = SubscriptionSchema.parse({
			...common,
			identity: { sourceKey: "douyin", externalId: "MS4w" },
		});
		expect(parsed.specialViewers).toEqual([]);
	});
});
