/**
 * 卡片设置(㉔e):`defaults.cards { enabled, liveCoverImageIds }` 与逐订阅 `overrides.cards { liveCoverImageIds? }`。
 * 原来的 `cardStyle` / `cardStyleByKind`(出图开关、直播封面与一批退役的字体 / 玻璃字段,按卡种再存一遍)并成了这一份。
 */

import { describe, expect, it } from "vite-plus/test";
import { CardsOverridesSchema, CardsSettingsSchema } from "../common";
import { DEFAULT_CARDS, GlobalConfigSchema, makeDefaultGlobalConfig } from "../globals";
import { resolve } from "../resolve";
import { makeEmptySubscription, SubscriptionSchema } from "../subscriptions";

describe("CardsSettings(全局)", () => {
	it("出厂:出图开着、没有自定义封面", () => {
		expect(CardsSettingsSchema.parse(DEFAULT_CARDS)).toEqual({
			enabled: true,
			liveCoverImageIds: [],
		});
		expect(makeDefaultGlobalConfig().defaults.cards).toEqual(DEFAULT_CARDS);
	});

	it("缺的格子补默认(缺 enabled 补 true,缺 liveCoverImageIds 补 [])", () => {
		expect(CardsSettingsSchema.parse({})).toEqual({ enabled: true, liveCoverImageIds: [] });
		expect(CardsSettingsSchema.parse({ enabled: false })).toEqual({
			enabled: false,
			liveCoverImageIds: [],
		});
	});

	it("退役的字体 / 玻璃字段与老键不再有:存量值读的时候被静静剥掉,不拒收", () => {
		const parsed = CardsSettingsSchema.parse({
			enabled: true,
			font: "x",
			fontAsset: "y",
			glassOpacity: 0.5,
			glassClear: true,
			liveCoverImages: ["a"],
		}) as Record<string, unknown>;
		expect(Object.keys(parsed).sort()).toEqual(["enabled", "liveCoverImageIds"]);
	});

	it("整份 defaults 里缺 `cards`(1.0 开发期落的盘)→ 补出厂值,开机不挂", () => {
		const defaults = { ...makeDefaultGlobalConfig().defaults } as Record<string, unknown>;
		delete defaults.cards;
		const parsed = GlobalConfigSchema.parse({ ...makeDefaultGlobalConfig(), defaults });
		expect(parsed.defaults.cards).toEqual(DEFAULT_CARDS);
	});
});

describe("CardsOverrides(逐订阅)", () => {
	const BASE = makeEmptySubscription({
		id: "11111111-1111-4111-8111-111111111111",
		identity: { sourceKey: "demo", externalId: "1" },
	});

	// `.partial()` 不剥内层 `.default()` 的雷:覆盖层必须是「无默认的纯可选」,否则没覆盖会被注入成「覆盖成空」。
	it("什么都没写 → 没有任何键(不被默认值注入)", () => {
		expect(CardsOverridesSchema.parse({})).toEqual({});
		const parsed = SubscriptionSchema.parse({ ...BASE, overrides: { cards: {} } });
		expect(parsed.overrides.cards).toEqual({});
	});

	it("覆盖有就用覆盖(空列表也算:这位 UP 不用自定义封面),没有就用全局的", () => {
		const defaults = makeDefaultGlobalConfig().defaults;
		defaults.cards.liveCoverImageIds = ["cover-a", "cover-b"];
		const follow = resolve(SubscriptionSchema.parse({ ...BASE }), defaults);
		expect(follow.cards.liveCoverImageIds).toEqual(["cover-a", "cover-b"]);
		const own = resolve(
			SubscriptionSchema.parse({ ...BASE, overrides: { cards: { liveCoverImageIds: ["mine"] } } }),
			defaults,
		);
		expect(own.cards.liveCoverImageIds).toEqual(["mine"]);
		const none = resolve(
			SubscriptionSchema.parse({ ...BASE, overrides: { cards: { liveCoverImageIds: [] } } }),
			defaults,
		);
		expect(none.cards.liveCoverImageIds).toEqual([]);
		// 出图总开关只在全局:订阅覆盖不带它,生效值永远是全局的。
		expect(own.cards.enabled).toBe(true);
	});
});
