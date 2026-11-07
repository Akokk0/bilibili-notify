/**
 * M2 — cachedProfile / state 外置后的 schema 收缩护栏。
 *
 * 设计决策(sub-runtime-externalization-plan,LOCKED #1/#2):
 *  - SubscriptionSchema / makeEmptySubscription / EffectiveSubscription 不再含
 *    cachedProfile / state(Subscription 现为纯配置)。
 *  - **不写迁移代码**:Zod 默认 strip 未知键 —— 旧 subscriptions.json 里内嵌的
 *    cachedProfile / state 在 parse 时被自动剥离,clean 加载。
 *  - CreatorProfileSchema 仍 export(SubscriptionStateStore 复用),只是从 SubscriptionSchema 摘掉。
 *    旧的 SubscriptionStateSchema 没人写、1.0 第 2 期 ⑫ 删掉(新的运行态
 *    `SubscriptionState` 只剩资料缓存,见 docs/1.0/data-model.md)。
 */

import { describe, expect, it } from "vite-plus/test";
import { makeDefaultGlobalSettings } from "../globals";
import { resolve } from "../resolve";
import {
	CreatorProfileSchema,
	makeEmptySubscription,
	type Subscription,
	SubscriptionSchema,
} from "../subscriptions";

const BASE = makeEmptySubscription({
	id: "550e8400-e29b-41d4-a716-446655440000",
	identity: { sourceKey: "bilibili", externalId: "12345" },
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
	},
};

