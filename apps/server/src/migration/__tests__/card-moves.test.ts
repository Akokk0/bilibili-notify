/**
 * 卡片设置的搬家与老皮肤指针回默认(㉔e):0.x 的 `cardStyle` / `cardStyleByKind` 并成 1.0 的 `cards`。
 *
 * 0.x 的全局设置与逐订阅覆盖里,和卡片有关的四格是 `cardStyle`(出图总开关、直播封面、一批退役字段)、
 * `cardStyleByKind`(按卡种分开存的同一份形状,键 `live` / `dynamic` / `sc` / `guard`)、`cardSkin`(皮肤指针)与
 * `cardSkinKnobs`(按皮肤 id 分的旋钮)。㉔a 曾钉过「四格原样透传」的现状,这一份是它的接班:
 *
 * - 全局:`cards = { enabled, liveCoverImageIds }`,封面按「卡种那份有就用它(空数组也算有),否则基准」并;
 * - 逐订阅:`overrides.cards = { liveCoverImageIds }`,并完没有就不留;
 * - 退役字段、别的卡种下的东西、逐订阅与按卡种的 `enabled` 丢掉;
 * - 指针不是内置 `default` 的回 `default`,旋钮只留内置那一套(ADR-0022 决策 12)。
 *
 * 输入**不往** `zero-fixtures.ts` 的夹具里加:`zero-generation.test.ts` 里「产出变了就得抬 MIGRATION_REVISION」
 * 那条测试钉着整套夹具的迁移产出摘要,往夹具里加东西会改摘要。这里在夹具之外造独立输入,走同一条纯函数流水
 * (设置:`migrateGlobalsToCurrent`;订阅行:`toCurrentRow`,守卫 13 跑的也是这两条)。
 *
 * 验红:`mutate.py` 式逐条破坏 —— 见每条用例的「验红」。
 */

import { GlobalConfigSchema, SubscriptionSchema } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { moveGlobalCards, moveSubscriptionCards } from "../card-moves.js";
import { ZERO_GLOBAL_LIVE_FACTS } from "../live-split.js";
import { migrateGlobalsToCurrent } from "../settings.js";
import { toCurrentRow } from "../subscriptions.js";
import { makeZeroGlobals, zeroEmptySubscription } from "./zero-fixtures.js";

type Obj = Record<string, unknown>;

const SUB_ID = "33333333-3333-4333-8333-333333333333";
const CUSTOM_SKIN_ID = "my-skin";

/** 0.x 的一份「各格都带点东西」的 `cardStyle`:出图开关、直播封面、四个退役字段、两个更早退役的显隐键。 */
function zeroCardStyle(over: Obj = {}): Obj {
	return {
		enabled: false,
		liveCoverImages: ["cover-global.png"],
		font: "思源黑体",
		fontAsset: "font-asset-1",
		glassOpacity: 0.4,
		glassClear: true,
		hideDesc: true,
		hideFollower: true,
		...over,
	};
}

function migrateGlobal(patch: (defaults: Obj) => void): Obj {
	const globals = makeZeroGlobals() as unknown as Obj;
	patch(globals.defaults as Obj);
	return (migrateGlobalsToCurrent(globals) as { defaults: Obj }).defaults;
}

function migrateSub(overrides: Obj): Obj {
	const row = zeroEmptySubscription({
		id: SUB_ID,
		identity: { sourceKey: "demo", externalId: "10001" },
	});
	row.overrides = overrides;
	return (toCurrentRow(row, ZERO_GLOBAL_LIVE_FACTS) as { overrides: Obj }).overrides;
}

