/**
 * M2 — cachedProfile / state 外置后的 schema 收缩护栏。
 *
 * 设计决策(sub-runtime-externalization-plan,LOCKED #1/#2):
 *  - SubscriptionSchema / makeEmptySubscription / EffectiveSubscription 不再含
 *    cachedProfile / state(Subscription 现为纯配置)。
 *  - **不写迁移代码**:Zod 默认 strip 未知键 —— 旧 subscriptions.json 里内嵌的
 *    cachedProfile / state 在 parse 时被自动剥离,clean 加载。
 *  - CachedProfileSchema / FansBaselineSchema / SubscriptionStateSchema 仍 export
 *    (SubRuntimeStore + /api/subs join 复用),只是从 SubscriptionSchema 摘掉。
 */

import { describe, expect, it } from "vitest";
import { makeDefaultGlobalConfig } from "./globals";
import { resolve } from "./resolve";
import {
	CachedProfileSchema,
	FansBaselineSchema,
	makeEmptySubscription,
	type Subscription,
	SubscriptionSchema,
	SubscriptionStateSchema,
} from "./subscriptions";

const BASE = makeEmptySubscription({
	id: "550e8400-e29b-41d4-a716-446655440000",
	uid: "12345",
});

/** 模拟一条 release 前的、cachedProfile/state 仍内嵌的旧 subscriptions.json 记录。 */
const LEGACY_RAW = {
	...BASE,
	cachedProfile: {
		name: "老UP",
		avatar: "https://example.com/x.png",
		sign: "旧签名",
		fans: 999,
		lastRefreshedAt: "2026-05-01T00:00:00.000Z",
	},
	state: {
		lastDynamicId: "987654321",
		lastPushedAt: { dynamic: "2026-05-01T00:00:00.000Z" },
		liveStatus: "live",
		fansBaseline: { value: 800, ts: "2026-04-01T00:00:00.000Z" },
	},
};

describe("M2: SubscriptionSchema 剥离 cachedProfile / state", () => {
	it("旧记录(内嵌 cachedProfile+state)parse 成功,且结果无这两个键", () => {
		const parsed = SubscriptionSchema.parse(LEGACY_RAW);
		expect("cachedProfile" in parsed).toBe(false);
		expect("state" in parsed).toBe(false);
		// 其余配置字段完好
		expect(parsed.id).toBe(BASE.id);
		expect(parsed.uid).toBe("12345");
		expect(parsed.enabled).toBe(true);
	});

	it("safeParse 同样成功(load 路径用的就是 safeParse)", () => {
		const r = SubscriptionSchema.safeParse(LEGACY_RAW);
		expect(r.success).toBe(true);
		if (r.success) {
			expect("cachedProfile" in r.data).toBe(false);
			expect("state" in r.data).toBe(false);
		}
	});

	it("makeEmptySubscription 结果不含 cachedProfile / state 键", () => {
		expect("cachedProfile" in BASE).toBe(false);
		expect("state" in BASE).toBe(false);
	});

	it("makeEmptySubscription 结果本身通过 SubscriptionSchema(纯配置自洽)", () => {
		const r = SubscriptionSchema.safeParse(BASE);
		expect(r.success).toBe(true);
	});

	it("用户手填 UP 昵称保留在 name(纯配置),makeEmpty 默认不写", () => {
		expect(BASE.name).toBeUndefined();
		const parsed = SubscriptionSchema.parse({ ...BASE, name: "Asaki大人" });
		expect(parsed.name).toBe("Asaki大人");
		const eff = resolve(parsed, makeDefaultGlobalConfig().defaults);
		expect(eff.name).toBe("Asaki大人");
	});

	it("resolve() 输出不含 cachedProfile / state", () => {
		const globals = makeDefaultGlobalConfig();
		const eff = resolve(BASE as Subscription, globals.defaults) as unknown as Record<
			string,
			unknown
		>;
		expect("cachedProfile" in eff).toBe(false);
		expect("state" in eff).toBe(false);
	});

	it("旧记录经 resolve() 同样不渗出 cachedProfile / state", () => {
		const globals = makeDefaultGlobalConfig();
		const parsed = SubscriptionSchema.parse(LEGACY_RAW);
		const eff = resolve(parsed, globals.defaults) as unknown as Record<string, unknown>;
		expect("cachedProfile" in eff).toBe(false);
		expect("state" in eff).toBe(false);
	});
});

describe("M2: 外置 schema 仍 export(SubRuntimeStore / join 复用)", () => {
	it("CachedProfileSchema 仍可独立 parse", () => {
		const r = CachedProfileSchema.safeParse({
			name: "n",
			avatar: "a",
			sign: "s",
			fans: 10,
			lastRefreshedAt: "2026-05-19T00:00:00.000Z",
		});
		expect(r.success).toBe(true);
	});

	it("FansBaselineSchema 仍可独立 parse", () => {
		const r = FansBaselineSchema.safeParse({ value: 100, ts: "2026-05-19T00:00:00.000Z" });
		expect(r.success).toBe(true);
	});

	it("SubscriptionStateSchema 仍 export(向后兼容,零风险保留)", () => {
		expect(SubscriptionStateSchema).toBeDefined();
		const r = SubscriptionStateSchema.safeParse({ lastPushedAt: {}, liveStatus: "unknown" });
		expect(r.success).toBe(true);
	});
});

// 回归(Codex 高危发现):TemplateBundleSchema 的 dynamic/dynamicVideo 带 .default()
// 供全局 globals.json 缺字段回填,但 `.partial()` 不剥内层 default → per-UP override
// 解析会把它们注入成默认值,被下游误当 per-UP 动态模板覆盖(停止跟随全局热更 + 面板
// 误标已定制 + 落盘)。override schema 已拆成无默认纯可选,此处锁住。
describe("per-UP template override 不被全局默认污染 (Codex 回归)", () => {
	it("只覆盖 templates.liveSummary → dynamic/dynamicVideo 仍 undefined", () => {
		const parsed = SubscriptionSchema.parse({
			...BASE,
			overrides: { templates: { liveSummary: "只改总结" } },
		});
		expect(parsed.overrides.templates?.liveSummary).toBe("只改总结");
		expect(parsed.overrides.templates?.dynamic).toBeUndefined();
		expect(parsed.overrides.templates?.dynamicVideo).toBeUndefined();
	});

	it("只覆盖 templates.liveStart(直播消息)→ dynamic/dynamicVideo 仍 undefined", () => {
		const parsed = SubscriptionSchema.parse({
			...BASE,
			overrides: { templates: { liveStart: "自定义开播 {name}" } },
		});
		expect(parsed.overrides.templates?.dynamic).toBeUndefined();
		expect(parsed.overrides.templates?.dynamicVideo).toBeUndefined();
	});

	it("显式覆盖 templates.dynamic → 保留;未覆盖的 dynamicVideo 仍 undefined", () => {
		const parsed = SubscriptionSchema.parse({
			...BASE,
			overrides: { templates: { dynamic: "🔔 {name} {url}" } },
		});
		expect(parsed.overrides.templates?.dynamic).toBe("🔔 {name} {url}");
		expect(parsed.overrides.templates?.dynamicVideo).toBeUndefined();
	});
});
