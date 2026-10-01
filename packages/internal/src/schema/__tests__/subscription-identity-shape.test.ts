/**
 * 订阅只有一种形状(ADR-0021 决策 14、15):每行带 `identity` —— 来源(`sourceKey`,`bilibili` 或拓展 id)
 * 加来源那头的 id(`externalId`)。B 站与拓展的订阅同一个 schema、同一个文件;订的是谁只看 `identity`。
 *
 * - `identity` 是 strict 的:两格之外多一个键就拒,缺哪一格都拒。顶层的未知键(0.x 留下的 `kind` / `uid` /
 *   `extensionId` / `externalId`)被剥掉,不整份拒收。迁移器把它们收进 `identity`,见
 *   `apps/server/src/migration/subscriptions.ts`;活 schema 只认新形状。
 * - 外部 id 合不合来源的规矩(B 站的 uid 是数字)**不在这里**:中立的 schema 不认得哪个来源的 id 长什么样,
 *   那一道核在新建 B 站订阅的路由上(`routes/__tests__/subs-extension-create.test.ts`)。
 */

import { describe, expect, it } from "vite-plus/test";
import { FEATURE_KEYS } from "../../constants";
import { makeDefaultGlobalConfig } from "../globals";
import { resolve } from "../resolve";
import {
	EXTERNAL_ID_MAX,
	IdentitySchema,
	makeEmptySubscription,
	SourceKeySchema,
	SubscriptionSchema,
} from "../subscriptions";

const T1 = "10000000-0000-4000-8000-000000000001";
const T2 = "10000000-0000-4000-8000-000000000002";

const emptyRouting = () =>
	Object.fromEntries(FEATURE_KEYS.map((k) => [k, [] as string[]])) as Record<
		(typeof FEATURE_KEYS)[number],
		string[]
	>;

const BILI = { sourceKey: "bilibili", externalId: "12345" };
const DOUYIN = { sourceKey: "douyin", externalId: "MS4wLjABAAAA-sec_uid" };

/** 盘上 `subscriptions.json` 里的一行:`makeEmptySubscription` 写出来的样子。 */
function diskRow(identity: Record<string, unknown> = BILI): Record<string, unknown> {
	return {
		...makeEmptySubscription({
			id: "11111111-1111-4111-8111-111111111111",
			identity: { sourceKey: "bilibili", externalId: "placeholder" },
		}),
		identity,
	};
}

/** 只写必填几格的一行:带默认值的键(groups / extras / roastSchedule / specialUsers)都缺着。 */
function minimalRow(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "22222222-2222-4222-8222-222222222222",
		identity: DOUYIN,
		enabled: true,
		routing: emptyRouting(),
		overrides: {},
		...over,
	};
}

describe("带 identity 的行读得进(B 站与拓展同一个 schema)", () => {
	it.each([
		["B 站", BILI],
		["拓展", DOUYIN],
	])("%s:身份两格原样在,其余字段不动", (_label, identity) => {
		const parsed = SubscriptionSchema.parse(diskRow(identity));
		expect(parsed.identity).toEqual(identity);
		expect(parsed.id).toBe("11111111-1111-4111-8111-111111111111");
		expect(parsed.enabled).toBe(true);
	});

	it("parse 不增键不减键不换序:读回来再写盘与 makeEmptySubscription 写出来的一字不差", () => {
		const raw = diskRow();
		expect(Object.keys(SubscriptionSchema.parse(raw))).toEqual(Object.keys(raw));
	});

	it("makeEmptySubscription 带上给的身份,而且是拷一份(改调用方手里那个不牵连订阅)", () => {
		const identity = { sourceKey: "douyin", externalId: "MS4w" };
		const sub = makeEmptySubscription({ id: T1, identity });
		expect(sub.identity).toEqual({ sourceKey: "douyin", externalId: "MS4w" });
		identity.externalId = "changed";
		expect(sub.identity.externalId).toBe("MS4w");
	});

	it("外部 id 不解读、原样保留(什么字符都可能有)", () => {
		const externalId = "  a:b/c?d=e#f 中文  ";
		const parsed = SubscriptionSchema.parse(minimalRow({ identity: { ...DOUYIN, externalId } }));
		expect(parsed.identity.externalId).toBe(externalId);
	});

	it("中立:schema 不核外部 id 合不合来源的规矩(B 站的 uid 是不是数字归新建那条路管)", () => {
		const parsed = SubscriptionSchema.safeParse(
			minimalRow({ identity: { sourceKey: "bilibili", externalId: "not-a-number" } }),
		);
		expect(parsed.success).toBe(true);
	});
});

