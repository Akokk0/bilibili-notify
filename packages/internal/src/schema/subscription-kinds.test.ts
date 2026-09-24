/**
 * 订阅分两支(ADR-0019 决策 9 / 12 / 47 / 50):B 站订阅与拓展订阅在内存里是一份联合列表。
 *
 * - B 站那支「一个字不动」:盘上没有 `kind`,读进来补成 `"bilibili"`;老数据迁移照旧。
 * - 拓展那支:身份是 `(extensionId, externalId)`,**没有 uid**,也没有特别关注;单人定时锐评两支都有(ADR-0020 决策 14)。
 * - 联合那一份按 `kind` 分派,错误只报那一支自己的。
 */

import { describe, expect, it } from "vite-plus/test";
import { FEATURE_KEYS, isBiliSubscription, isExtensionSubscription } from "../constants";
import { makeDefaultGlobalConfig } from "./globals";
import { resolve } from "./resolve";
import {
	BiliSubscriptionSchema,
	EXTENSION_SUBSCRIPTION_EXTERNAL_ID_MAX,
	ExtensionSubscriptionSchema,
	makeEmptySubscription,
	type Subscription,
	SubscriptionSchema,
} from "./subscriptions";

const T1 = "10000000-0000-4000-8000-000000000001";
const T2 = "10000000-0000-4000-8000-000000000002";

const emptyRouting = () =>
	Object.fromEntries(FEATURE_KEYS.map((k) => [k, [] as string[]])) as Record<
		(typeof FEATURE_KEYS)[number],
		string[]
	>;

/** 盘上 `subscriptions.json` 里的一行 —— 旧载荷写出来的形状,没有 `kind`。 */
function diskBiliRow(): Record<string, unknown> {
	const { kind: _kind, ...rest } = makeEmptySubscription({
		id: "11111111-1111-4111-8111-111111111111",
		uid: "12345",
	});
	return rest;
}

function extRow(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		kind: "extension",
		id: "22222222-2222-4222-8222-222222222222",
		extensionId: "douyin",
		externalId: "MS4wLjABAAAA-sec_uid",
		enabled: true,
		groups: [],
		routing: emptyRouting(),
		overrides: {},
		...over,
	};
}

describe("B 站那支", () => {
	it("盘上没有 kind 的老行走联合解析 → 补成 bilibili,其余字段原样", () => {
		const parsed = SubscriptionSchema.parse(diskBiliRow());
		expect(parsed.kind).toBe("bilibili");
		expect(isBiliSubscription(parsed) && parsed.uid).toBe("12345");
	});

	it("剥掉补上的 kind,其余键的顺序与旧载荷写出来的一字不差", () => {
		const raw = diskBiliRow();
		const { kind, ...rest } = BiliSubscriptionSchema.parse(raw);
		expect(kind).toBe("bilibili");
		expect(Object.keys(rest)).toEqual(Object.keys(raw));
	});

	it("老数据迁移经联合那一份照样跑(第二代 @全体 → extras)", () => {
		const parsed = SubscriptionSchema.parse({
			...diskBiliRow(),
			routing: { ...emptyRouting(), dynamic: [T1] },
			atAll: { dynamic: { [T1]: true } },
		});
		expect(parsed.extras.atAllDynamic).toEqual({ [T1]: true });
	});

	it("makeEmptySubscription 造的是 B 站订阅", () => {
		expect(makeEmptySubscription({ id: T1, uid: "1" }).kind).toBe("bilibili");
	});
});