describe("M2: SubscriptionSchema 剥离 cachedProfile / state", () => {
	it("旧记录(内嵌 cachedProfile+state)parse 成功,且结果无这两个键", () => {
		const parsed = SubscriptionSchema.parse(LEGACY_RAW);
		expect("cachedProfile" in parsed).toBe(false);
		expect("state" in parsed).toBe(false);
		// 其余配置字段完好
		expect(parsed.id).toBe(BASE.id);
		expect(parsed.identity).toEqual({ sourceKey: "bilibili", externalId: "12345" });
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

	it("别名退役(ADR-0021 决策 16):盘上残留的 name 读进来被剥掉,折叠出来也没有", () => {
		expect("name" in BASE).toBe(false);
		const parsed = SubscriptionSchema.parse({ ...BASE, name: "Asaki大人" });
		expect("name" in parsed).toBe(false);
		const eff = resolve(parsed, makeDefaultGlobalSettings().defaults);
		expect("name" in eff).toBe(false);
	});

	it("resolve() 输出不含 cachedProfile / state", () => {
		const globals = makeDefaultGlobalSettings();
		const eff = resolve(BASE as Subscription, globals.defaults) as unknown as Record<
			string,
			unknown
		>;
		expect("cachedProfile" in eff).toBe(false);
		expect("state" in eff).toBe(false);
	});

	it("旧记录经 resolve() 同样不渗出 cachedProfile / state", () => {
		const globals = makeDefaultGlobalSettings();
		const parsed = SubscriptionSchema.parse(LEGACY_RAW);
		const eff = resolve(parsed, globals.defaults) as unknown as Record<string, unknown>;
		expect("cachedProfile" in eff).toBe(false);
		expect("state" in eff).toBe(false);
	});
});

describe("M2: 外置 schema 仍 export(SubscriptionStateStore / join 复用)", () => {
	it("CreatorProfile 用规格里的中立资料字段,旧缓存字段不再进结果", () => {
		const profile = CreatorProfileSchema.parse({
			name: "阿绫",
			avatar: `${"a".repeat(64)}.png`,
			bio: "今天也要开心",
			followers: 42,
			fanClubName: "阿绫的粉丝团",
			refreshedAt: "2026-10-24T00:00:00.000Z",
			sign: "旧签名",
			fans: 24,
			lastRefreshedAt: "2026-10-23T00:00:00.000Z",
			avatarUrl: "https://example.com/old.png",
		});
		expect(profile).toEqual({
			name: "阿绫",
			avatar: `${"a".repeat(64)}.png`,
			bio: "今天也要开心",
			followers: 42,
			fanClubName: "阿绫的粉丝团",
			refreshedAt: "2026-10-24T00:00:00.000Z",
		});
	});

	it("CreatorProfileSchema 仍可独立 parse", () => {
		const r = CreatorProfileSchema.safeParse({
			name: "n",
			bio: "s",
			followers: 10,
			refreshedAt: "2026-05-19T00:00:00.000Z",
		});
		expect(r.success).toBe(true);
	});

	it("头像只认图库引用;没有头像就缺键", () => {
		const base = { name: "n", refreshedAt: "2026-09-23T00:00:00.000Z" };
		const ref = `${"a".repeat(64)}.png`;
		expect(CreatorProfileSchema.safeParse(base).success).toBe(true);
		expect(CreatorProfileSchema.parse({ ...base, avatar: ref })).toMatchObject({ avatar: ref });
		expect(
			CreatorProfileSchema.safeParse({ ...base, avatar: "https://example.com/x.png" }).success,
		).toBe(false);
	});

	it("CreatorProfile 可以不带粉丝数(拓展的候选不一定知道;写成 0 就是撒谎),带了照旧不许负数", () => {
		const base = { name: "n", refreshedAt: "2026-09-23T00:00:00.000Z" };
		expect(CreatorProfileSchema.safeParse(base).success).toBe(true);
		expect(CreatorProfileSchema.safeParse({ ...base, followers: -1 }).success).toBe(false);
	});

	it("CreatorProfile 的 fanClubName 留得住;平台没有就缺键,不补空串", () => {
		const base = { name: "n", refreshedAt: "2026-09-23T00:00:00.000Z" };
		expect(CreatorProfileSchema.parse({ ...base, fanClubName: "阿绫的粉丝团" })).toMatchObject({
			fanClubName: "阿绫的粉丝团",
		});
		expect("fanClubName" in CreatorProfileSchema.parse(base)).toBe(false);
	});
});

// 回归(Codex 高危发现):TemplateBundleSchema 的 post/postVideo 带 .default()
// 供全局 globals.json 缺字段回填,但 `.partial()` 不剥内层 default → per-UP override
// 解析会把它们注入成默认值,被下游误当 per-UP 动态模板覆盖(停止跟随全局热更 + 面板
// 误标已定制 + 落盘)。override schema 已拆成无默认纯可选,此处锁住。
describe("per-UP template override 不被全局默认污染 (Codex 回归)", () => {
	it("只覆盖 templates.liveSummary → post/postVideo 仍 undefined", () => {
		const parsed = SubscriptionSchema.parse({
			...BASE,
			overrides: { templates: { liveSummary: "只改总结" } },
		});
		expect(parsed.overrides.templates?.liveSummary).toBe("只改总结");
		expect(parsed.overrides.templates?.post).toBeUndefined();
		expect(parsed.overrides.templates?.postVideo).toBeUndefined();
		// wordcloudStopWords 带 .default("")，partial 同样须剥默认，否则误注入空串覆盖。
		expect(parsed.overrides.templates?.wordcloudStopWords).toBeUndefined();
	});

	it("只覆盖 templates.wordcloudStopWords → liveSummary/post 仍 undefined", () => {
		const parsed = SubscriptionSchema.parse({
			...BASE,
			overrides: { templates: { wordcloudStopWords: "刷屏,哈哈" } },
		});
		expect(parsed.overrides.templates?.wordcloudStopWords).toBe("刷屏,哈哈");
		expect(parsed.overrides.templates?.liveSummary).toBeUndefined();
		expect(parsed.overrides.templates?.post).toBeUndefined();
	});

	it("只覆盖 templates.liveStart(直播消息)→ post/postVideo 仍 undefined", () => {
		const parsed = SubscriptionSchema.parse({
			...BASE,
			overrides: { templates: { liveStart: "自定义开播 {name}" } },
		});
		expect(parsed.overrides.templates?.post).toBeUndefined();
		expect(parsed.overrides.templates?.postVideo).toBeUndefined();
	});

	it("显式覆盖 templates.post → 保留;未覆盖的 postVideo 仍 undefined", () => {
		const parsed = SubscriptionSchema.parse({
			...BASE,
			overrides: { templates: { post: "🔔 {name} {url}" } },
		});
		expect(parsed.overrides.templates?.post).toBe("🔔 {name} {url}");
		expect(parsed.overrides.templates?.postVideo).toBeUndefined();
	});
});

// 回归:ContentFiltersSchema 的 blockImages/blockVideos 带 .default(false),`.partial()` 不剥内层 default →
// per-UP 只覆盖过滤域的一两个字段(blockKeywords)时会被注入 blockImages:false / blockVideos:false,前端据「字段 !==
// undefined」误判该 UP 把这两个开关也覆盖了。override schema 已剥默认,此处锁住。
// (早先这一段还要防「只覆盖直播阈值也连带点亮动态过滤」:直播阈值 minScPrice / minGuardLevel 原先和过滤共用一个切片;
// ㉓d 起它们是 overrides.superchat / overrides.membership 两个自己的切片,下面第二条锁住「两边互不牵连」。)
describe("per-UP filters/schedule override 不被全局默认污染", () => {
	it("只覆盖过滤域(blockKeywords)→ blockImages/blockVideos 仍 undefined,别的过滤字段也没被注入", () => {
		const parsed = SubscriptionSchema.parse({
			...BASE,
			overrides: { filters: { blockKeywords: ["广告"] } },
		});
		const f = parsed.overrides.filters;
		expect(f?.blockKeywords).toEqual(["广告"]);
		expect(f?.blockImages).toBeUndefined();
		expect(f?.blockVideos).toBeUndefined();
		expect(Object.keys(f ?? {})).toEqual(["blockKeywords"]);
		expect(parsed.overrides.superchat).toBeUndefined();
		expect(parsed.overrides.membership).toBeUndefined();
	});

	it("只覆盖直播门槛(superchat / membership 两段)→ overrides.filters 仍 undefined:开直播门槛不会连带点亮动态过滤", () => {
		const parsed = SubscriptionSchema.parse({
			...BASE,
			overrides: { superchat: { minAmount: 50 }, membership: { minRank: { guard: 2 } } },
		});
		expect(parsed.overrides.superchat).toEqual({ minAmount: 50 });
		expect(parsed.overrides.membership).toEqual({ minRank: { guard: 2 } });
		expect(parsed.overrides.filters).toBeUndefined();
	});
});

// 回归:`.partial()` 不剥内层 `.default()`。卡片设置的覆盖层(`CardsOverridesSchema`)是「无默认的纯可选」,
// 写它的测试在 `cards-settings.test.ts`;这里的 describe 留给 schedule 那一组。
describe("per-UP schedule override 不被全局默认污染", () => {
	it("只覆盖 schedule.liveEndGrace → liveEndGraceMinutes 仍 undefined,也不长出别的键", () => {
		const parsed = SubscriptionSchema.parse({
			...BASE,
			overrides: { schedule: { liveEndGrace: true } },
		});
		const s = parsed.overrides.schedule;
		expect(s?.liveEndGrace).toBe(true);
		expect(s?.liveEndGraceMinutes).toBeUndefined();
		expect(Object.keys(s ?? {})).toEqual(["liveEndGrace"]);
	});

	// 直播拆键(⑬d):周期间隔与启动补报各是自己的一段设置,per-UP 那份是无默认的纯可选 ——
	// 只写间隔就不该把补报也注入成 false、盖掉全局的 true。
	it("只覆盖 liveStreaming.streamingIntervalHours → 不长出 liveStart / schedule,键只有那一个", () => {
		const parsed = SubscriptionSchema.parse({
			...BASE,
			overrides: { liveStreaming: { streamingIntervalHours: 3 } },
		});
		expect(parsed.overrides.liveStreaming).toEqual({ streamingIntervalHours: 3 });
		expect(parsed.overrides.liveStart).toBeUndefined();
		expect(parsed.overrides.schedule).toBeUndefined();
		expect(Object.keys(parsed.overrides)).toEqual(["liveStreaming"]);
	});

	it("只覆盖 liveStart.catchUpOnBoot → 不长出 liveStreaming", () => {
		const parsed = SubscriptionSchema.parse({
			...BASE,
			overrides: { liveStart: { catchUpOnBoot: true } },
		});
		expect(parsed.overrides.liveStart).toEqual({ catchUpOnBoot: true });
		expect(parsed.overrides.liveStreaming).toBeUndefined();
	});

	it("逐订阅的间隔也守 1–24 的整数:0、25、小数都拒收", () => {
		for (const bad of [0, 25, 1.5, -1]) {
			expect(
				SubscriptionSchema.safeParse({
					...BASE,
					overrides: { liveStreaming: { streamingIntervalHours: bad } },
				}).success,
			).toBe(false);
		}
		for (const ok of [1, 24]) {
			expect(
				SubscriptionSchema.safeParse({
					...BASE,
					overrides: { liveStreaming: { streamingIntervalHours: ok } },
				}).success,
			).toBe(true);
		}
	});
});