describe("全局设置:cardStyle / cardStyleByKind → cards", () => {
	// 验红:去掉 `cardsOfGlobal` 里取 `cardStyle.enabled` 的那格(或去掉并法里的 `cardStyleByKind.live`),这条红。
	it("开关取 cardStyle.enabled,封面取直播卡种那一份;两个老键与退役字段都不留", () => {
		const defaults = migrateGlobal((d) => {
			d.cardStyle = zeroCardStyle();
			d.cardStyleByKind = {
				live: { enabled: false, liveCoverImages: ["cover-live.png"], font: "楷体" },
				dynamic: { enabled: true, glassClear: false, fontAsset: "font-asset-2" },
				sc: { enabled: true },
				guard: { font: "宋体", liveCoverImages: ["cover-guard.png"] },
			};
		});
		expect(defaults.cards).toEqual({ enabled: false, liveCoverImageIds: ["cover-live.png"] });
		expect("cardStyle" in defaults).toBe(false);
		expect("cardStyleByKind" in defaults).toBe(false);
	});

	// 验红:把 `cardsOfGlobal` 换成「谁先排到取谁」或去掉 `cardStyleByKind.live` 的优先,这条红。
	it("直播卡种那份没写封面 → 取基准那份;别的卡种(guard)下的封面不算", () => {
		const defaults = migrateGlobal((d) => {
			d.cardStyle = zeroCardStyle();
			d.cardStyleByKind = {
				guard: { liveCoverImages: ["cover-guard.png"] },
				live: { enabled: true },
			};
		});
		expect(defaults.cards).toEqual({ enabled: false, liveCoverImageIds: ["cover-global.png"] });
	});

	// 验红:把 `coverOf` 里的 `Array.isArray` 改成「非空才算有」,这条红(空列表被当成没写、基准封面又冒出来)。
	it("直播卡种那份写了空列表 = 主人清空了封面:盖掉基准,不是回头取基准", () => {
		const defaults = migrateGlobal((d) => {
			d.cardStyle = zeroCardStyle();
			d.cardStyleByKind = { live: { liveCoverImages: [] } };
		});
		expect(defaults.cards).toEqual({ enabled: false, liveCoverImageIds: [] });
	});

	// 验红:去掉 `cardsOfGlobal` 里 `typeof enabled === "boolean"` 的判断,这条红(会写出 `enabled: undefined`)。
	it("只有封面没有开关 → 只搬封面;开关缺的格子由 schema 补出厂值", () => {
		const defaults = migrateGlobal((d) => {
			d.cardStyle = { liveCoverImages: ["c.png"] };
			d.cardStyleByKind = {};
		});
		expect(defaults.cards).toEqual({ liveCoverImageIds: ["c.png"] });
		const parsed = GlobalConfigSchema.shape.defaults.shape.cards.parse(defaults.cards);
		expect(parsed).toEqual({ enabled: true, liveCoverImageIds: ["c.png"] });
	});

	// 验红:把 `cardsOfGlobal` 的早退条件改成只看封面(去掉 `typeof enabled !== "boolean" &&`),这条红(主人关了出图被丢掉)。
	it("只有开关没有封面 → 只搬开关:主人关掉出图的选择不能丢", () => {
		const defaults = migrateGlobal((d) => {
			d.cardStyle = { enabled: false };
			d.cardStyleByKind = {};
		});
		expect(defaults.cards).toEqual({ enabled: false });
	});

	it("两格都没有来源 → 不凭空造 cards", () => {
		const defaults = migrateGlobal((d) => {
			d.cardStyle = { font: "x" };
			d.cardStyleByKind = {};
		});
		expect("cards" in defaults).toBe(false);
		expect("cardStyle" in defaults).toBe(false);
	});

	// 验红:把 `placed` 逻辑改成末尾追加,键序断言红。
	it("cards 写在老键原来的位置:在 cardSkin 之前,键序与 1.0 schema 一致", () => {
		const defaults = migrateGlobal((d) => {
			d.cardStyle = zeroCardStyle();
		});
		const keys = Object.keys(defaults);
		expect(keys.indexOf("cards")).toBeGreaterThan(-1);
		expect(keys.indexOf("cards")).toBeLessThan(keys.indexOf("cardSkin"));
	});

	// 验红:去掉 `movedPointer`(或把条件改成永远原样),这条红。
	it("cardSkin 指向自建皮肤 → 回 default;本来就是 default 的、不是字符串的原样放过", () => {
		expect(
			migrateGlobal((d) => {
				d.cardSkin = CUSTOM_SKIN_ID;
			}).cardSkin,
		).toBe("default");
		expect(
			migrateGlobal((d) => {
				d.cardSkin = "default";
			}).cardSkin,
		).toBe("default");
		expect(
			migrateGlobal((d) => {
				d.cardSkin = 5;
			}).cardSkin,
		).toBe(5);
	});

	// 验红:去掉 `keptKnobs` 的过滤,这条红。
	it("cardSkinKnobs 只留内置那一套,自建皮肤与别的皮肤的旋钮删掉(全删光留 {})", () => {
		const knobs = (d: Obj) => {
			d.cardSkinKnobs = {
				[CUSTOM_SKIN_ID]: { accent: "#ff6699" },
				default: { "gradient-start": "#112233" },
				"other-skin": { accent: "#336699" },
			};
		};
		expect(migrateGlobal(knobs).cardSkinKnobs).toEqual({
			default: { "gradient-start": "#112233" },
		});
		const onlyCustom = migrateGlobal((d) => {
			d.cardSkinKnobs = { [CUSTOM_SKIN_ID]: { accent: "#ff6699" } };
		});
		expect(onlyCustom.cardSkinKnobs).toEqual({});
	});

	// 验红:去掉 `Object.hasOwn(defaults, "cards")` 那一支,新老并存时会拿老键覆盖新键。
	it("新老键并存 → 以新键 cards 为准,老键丢掉", () => {
		const raw = {
			defaults: {
				cards: { enabled: true, liveCoverImageIds: ["new.png"] },
				cardStyle: zeroCardStyle(),
				cardStyleByKind: { live: { liveCoverImages: ["old.png"] } },
				cardSkin: "default",
				cardSkinKnobs: {},
			},
		};
		const out = moveGlobalCards(raw) as { defaults: Obj };
		expect(out.defaults.cards).toEqual({ enabled: true, liveCoverImageIds: ["new.png"] });
		expect("cardStyle" in out.defaults).toBe(false);
		expect("cardStyleByKind" in out.defaults).toBe(false);
	});

	// 验红:去掉 `moveGlobalCards` 开头「没有要搬的回同一个对象」那道 return,这条红。
	it("已经是新形状 → 回同一个对象(再跑一遍不变)", () => {
		const migrated = {
			defaults: migrateGlobal((d) => {
				d.cardStyle = zeroCardStyle();
			}),
		};
		expect(moveGlobalCards(migrated)).toBe(migrated);
	});

	it("认不得的形状原样放过(不是对象、没有 defaults)", () => {
		expect(moveGlobalCards(null)).toBeNull();
		expect(moveGlobalCards("x")).toBe("x");
		const noDefaults = { master: {} };
		expect(moveGlobalCards(noDefaults)).toBe(noDefaults);
	});
});

