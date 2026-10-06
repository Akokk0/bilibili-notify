/**
 * 卡片样式设置与皮肤指针走迁移的现状(㉔a 钉住,㉔e 改)。
 *
 * 0.x 的全局设置与逐订阅覆盖里,和卡片有关的四格是 `cardStyle`(出图总开关、直播封面、一批退役字段)、
 * `cardStyleByKind`(按卡种分开存的同一份形状,键 `live` / `dynamic` / `sc` / `guard`)、`cardSkin`(皮肤指针)与
 * `cardSkinKnobs`(按皮肤 id 分的旋钮)。`zero-fixtures.ts` 的 0.x 夹具里这几格今天全是空的(`cardStyleByKind: {}`、
 * 指针 `"default"`、旋钮 `{}`),所以迁移对它们**非空**时做什么从来没有测试 —— 这一份用独立输入钉住。
 *
 * **今天的现状**:这四格都原样透传,迁移既不搬家、不改键,也不管指针指着谁。㉔e 动盘时要改的正是这里:
 * `cardStyle` / `cardStyleByKind` 并成 `cards`(带上直播封面、丢退役字段与没人读的 `enabled`),卡种键改新名,
 * 指向用户自建老皮肤的指针回 `default`、对应的旋钮删掉(ADR-0022 决策 12)。下面的字面量届时逐项改。
 *
 * 输入**不往** `zero-fixtures.ts` 的夹具里加:`zero-generation.test.ts` 里「产出变了就得抬 MIGRATION_REVISION」
 * 那条测试钉着整套夹具的迁移产出摘要,往夹具里加东西会改摘要。这里在夹具之外造独立输入,走同一条纯函数流水
 * (设置:`migrateGlobalsToCurrent`;订阅行:`toCurrentRow`,守卫 13 跑的也是这两条)。
 */

import { describe, expect, it } from "vite-plus/test";
import { ZERO_GLOBAL_LIVE_FACTS } from "../live-split.js";
import { migrateGlobalsToCurrent } from "../settings.js";
import { toCurrentRow } from "../subscriptions.js";
import { makeZeroGlobals, zeroEmptySubscription } from "./zero-fixtures.js";

type Obj = Record<string, unknown>;

const SUB_ID = "33333333-3333-4333-8333-333333333333";

/** 0.x 的一份「各格都带点东西」的 `cardStyle`:出图开关、直播封面、四个退役字段、两个更早退役的显隐键。 */
function zeroCardStyle(): Obj {
	return {
		enabled: false,
		liveCoverImages: ["cover-global.png"],
		font: "思源黑体",
		fontAsset: "font-asset-1",
		glassOpacity: 0.4,
		glassClear: true,
		hideDesc: true,
		hideFollower: true,
	};
}

/** 0.x 按卡种分开存的样式:四个卡种键各带一点东西(只有 `live.liveCoverImages` 在生产里有人读)。 */
function zeroCardStyleByKind(): Obj {
	return {
		live: { enabled: false, liveCoverImages: ["cover-live.png"], font: "楷体", glassOpacity: 0.7 },
		dynamic: { enabled: true, glassClear: false, fontAsset: "font-asset-2" },
		sc: { enabled: true },
		guard: { font: "宋体", liveCoverImages: ["cover-guard.png"] },
	};
}

/** 指向一个**自建**皮肤的指针与那套皮肤的旋钮(另夹一份别的皮肤的旋钮)。 */
const CUSTOM_SKIN_ID = "my-skin";
function zeroSkinKnobs(): Obj {
	return {
		[CUSTOM_SKIN_ID]: { accent: "#ff6699", wallpaper: ["upload-1"] },
		"other-skin": { accent: "#336699" },
	};
}

function migrateGlobalCards(): Obj {
	const globals = makeZeroGlobals() as unknown as Obj;
	const defaults = globals.defaults as Obj;
	defaults.cardStyle = zeroCardStyle();
	defaults.cardStyleByKind = zeroCardStyleByKind();
	defaults.cardSkin = CUSTOM_SKIN_ID;
	defaults.cardSkinKnobs = zeroSkinKnobs();
	const out = migrateGlobalsToCurrent(globals) as { defaults: Obj };
	return out.defaults;
}

function migrateSubscriptionCards(): Obj {
	const row = zeroEmptySubscription({
		id: SUB_ID,
		identity: { sourceKey: "demo", externalId: "10001" },
	});
	row.overrides = {
		cardStyle: { enabled: false, liveCoverImages: ["cover-sub.png"], glassOpacity: 0.3 },
		cardStyleByKind: {
			live: { liveCoverImages: ["cover-sub-live.png"], enabled: false },
			sc: { font: "楷体" },
		},
		cardSkin: CUSTOM_SKIN_ID,
		cardSkinKnobs: { [CUSTOM_SKIN_ID]: { accent: "#00aa88" } },
	};
	const out = toCurrentRow(row, ZERO_GLOBAL_LIVE_FACTS) as { overrides: Obj };
	return out.overrides;
}

describe("㉔a 0.x 全局设置里的卡片样式与皮肤指针走迁移", () => {
	it("cardStyle 原样透传(退役字段、liveCoverImages 都还在),没有 cards 这一格", () => {
		const defaults = migrateGlobalCards();
		expect(defaults.cardStyle).toEqual(zeroCardStyle());
		expect("cards" in defaults).toBe(false);
	});

	it("cardStyleByKind 原样透传:键还是 live / dynamic / sc / guard,各卡种的值一个字不改", () => {
		const defaults = migrateGlobalCards();
		expect(defaults.cardStyleByKind).toEqual(zeroCardStyleByKind());
		expect(Object.keys(defaults.cardStyleByKind as Obj)).toEqual([
			"live",
			"dynamic",
			"sc",
			"guard",
		]);
	});

	it("cardSkin 指向自建皮肤的指针不动,cardSkinKnobs 里那套皮肤与别的皮肤的旋钮都在", () => {
		const defaults = migrateGlobalCards();
		expect(defaults.cardSkin).toBe(CUSTOM_SKIN_ID);
		expect(defaults.cardSkinKnobs).toEqual(zeroSkinKnobs());
	});
});

describe("㉔a 0.x 逐订阅覆盖里的卡片样式与皮肤指针走迁移", () => {
	it("cardStyle / cardStyleByKind 原样透传,没有 cards 这一格", () => {
		const overrides = migrateSubscriptionCards();
		expect(overrides.cardStyle).toEqual({
			enabled: false,
			liveCoverImages: ["cover-sub.png"],
			glassOpacity: 0.3,
		});
		expect(overrides.cardStyleByKind).toEqual({
			live: { liveCoverImages: ["cover-sub-live.png"], enabled: false },
			sc: { font: "楷体" },
		});
		expect("cards" in overrides).toBe(false);
	});

	it("cardSkin 指向自建皮肤的指针不动,旋钮原样在", () => {
		const overrides = migrateSubscriptionCards();
		expect(overrides.cardSkin).toBe(CUSTOM_SKIN_ID);
		expect(overrides.cardSkinKnobs).toEqual({ [CUSTOM_SKIN_ID]: { accent: "#00aa88" } });
	});
});
