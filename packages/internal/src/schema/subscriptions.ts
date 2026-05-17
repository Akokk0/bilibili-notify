import { z } from "zod";
import {
	AIPersonaSchema,
	CardStylePartialSchema,
	ContentFiltersPartialSchema,
	FEATURE_KEYS,
	FeatureFlagsPartialSchema,
	type FeatureKey,
	ScheduleConfigPartialSchema,
	TemplateBundlePartialSchema,
} from "./common";

/**
 * 路由：每个特性 → PushTarget.id[]。空数组 = 该特性不推。
 * 用 record + 显式 keys 而不是 partial，便于 UI 始终展示所有特性的开关。
 */
const SubscriptionRoutingObjectSchema = z.object(
	Object.fromEntries(FEATURE_KEYS.map((k) => [k, z.array(z.uuid())])) as {
		[K in FeatureKey]: z.ZodArray<z.ZodUUID>;
	},
);
export type SubscriptionRouting = z.infer<typeof SubscriptionRoutingObjectSchema>;

/**
 * 解析时按 feature 去重 target UUID。重复 UUID 会让同一 feature 对同一目标
 * 重复推送 + 重复 delivery 记录。用**幂等 transform**而非 refine:既归一化
 * 当前/历史数据,又不会让既有含重复项的持久化配置在 parse 时直接 reject。
 */
export const SubscriptionRoutingSchema = SubscriptionRoutingObjectSchema.transform((r) => {
	const out = {} as SubscriptionRouting;
	for (const k of FEATURE_KEYS) out[k] = [...new Set(r[k])];
	return out;
});

/**
 * 缓存的 UP 主档案，用于 UI 显示。non-authoritative，启动 / 心跳时刷新。
 */
export const CachedProfileSchema = z.object({
	name: z.string(),
	avatar: z.string(),
	sign: z.string(),
	fans: z.number().int().min(0),
	lastRefreshedAt: z.string(),
});
export type CachedProfile = z.infer<typeof CachedProfileSchema>;

/**
 * 特别关注用户：进房 / 弹幕 触发自定义模板推送。
 */
export const SpecialUserSchema = z.object({
	uid: z.string(),
	kinds: z.array(z.enum(["enter", "danmaku"])).min(1),
	template: z.string().optional(),
});
export type SpecialUser = z.infer<typeof SpecialUserSchema>;

/**
 * AI 覆盖：preset 决定使用哪一份 persona/prompt。
 * - 'inherit'：直接继承 GlobalConfig.defaults.ai（其它字段被 resolveAI 忽略）
 * - 'custom'：使用本对象中的 persona/dynamicPrompt/liveSummaryPrompt（缺失项继承全局）
 * - 任意其它字符串：解读为 GlobalConfig.defaults.ai.presets 中对应 preset.id；
 *   解析失败时回退到 'custom' 行为（用本对象现存字段）
 *
 * 单 schema 设计：persona/prompts 字段无论 preset 取何值都允许（"inherit" 时它们仅被忽略）。
 * 这样避免 TS 在 z.union 中对 "inherit" / "custom" / 任意 preset.id 的 narrowing 失败。
 */
export const AIOverrideSchema = z.object({
	preset: z.string(),
	persona: AIPersonaSchema.optional(),
	dynamicPrompt: z.string().optional(),
	liveSummaryPrompt: z.string().optional(),
	temperature: z.number().min(0).max(2).optional(),
});
export type AIOverride = z.infer<typeof AIOverrideSchema>;

/**
 * @全体 订阅级默认。每个 UP 主独立持有自己的「默认 @全体」策略,作用于 routing 里的所有 target
 * (除非该 target 在 `atAll` Map 中有显式 override)。
 *
 * 默认值约定:开播默认 ON、动态默认 OFF (开播事件比较重要更值得 @,动态高频且日常)。
 */
export const SubscriptionAtAllDefaultsSchema = z.object({
	dynamic: z.boolean().default(false),
	live: z.boolean().default(true),
});
export type SubscriptionAtAllDefaults = z.infer<typeof SubscriptionAtAllDefaultsSchema>;

/**
 * @全体 per-target 覆写。tristate:
 * - Map 里没有 key → inherit(走 `atAllDefaults`)
 * - `atAll.X[targetId] = true` → 强制 ON
 * - `atAll.X[targetId] = false` → 强制 OFF
 *
 * 约束:Map 的 key 必须出现在 `routing[feature]` 列表里 ——「单独开 @」无意义。
 *
 * 作用范围:
 * - `atAll.dynamic`:过了过滤器的动态都 @ (任意动态类型)
 * - `atAll.live`:仅作用于 LivePushType.Live (开播),不冲 liveEnd / SC / 上舰 / 词云 / AI 总结
 *
 * SubscriptionSchema.refine() 强制 keys 子集约束;违反约束的旧数据 parse 时报错。
 */