describe("逐订阅覆盖:cardStyle / cardStyleByKind → cards", () => {
	// 验红:去掉 `mergedCover` 里直播卡种优先,这条红(拿到 cover-sub.png)。
	it("直播卡种那份有封面就用它,否则基准;enabled 与退役字段丢掉", () => {
		const overrides = migrateSub({
			cardStyle: { enabled: false, liveCoverImages: ["cover-sub.png"], glassOpacity: 0.3 },
			cardStyleByKind: {
				live: { liveCoverImages: ["cover-sub-live.png"], enabled: false },
				sc: { font: "楷体" },
			},
		});
		expect(overrides.cards).toEqual({ liveCoverImageIds: ["cover-sub-live.png"] });
		expect("cardStyle" in overrides).toBe(false);
		expect("cardStyleByKind" in overrides).toBe(false);
		const baseOnly = migrateSub({ cardStyle: { liveCoverImages: ["cover-sub.png"] } });
		expect(baseOnly.cards).toEqual({ liveCoverImageIds: ["cover-sub.png"] });
	});

	it("空列表算「有」:这位 UP 自己清空了封面,不用全局的", () => {
		const overrides = migrateSub({ cardStyleByKind: { live: { liveCoverImages: [] } } });
		expect(overrides.cards).toEqual({ liveCoverImageIds: [] });
	});

	// 验红:去掉 `cover === undefined ? undefined :` 那一支,会留下 `cards: { liveCoverImageIds: undefined }`。
	it("没有封面来源(只有退役字段 / enabled)→ 不留 cards,跟随全局", () => {
		const overrides = migrateSub({
			cardStyle: { enabled: false, font: "x" },
			cardStyleByKind: { sc: { enabled: true } },
		});
		expect("cards" in overrides).toBe(false);
		expect("cardStyle" in overrides).toBe(false);
	});

	// 验红:去掉订阅那一支的 `movedPointer` / `keptKnobs`,这条红;去掉「删空了整个键拿掉」,最后一条断言红。
	it("cardSkin 指向自建皮肤回 default;cardSkinKnobs 里自建皮肤的删掉,删空了整个键拿掉", () => {
		const overrides = migrateSub({
			cardSkin: CUSTOM_SKIN_ID,
			cardSkinKnobs: { [CUSTOM_SKIN_ID]: { accent: "#00aa88" } },
		});
		expect(overrides.cardSkin).toBe("default");
		expect("cardSkinKnobs" in overrides).toBe(false);
		const mixed = migrateSub({
			cardSkinKnobs: { [CUSTOM_SKIN_ID]: { a: 1 }, default: { b: 2 } },
		});
		expect(mixed.cardSkinKnobs).toEqual({ default: { b: 2 } });
	});

	it("已经是新形状 → 回同一个对象;新老并存以 cards 为准", () => {
		const row = { overrides: { cards: { liveCoverImageIds: ["a"] }, cardSkin: "default" } };
		expect(moveSubscriptionCards(row)).toBe(row);
		const both = moveSubscriptionCards({
			overrides: {
				cards: { liveCoverImageIds: ["new"] },
				cardStyleByKind: { live: { liveCoverImages: ["old"] } },
			},
		}) as { overrides: Obj };
		expect(both.overrides.cards).toEqual({ liveCoverImageIds: ["new"] });
		expect("cardStyleByKind" in both.overrides).toBe(false);
	});

	it("搬完的整行过 SubscriptionSchema:cards 是 1.0 的形状,老键一个不留", () => {
		const row = zeroEmptySubscription({
			id: SUB_ID,
			identity: { sourceKey: "demo", externalId: "10001" },
		});
		row.overrides = { cardStyle: { liveCoverImages: ["c.png"] } };
		const current = toCurrentRow(row, ZERO_GLOBAL_LIVE_FACTS);
		const parsed = SubscriptionSchema.parse(current);
		expect(parsed.overrides.cards).toEqual({ liveCoverImageIds: ["c.png"] });
		expect(parsed.overrides).not.toHaveProperty("cardStyle");
	});
});
