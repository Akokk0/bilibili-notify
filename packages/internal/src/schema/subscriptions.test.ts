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

import { describe, expect, it } from "vite-plus/test";
import { CardStyleSchema } from "./common";
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
		// wordcloudStopWords 带 .default("")，partial 同样须剥默认，否则误注入空串覆盖。
		expect(parsed.overrides.templates?.wordcloudStopWords).toBeUndefined();
	});

	it("只覆盖 templates.wordcloudStopWords → liveSummary/dynamic 仍 undefined", () => {
		const parsed = SubscriptionSchema.parse({
			...BASE,
			overrides: { templates: { wordcloudStopWords: "刷屏,哈哈" } },
		});
		expect(parsed.overrides.templates?.wordcloudStopWords).toBe("刷屏,哈哈");
		expect(parsed.overrides.templates?.liveSummary).toBeUndefined();
		expect(parsed.overrides.templates?.dynamic).toBeUndefined();
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

// 回归:overrides.filters 被「动态过滤」与「直播阈值」两个 section 分域共写。
// ContentFiltersSchema 的 blockDraw/blockAv 带 .default(false),`.partial()` 不剥内层
// default → per-UP 只覆盖直播阈值(minScPrice/minGuardLevel)时会被注入 blockDraw:false/
// blockAv:false。这俩属「动态过滤」域,前端据「字段 !== undefined」误判该 UP 已覆盖动态过滤
// → 一开直播阈值就连带点亮动态过滤(toggle + 侧栏小点)。override schema 已剥默认,此处锁住。
describe("per-UP filters/schedule override 不被全局默认污染", () => {
	it("只覆盖直播阈值域(minScPrice/minGuardLevel)→ blockDraw/blockAv 仍 undefined", () => {
		const parsed = SubscriptionSchema.parse({
			...BASE,
			overrides: { filters: { minScPrice: 50, minGuardLevel: 2 } },
		});
		const f = parsed.overrides.filters;
		expect(f?.minScPrice).toBe(50);
		expect(f?.minGuardLevel).toBe(2);
		expect(f?.blockDraw).toBeUndefined();
		expect(f?.blockAv).toBeUndefined();
		expect(f?.blockKeywords).toBeUndefined();
		expect(Object.keys(f ?? {}).sort()).toEqual(["minGuardLevel", "minScPrice"]);
	});

	it("只覆盖过滤域(blockKeywords)→ minScPrice/minGuardLevel 仍 undefined", () => {
		const parsed = SubscriptionSchema.parse({
			...BASE,
			overrides: { filters: { blockKeywords: ["广告"] } },
		});
		const f = parsed.overrides.filters;
		expect(f?.blockKeywords).toEqual(["广告"]);
		expect(f?.minScPrice).toBeUndefined();
		expect(f?.minGuardLevel).toBeUndefined();
	});
});

// 回归:CardStyleObjectSchema 有 7 个带 .default() 的字段(enabled/font/showPopularity/
// showArea/showFans/backgroundImages/glassClear),`.partial()` 同样不剥内层 default。
// per-UP 只覆盖一个字段(如 cardColorStart)时若被注入这 7 个默认值,resolve() 的
// merge(defaults.cardStyle, ov.cardStyle) 会拿注入值盖掉全局自定义 —— 最严重:全局
// enabled=false(关图片渲染)被翻回 true。与上面三个兄弟 schema 同源,此处锁住。
describe("per-UP cardStyle override 不被全局默认污染", () => {
	it("只覆盖 cardStyle.cardColorStart → 7 个带默认的字段仍 undefined", () => {
		const parsed = SubscriptionSchema.parse({
			...BASE,
			overrides: { cardStyle: { cardColorStart: "#ff0000" } },
		});
		const cs = parsed.overrides.cardStyle;
		expect(cs?.cardColorStart).toBe("#ff0000");
		expect(cs?.enabled).toBeUndefined();
		expect(cs?.font).toBeUndefined();
		expect(cs?.showPopularity).toBeUndefined();
		expect(cs?.showArea).toBeUndefined();
		expect(cs?.showFans).toBeUndefined();
		expect(cs?.backgroundImages).toBeUndefined();
		expect(cs?.glassClear).toBeUndefined();
		expect(Object.keys(cs ?? {})).toEqual(["cardColorStart"]);
	});

	it("per-kind cardStyleByKind.live 单字段覆盖 → 带默认字段仍 undefined", () => {
		const parsed = SubscriptionSchema.parse({
			...BASE,
			overrides: { cardStyleByKind: { live: { cardColorStart: "#abc" } } },
		});
		const cs = parsed.overrides.cardStyleByKind?.live;
		expect(cs?.cardColorStart).toBe("#abc");
		expect(cs?.enabled).toBeUndefined();
		expect(cs?.backgroundImages).toBeUndefined();
		expect(Object.keys(cs ?? {})).toEqual(["cardColorStart"]);
	});

	it("migrateCardStyle 仍生效:旧 backgroundImage(单值)→ backgroundImages 列表", () => {
		const parsed = SubscriptionSchema.parse({
			...BASE,
			overrides: { cardStyle: { backgroundImage: "bg.png" } as Record<string, unknown> },
		});
		expect(parsed.overrides.cardStyle?.backgroundImages).toEqual(["bg.png"]);
	});

	it("liveCoverImages:全局带默认空列表,per-UP 单字段覆盖不注入", () => {
		// 全局 CardStyleSchema:缺省回填 []。
		const global = CardStyleSchema.parse({ cardColorStart: "#111111", cardColorEnd: "#222222" });
		expect(global.liveCoverImages).toEqual([]);
		// per-UP partial:只覆盖颜色 → liveCoverImages 不被 default 注入(防 .partial() 雷)。
		const parsed = SubscriptionSchema.parse({
			...BASE,
			overrides: { cardStyle: { cardColorStart: "#ff0000" } },
		});
		expect(parsed.overrides.cardStyle?.liveCoverImages).toBeUndefined();
	});

	it("liveCoverImages:per-UP 覆盖颜色时,resolve 后全局封面列表仍生效", () => {
		const defaults = makeDefaultGlobalConfig().defaults;
		defaults.cardStyle.liveCoverImages = ["cover-a", "cover-b"];
		const sub = SubscriptionSchema.parse({
			...BASE,
			overrides: { cardStyle: { cardColorStart: "#ff0000" } },
		});
		const eff = resolve(sub, defaults);
		expect(eff.cardStyle.cardColorStart).toBe("#ff0000");
		expect(eff.cardStyle.liveCoverImages).toEqual(["cover-a", "cover-b"]);
	});

	it("只覆盖 schedule.pushTime → liveEndGrace/liveEndGraceMinutes 仍 undefined", () => {
		const parsed = SubscriptionSchema.parse({
			...BASE,
			overrides: { schedule: { pushTime: 3 } },
		});
		const s = parsed.overrides.schedule;
		expect(s?.pushTime).toBe(3);
		expect(s?.liveEndGrace).toBeUndefined();
		expect(s?.liveEndGraceMinutes).toBeUndefined();
		expect(Object.keys(s ?? {})).toEqual(["pushTime"]);
	});
});