describe("身份读不进的行", () => {
	it.each([
		["缺 identity", { identity: undefined }, [["identity"]]],
		["identity 不是对象", { identity: "bilibili:12345" }, [["identity"]]],
		["identity 多一格", { identity: { ...DOUYIN, extra: "x" } }, [["identity"]]],
		["缺 sourceKey", { identity: { externalId: "1" } }, [["identity", "sourceKey"]]],
		["缺 externalId", { identity: { sourceKey: "douyin" } }, [["identity", "externalId"]]],
		["空 externalId", { identity: { ...DOUYIN, externalId: "" } }, [["identity", "externalId"]]],
		[
			"超长 externalId",
			{ identity: { ...DOUYIN, externalId: "x".repeat(EXTERNAL_ID_MAX + 1) } },
			[["identity", "externalId"]],
		],
		[
			"不合 id 形状的 sourceKey",
			{ identity: { ...DOUYIN, sourceKey: "Douyin!" } },
			[["identity", "sourceKey"]],
		],
		["空 sourceKey", { identity: { ...DOUYIN, sourceKey: "" } }, [["identity", "sourceKey"]]],
		// 来源键会被拿去当键查表:原型上的名字查一个没有的也会摸到内置函数(同拓展 id 那一条)。
		[
			"原型上的名字当 sourceKey",
			{ identity: { ...DOUYIN, sourceKey: "constructor" } },
			[["identity", "sourceKey"]],
		],
	])("%s → 拒收,错指在那一格", (_label, over, paths) => {
		const r = SubscriptionSchema.safeParse(minimalRow(over));
		expect(r.success).toBe(false);
		expect(r.error?.issues.map((i) => i.path)).toEqual(paths);
	});

	it("外部 id 恰好在上限 → 收", () => {
		const externalId = "x".repeat(EXTERNAL_ID_MAX);
		expect(
			SubscriptionSchema.safeParse(minimalRow({ identity: { ...DOUYIN, externalId } })).success,
		).toBe(true);
	});

	it("坏掉的一行只报它自己的错,外层路径带上下标", () => {
		const r = SubscriptionSchema.array().safeParse([
			diskRow(),
			diskRow({ sourceKey: "bilibili", externalId: "" }),
		]);
		expect(r.success).toBe(false);
		expect(r.error?.issues.map((i) => i.path)).toEqual([[1, "identity", "externalId"]]);
	});

	it("附加项 ⊆ 主特性目标那条规矩对哪个来源的订阅都成立", () => {
		for (const identity of [BILI, DOUYIN]) {
			const r = SubscriptionSchema.safeParse(
				minimalRow({
					identity,
					routing: { ...emptyRouting(), dynamic: [T1] },
					extras: { atAllDynamic: { [T2]: true } },
				}),
			);
			expect(r.success).toBe(false);
			expect(r.error?.issues[0]?.path).toEqual(["extras", "atAllDynamic"]);
		}
	});
});