export const SubscriptionAtAllSchema = z.object({
	dynamic: z.record(z.uuid(), z.boolean()).default({}),
	live: z.record(z.uuid(), z.boolean()).default({}),
});
export type SubscriptionAtAll = z.infer<typeof SubscriptionAtAllSchema>;

/**
 * 单 UP 的覆盖配置；任意字段为 undefined 表示继承 GlobalConfig.defaults。
 */
export const SubscriptionOverridesSchema = z.object({
	features: FeatureFlagsPartialSchema.optional(),
	filters: ContentFiltersPartialSchema.optional(),
	schedule: ScheduleConfigPartialSchema.optional(),
	templates: TemplateBundlePartialSchema.optional(),
	ai: AIOverrideSchema.optional(),
	cardStyle: CardStylePartialSchema.optional(),
});
export type SubscriptionOverrides = z.infer<typeof SubscriptionOverridesSchema>;

/**
 * fans 时序的「订阅起点」基线。FansPoller 第一次给该订阅取到 fans 值时写入,
 * 此后永不变。24h / 7d 的 delta 由后端读取 fans jsonl 时序计算,不在 schema 中。
 */
export const FansBaselineSchema = z.object({
	value: z.number().int().min(0),
	ts: z.string(),
});
export type FansBaseline = z.infer<typeof FansBaselineSchema>;

/**
 * 运行时状态。Dashboard 只读展示；不持久化到 koishi config，独立端持久化到 state.json。
 */
export const SubscriptionStateSchema = z.object({
	lastDynamicId: z.string().optional(),
	lastPushedAt: z.object({
		dynamic: z.string().optional(),
		live: z.string().optional(),
	}),
	liveStatus: z.enum(["idle", "live", "unknown"]),
	fansBaseline: FansBaselineSchema.optional(),
});
export type SubscriptionState = z.infer<typeof SubscriptionStateSchema>;

/**
 * 单一订阅模型，统一 SubItem (基础) + AdvancedSubItem (高级) 两套。
 * id 与 uid 分离：id 是 dashboard 内部稳定标识；uid 是 B 站用户 ID。
 */
export const SubscriptionSchema = z
	.object({
		id: z.uuid(),
		uid: z.string().regex(/^\d+$/, "uid must be a numeric Bilibili UID string"),
		enabled: z.boolean(),
		groups: z.array(z.string()).default([]),
		notes: z.string().optional(),
		cachedProfile: CachedProfileSchema.optional(),
		routing: SubscriptionRoutingSchema,
		atAllDefaults: SubscriptionAtAllDefaultsSchema.default({ dynamic: false, live: true }),
		atAll: SubscriptionAtAllSchema.default({ dynamic: {}, live: {} }),
		overrides: SubscriptionOverridesSchema,
		specialUsers: z.array(SpecialUserSchema).default([]),
		state: SubscriptionStateSchema,
	})
	.refine((s) => Object.keys(s.atAll.dynamic).every((t) => s.routing.dynamic.includes(t)), {
		message: "atAll.dynamic keys must be a subset of routing.dynamic",
		path: ["atAll", "dynamic"],
	})
	.refine((s) => Object.keys(s.atAll.live).every((t) => s.routing.live.includes(t)), {
		message: "atAll.live keys must be a subset of routing.live",
		path: ["atAll", "live"],
	});
export type Subscription = z.infer<typeof SubscriptionSchema>;

/** 工厂：创建一个完全继承全局默认的空 Subscription（routing 全空、overrides 全 undefined）。 */
export function makeEmptySubscription(opts: { id: string; uid: string }): Subscription {
	const emptyRouting = Object.fromEntries(
		FEATURE_KEYS.map((k) => [k, [] as string[]]),
	) as SubscriptionRouting;
	return {
		id: opts.id,
		uid: opts.uid,
		enabled: true,
		groups: [],
		notes: undefined,
		cachedProfile: undefined,
		routing: emptyRouting,
		atAllDefaults: { dynamic: false, live: true },
		atAll: { dynamic: {}, live: {} },
		overrides: {},
		specialUsers: [],
		state: {
			lastDynamicId: undefined,
			lastPushedAt: {},
			liveStatus: "unknown",
		},
	};
}
