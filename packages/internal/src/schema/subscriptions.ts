import { z } from "zod";
import { CardLayoutSchema } from "./card-layout";
import {
	AIPersonaSchema,
	CardStyleByKindSchema,
	CardStylePartialSchema,
	ContentFiltersPartialSchema,
	FEATURE_KEYS,
	FeatureFlagsPartialSchema,
	type FeatureKey,
	ImageGroupSettingsPartialSchema,
	ScheduleConfigPartialSchema,
	TemplateBundlePartialSchema,
} from "./common";
import { MessageLayoutSchema } from "./message-layout";
import { DEFAULT_ROAST_SCHEDULE, RoastScheduleSchema } from "./roast-schedule";

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
 * 缓存的 UP 主档案，用于 UI 显示。non-authoritative。
 *
 * **不再内嵌于 Subscription**（高频 fans/lastRefreshedAt 写入会污染配置写路径）。
 * 独立端持久化到 apps/server 的 SubRuntimeStore（`<dataDir>/state/sub-runtime.json`）；
 * koishi 端不产生它。schema/type 仍导出，供 SubRuntimeStore + `/api/subs` join 复用。
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
	// P2:与 Subscription.uid 同约束 —— 此前裸 z.string() 放任非数字脏值,
	// 进入 includes(uid.toString()) 比对永不命中,特别关注静默失效无报错。
	uid: z.string().regex(/^\d+$/, "uid must be a numeric Bilibili UID string"),
	kinds: z.array(z.enum(["enter", "danmaku"])).min(1),
	template: z.string().optional(),
});
export type SpecialUser = z.infer<typeof SpecialUserSchema>;

/**
 * AI 覆盖 —— **两端语义不同的一个结构**,改之前先读完这段。
 *
 * ## 独立端 / AstrBot(走 `resolveAI`)
 *
 * `preset` 是**指针**:指向 `GlobalConfig.defaults.ai.presets` 里的一份。指不着就
 * 完整继承全局 —— 老值 `'inherit'`(当年那档「继承全局」)、`'custom'`(当年那档
 * 「完全自定义」)、以及指向一份已被删掉的人格,三者在那儿殊途同归。
 *
 * 这一侧**不读** `persona` / `dynamicPrompt` / `liveSummaryPrompt`。人格一律在
 * 「智能女仆」页里写,per-UP 只负责挑一份;设置页那档「完全自定义」已经撤掉,
 * 盘上的残留继续生效就成了界面上看不见、实际仍在起作用的鬼配置。设置页在开启
 * 覆盖时会顺手把它们显式清成 `null`。
 *
 * ## koishi 端(走 `koishi/src/live/sub-view.ts#buildAiOverride`,**不经过** `resolveAI`)
 *
 * 那一侧压根不暴露 preset 选择,`customAi.enable` 即「我自己填」——
 * `koishi/src/subscriptions/advanced.ts` 恒写 `preset: "custom"` 外加一整份
 * persona,再由 `buildAiOverride` 原样读回去。所以这三个字段**必须留在 schema 里**,
 * 删掉等于把 koishi 那半边的 per-UP 人格整个打死。
 *
 * ## 为什么 preset 是裸 string
 *
 * 单 schema:persona/prompts 无论 preset 取何值都允许。写成 z.union 会让 TS 在
 * 「具名 id vs 那两个历史常量」之间 narrowing 失败。
 */
export const AIOverrideSchema = z.object({
	preset: z.string(),
	persona: AIPersonaSchema.optional(),
	dynamicPrompt: z.string().optional(),
	liveSummaryPrompt: z.string().optional(),
	temperature: z.number().min(0).max(2).optional(),
	/**
	 * per-UP 指定的 AstrBot 人格 id(留空继承全局 --ai-persona-id)。与 preset 无关,
	 * 仅 AstrBot 端消费(让某个 UP 的总结用不同 AstrBot 人格);koishi/独立端忽略。
	 */
	personaId: z.string().optional(),
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
	// 按卡片类型的样式覆盖(可选);叠在该 UP 的 cardStyle 基准之上。见 resolveCardStyleForKind。
	cardStyleByKind: CardStyleByKindSchema.optional(),
	// 卡片版式是数组型描述符,不走 partial 浅合并 —— per-UP 一旦自定义即「整份覆盖」
	// (fork 全局版式后随便改),故用完整 CardLayoutSchema 而非 partial。
	cardLayout: CardLayoutSchema.optional(),
	// 消息版式同 cardLayout:数组型描述符,per-UP 一旦自定义即整份覆盖。
	messageLayout: MessageLayoutSchema.optional(),
	imageGroup: ImageGroupSettingsPartialSchema.optional(),
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
 * 运行时状态。**不再内嵌于 Subscription**——只有 fansBaseline 有真实写入方
 * (FansPoller)，其余字段全仓零写入方。fansBaseline 现由 apps/server 的
 * SubRuntimeStore 持久化；schema/type 保留导出仅为类型复用与向后兼容。
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
 *
 * **纯配置**：展示缓存 `cachedProfile` 与运行时 `state` 已外置到 apps/server 的
 * SubRuntimeStore（见 CachedProfileSchema / SubscriptionStateSchema 注释）。Zod
 * 默认 strip 未知键——旧 subscriptions.json 内嵌的这两个字段 load 时自动剥离。
 */
export const SubscriptionSchema = z
	.object({
		id: z.uuid(),
		uid: z.string().regex(/^\d+$/, "uid must be a numeric Bilibili UID string"),
		/** 用户手填的 UP 昵称 / 别名。不同于 cachedProfile.name(平台实时资料缓存)。 */
		name: z.string().optional(),
		enabled: z.boolean(),
		groups: z.array(z.string()).default([]),
		notes: z.string().optional(),
		routing: SubscriptionRoutingSchema,
		atAllDefaults: SubscriptionAtAllDefaultsSchema.default({ dynamic: false, live: true }),
		atAll: SubscriptionAtAllSchema.default({ dynamic: {}, live: {} }),
		overrides: SubscriptionOverridesSchema,
		/**
		 * 这位 UP 的单人锐评定时推送。
		 *
		 * 与 `specialUsers` 同类:per-UP 独有、**不参与 `resolve()` 折叠**,所以放
		 * 顶层而不是 `overrides`。塞进 overrides 的话它会去继承全局那条,而全局那
		 * 条是**榜单**周报 —— 继承过来的 cron / targets 跟界面上显示的对不上。
		 *
		 * UP 退订时这条配置跟着一起消失,不留孤儿调度。
		 */
		roastSchedule: RoastScheduleSchema.default(DEFAULT_ROAST_SCHEDULE),
		specialUsers: z.array(SpecialUserSchema).default([]),
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
		name: undefined,
		enabled: true,
		groups: [],
		notes: undefined,
		routing: emptyRouting,
		atAllDefaults: { dynamic: false, live: true },
		atAll: { dynamic: {}, live: {} },
		overrides: {},
		// 新订阅不自带定时锐评 —— 加一个 UP 不该顺手给群里排一条周期推送。
		roastSchedule: { ...DEFAULT_ROAST_SCHEDULE },
		specialUsers: [],
	};
}