describe("顶层的老身份格被剥掉,不整份拒收", () => {
	it("0.x 的 kind / uid / extensionId / externalId 摆在顶层 → 读得进,结果里一个都没有", () => {
		const parsed = SubscriptionSchema.parse({
			...diskRow(BILI),
			kind: "bilibili",
			uid: "999",
			extensionId: "douyin",
			externalId: "MS4w",
		});
		for (const key of ["kind", "uid", "extensionId", "externalId"]) {
			expect(key in parsed, key).toBe(false);
		}
		// 身份只看 identity,顶层那几格说什么都不改它。
		expect(parsed.identity).toEqual(BILI);
	});

	it("只有老身份格、没有 identity 的行(0.x 原样)→ 拒收:活 schema 不认老形状,那是迁移器的事", () => {
		const { identity: _identity, ...rest } = diskRow();
		const r = SubscriptionSchema.safeParse({ ...rest, kind: "bilibili", uid: "12345" });
		expect(r.success).toBe(false);
		expect(r.error?.issues.map((i) => i.path)).toEqual([["identity"]]);
	});
});

describe("两格各自的尺子", () => {
	it("SourceKeySchema:和拓展 id 同一种形状,但不排除保留 id —— bilibili 本身就是一个来源", () => {
		for (const ok of ["bilibili", "douyin", "acme.tiktok", "a1-b2"]) {
			expect(SourceKeySchema.safeParse(ok).success, ok).toBe(true);
		}
		for (const bad of ["", "Douyin", "-douyin", "douyin-", "a..b", "a.b.c", "x".repeat(65)]) {
			expect(SourceKeySchema.safeParse(bad).success, bad).toBe(false);
		}
	});

	it("IdentitySchema 是 strict 的", () => {
		expect(IdentitySchema.safeParse(BILI).success).toBe(true);
		expect(IdentitySchema.safeParse({ ...BILI, kind: "bilibili" }).success).toBe(false);
	});
});

describe("订阅其余各格不因来源而异", () => {
	it("没写特别关注 → 空表,B 站与拓展一样", () => {
		for (const identity of [BILI, DOUYIN]) {
			expect(SubscriptionSchema.parse(minimalRow({ identity })).specialUsers).toEqual([]);
		}
	});

	it("单人定时锐评:写了就留着,没写补出厂默认(关着),两种来源同一个口径", () => {
		const schedule = {
			enabled: true,
			cron: "0 9 * * 1",
			days: 14,
			targets: [T1],
			approval: true,
			notifyOnError: false,
		};
		const bili = SubscriptionSchema.parse(minimalRow({ identity: BILI, roastSchedule: schedule }));
		const ext = SubscriptionSchema.parse(minimalRow({ roastSchedule: schedule }));
		expect(bili.roastSchedule).toEqual(schedule);
		expect(ext.roastSchedule).toEqual(schedule);

		const biliDefault = SubscriptionSchema.parse(minimalRow({ identity: BILI }));
		const extDefault = SubscriptionSchema.parse(minimalRow());
		expect(extDefault.roastSchedule).toEqual(biliDefault.roastSchedule);
		expect(extDefault.roastSchedule.enabled).toBe(false);
	});
});

describe("resolve() 折叠", () => {
	it.each([
		["B 站", BILI],
		["拓展", DOUYIN],
	])(
		"%s:带 identity,没有 kind / uid / extensionId / externalId 这些键;特别关注是空表",
		(_label, identity) => {
			const eff = resolve(
				SubscriptionSchema.parse(
					minimalRow({ identity, routing: { ...emptyRouting(), live: [T1] } }),
				),
				makeDefaultGlobalConfig().defaults,
			);
			expect(eff.identity).toEqual(identity);
			expect(eff.routing.live).toEqual([T1]);
			expect(eff.specialUsers).toEqual([]);
			for (const key of ["kind", "uid", "extensionId", "externalId"]) {
				expect(key in eff, key).toBe(false);
			}
		},
	);

	it("折叠出来的 identity 是独立的一份:改它不牵连订阅本体", () => {
		const sub = makeEmptySubscription({ id: T1, identity: { ...BILI } });
		const eff = resolve(sub, makeDefaultGlobalConfig().defaults);
		eff.identity.externalId = "changed";
		expect(sub.identity.externalId).toBe("12345");
	});
});