describe("拓展那支", () => {
	it("经联合解析 → kind extension,身份两格都在,没有 uid / 特别关注", () => {
		const parsed = SubscriptionSchema.parse(extRow({ uid: "999", specialUsers: [] }));
		expect(parsed.kind).toBe("extension");
		expect(isExtensionSubscription(parsed) && parsed.externalId).toBe("MS4wLjABAAAA-sec_uid");
		expect(isExtensionSubscription(parsed) && parsed.extensionId).toBe("douyin");
		expect("uid" in parsed).toBe(false);
		expect("specialUsers" in parsed).toBe(false);
	});

	it("单人定时锐评也长在拓展订阅上(ADR-0020 决策 14):写了就留着,形状同 B 站那一格", () => {
		const schedule = {
			enabled: true,
			cron: "0 9 * * 1",
			days: 14,
			targets: [T1],
			approval: true,
			notifyOnError: false,
		};
		const parsed = SubscriptionSchema.parse(extRow({ roastSchedule: schedule }));
		expect(isExtensionSubscription(parsed) && parsed.roastSchedule).toEqual(schedule);
	});

	it("老的拓展订阅没有这一格 → 补出厂默认(关着),与 B 站老订阅同一个口径", () => {
		const ext = SubscriptionSchema.parse(extRow());
		const bili = SubscriptionSchema.parse(diskBiliRow());
		expect(isExtensionSubscription(ext) && ext.roastSchedule).toEqual(
			isBiliSubscription(bili) && bili.roastSchedule,
		);
		expect(isExtensionSubscription(ext) && ext.roastSchedule.enabled).toBe(false);
	});

	it("外部 id 不解读、原样保留(什么字符都可能有)", () => {
		const externalId = "  a:b/c?d=e#f 中文  ";
		const parsed = ExtensionSubscriptionSchema.parse(extRow({ externalId }));
		expect(parsed.externalId).toBe(externalId);
	});

	it.each([
		["缺 externalId", { externalId: undefined }, "externalId"],
		["空 externalId", { externalId: "" }, "externalId"],
		[
			"超长 externalId",
			{ externalId: "x".repeat(EXTENSION_SUBSCRIPTION_EXTERNAL_ID_MAX + 1) },
			"externalId",
		],
		["缺 extensionId", { extensionId: undefined }, "extensionId"],
		["不合规矩的 extensionId", { extensionId: "Douyin!" }, "extensionId"],
	])("%s → 拒收,错指在那一格", (_label, over, key) => {
		const r = SubscriptionSchema.safeParse(extRow(over));
		expect(r.success).toBe(false);
		expect(r.error?.issues.map((i) => i.path[0])).toEqual([key]);
	});

	it("外部 id 恰好在上限 → 收", () => {
		const externalId = "x".repeat(EXTENSION_SUBSCRIPTION_EXTERNAL_ID_MAX);
		expect(SubscriptionSchema.safeParse(extRow({ externalId })).success).toBe(true);
	});

	it("附加项 ⊆ 主特性目标那条规矩对拓展订阅同样成立", () => {
		const r = SubscriptionSchema.safeParse(
			extRow({
				routing: { ...emptyRouting(), dynamic: [T1] },
				extras: { atAllDynamic: { [T2]: true } },
			}),
		);
		expect(r.success).toBe(false);
		expect(r.error?.issues[0]?.path).toEqual(["extras", "atAllDynamic"]);
	});
});

describe("联合那一份按 kind 分派", () => {
	it("写着 extension 却长着 B 站的样子 → 拒收,不回落成 B 站订阅", () => {
		const r = SubscriptionSchema.safeParse({ ...diskBiliRow(), kind: "extension" });
		expect(r.success).toBe(false);
		// 缺的是拓展那支的身份,而不是一坨「两支都不像」的联合错误。
		expect(r.error?.issues.map((i) => i.path[0]).sort()).toEqual(["extensionId", "externalId"]);
	});

	it("认不得的 kind → 错指在 kind", () => {
		const r = SubscriptionSchema.safeParse({ ...diskBiliRow(), kind: "douyin" });
		expect(r.success).toBe(false);
		expect(r.error?.issues.map((i) => i.path)).toEqual([["kind"]]);
	});

	it("坏掉的 B 站行只报 B 站那支的错,且外层路径照常补上", () => {
		const r = SubscriptionSchema.array().safeParse([diskBiliRow(), { ...diskBiliRow(), uid: "x" }]);
		expect(r.success).toBe(false);
		expect(r.error?.issues.map((i) => i.path)).toEqual([[1, "uid"]]);
	});
});

describe("类型收窄与折叠", () => {
	it("两个判据互斥", () => {
		const subs: Subscription[] = [
			SubscriptionSchema.parse(diskBiliRow()),
			SubscriptionSchema.parse(extRow()),
		];
		expect(subs.filter(isBiliSubscription).map((s) => s.uid)).toEqual(["12345"]);
		expect(subs.filter(isExtensionSubscription).map((s) => s.externalId)).toEqual([
			"MS4wLjABAAAA-sec_uid",
		]);
	});

	it("resolve() 折叠拓展订阅:带身份两格,不带 uid / 特别关注", () => {
		const eff = resolve(
			ExtensionSubscriptionSchema.parse(extRow({ routing: { ...emptyRouting(), live: [T1] } })),
			makeDefaultGlobalConfig().defaults,
		);
		expect(eff.kind).toBe("extension");
		expect(eff.extensionId).toBe("douyin");
		expect(eff.externalId).toBe("MS4wLjABAAAA-sec_uid");
		expect(eff.routing.live).toEqual([T1]);
		expect("uid" in eff).toBe(false);
		expect("specialUsers" in eff).toBe(false);
	});

	it("resolve() 折叠 B 站订阅:kind / uid / 特别关注都在", () => {
		const eff = resolve(
			makeEmptySubscription({ id: T1, uid: "42" }),
			makeDefaultGlobalConfig().defaults,
		);
		expect(eff.kind).toBe("bilibili");
		expect(eff.uid).toBe("42");
		expect(eff.specialUsers).toEqual([]);
	});
});
