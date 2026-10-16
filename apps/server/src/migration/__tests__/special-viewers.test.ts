/**
 * 特别关注名单的搬家(3b-16):0.x 订阅上的 `specialUsers: { uid, kinds, template? }[]` → 1.0 的
 * `specialViewers: { id, features }[]`(`data-and-migration.md`:`uid` → `id`,`kinds` 的 `danmaku` / `enter` →
 * `features` 里的 `viewerChat` / `viewerEnter`,`template` 丢掉)。专门钉住:老键上的名单**一个不少**地到新键。
 *
 * 输入**不往** `zero-fixtures.ts` 的夹具里加(同 `card-moves.test.ts`:夹具的迁移产出摘要被
 * `zero-generation.test.ts` 钉着),在夹具之外造独立输入,走订阅行的同一条流水 `toCurrentRow`(守卫 13 跑的也是它)。
 *
 * 验红(施工时逐条真改坏跑过):
 * - 把 `enter` 那条映射去掉 / 改成 `viewerChat` → 「四种条目」「次序」两条红;
 * - 去掉 `.map`,只翻第一条 → 「一个不少」红;
 * - `template` 带过来(`...entry` 展开) → 「template 丢掉」红。
 */

import { SubscriptionSchema } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { ZERO_GLOBAL_LIVE_FACTS } from "../live-split.js";
import { toCurrentRow } from "../subscriptions.js";
import { zeroEmptySubscription } from "./zero-fixtures.js";

type Obj = Record<string, unknown>;

const SUB_ID = "44444444-4444-4444-8444-444444444444";

function migrate(specialUsers: unknown, over: Obj = {}): Obj {
	const row: Obj = {
		...zeroEmptySubscription({
			id: SUB_ID,
			identity: { sourceKey: "demo", externalId: "10001" },
		}),
		...over,
	};
	if (specialUsers !== undefined) row.specialUsers = specialUsers;
	else delete row.specialUsers;
	return toCurrentRow(row, ZERO_GLOBAL_LIVE_FACTS) as Obj;
}

describe("特别关注名单搬家:specialUsers → specialViewers", () => {
	it("四种条目一个不少:只弹幕、只进场、两种都有、带 template 的,id 与次序原样", () => {
		const out = migrate([
			{ uid: "1001", kinds: ["danmaku"] },
			{ uid: "1002", kinds: ["enter"] },
			{ uid: "1003", kinds: ["danmaku", "enter"] },
			{ uid: "1004", kinds: ["enter", "danmaku"], template: "{uname} 来了" },
		]);
		expect(out.specialViewers).toEqual([
			{ id: "1001", features: ["viewerChat"] },
			{ id: "1002", features: ["viewerEnter"] },
			{ id: "1003", features: ["viewerChat", "viewerEnter"] },
			{ id: "1004", features: ["viewerEnter", "viewerChat"] },
		]);
		expect(out).not.toHaveProperty("specialUsers");
	});

	it("template 丢掉,别的多余的格也不带过来", () => {
		const out = migrate([{ uid: "1", kinds: ["enter"], template: "x", extra: 1 }]);
		expect(out.specialViewers).toEqual([{ id: "1", features: ["viewerEnter"] }]);
	});

	it("空名单 → 空名单,键留在原位(键序不变)", () => {
		const out = migrate([]);
		expect(out.specialViewers).toEqual([]);
		const keys = Object.keys(out);
		expect(keys.at(-1)).toBe("specialViewers");
		expect(keys).not.toContain("specialUsers");
	});

	it("行上没有这一格的(拓展订阅常见)不长出来", () => {
		const out = migrate(undefined);
		expect(out).not.toHaveProperty("specialViewers");
		expect(out).not.toHaveProperty("specialUsers");
	});

	it("已经是新形状的行再跑一遍不变", () => {
		const first = migrate([{ uid: "7", kinds: ["danmaku"] }]);
		const again = toCurrentRow(first, ZERO_GLOBAL_LIVE_FACTS);
		expect(again).toEqual(first);
	});

	it("新老两键并存:以新键为准,老键丢掉", () => {
		const out = migrate([{ uid: "1", kinds: ["danmaku"] }], {
			specialViewers: [{ id: "9", features: ["viewerEnter"] }],
		});
		expect(out.specialViewers).toEqual([{ id: "9", features: ["viewerEnter"] }]);
		expect(out).not.toHaveProperty("specialUsers");
	});

	it("认不出的条目原样放过(留在新键里,由配置仓开机时报出来),认得出的照翻、次序不变", () => {
		const odd = [
			"not-an-object",
			{ kinds: ["danmaku"] },
			{ uid: 5, kinds: ["danmaku"] },
			{ uid: "6", kinds: [] },
			{ uid: "7", kinds: ["unknown-kind"] },
			{ uid: "8" },
		];
		const out = migrate([{ uid: "1", kinds: ["danmaku"] }, ...odd, { uid: "2", kinds: ["enter"] }]);
		expect(out.specialViewers).toEqual([
			{ id: "1", features: ["viewerChat"] },
			...odd,
			{ id: "2", features: ["viewerEnter"] },
		]);
	});

	it("条目里混了认不得的种类:认得的翻、认不得的丢,重复的只留一个", () => {
		const out = migrate([{ uid: "1", kinds: ["danmaku", "mystery", "danmaku", "enter"] }]);
		expect(out.specialViewers).toEqual([{ id: "1", features: ["viewerChat", "viewerEnter"] }]);
	});

	it("名单本身不是数组:换个键名原样带过去,不丢", () => {
		const out = migrate("oops");
		expect(out.specialViewers).toBe("oops");
		expect(out).not.toHaveProperty("specialUsers");
	});

	it("搬完的整行过 SubscriptionSchema:名单是 1.0 的形状", () => {
		const parsed = SubscriptionSchema.parse(
			migrate([
				{ uid: "1003", kinds: ["danmaku", "enter"], template: "t" },
				{ uid: "1001", kinds: ["danmaku"] },
			]),
		);
		expect(parsed.specialViewers).toEqual([
			{ id: "1003", features: ["viewerChat", "viewerEnter"] },
			{ id: "1001", features: ["viewerChat"] },
		]);
	});
});
