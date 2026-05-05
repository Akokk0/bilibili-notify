import { z } from "zod";

/** 全部可订阅的特性键。新增或删除会扩散到 FeatureFlags、SubscriptionRouting、Subscription.overrides。 */
export const FeatureKeySchema = z.enum([
	"dynamic",
	"dynamicAtAll",
	"live",
	"liveAtAll",
	"liveEnd",
	"liveGuardBuy",
	"superchat",
	"wordcloud",
	"liveSummary",
	"specialDanmaku",
	"specialUserEnter",
]);
export type FeatureKey = z.infer<typeof FeatureKeySchema>;

export const FEATURE_KEYS = FeatureKeySchema.options;

/** 每个特性的开关；使用 record 而非 z.record(boolean) 是为了让 inherit-merge 时类型保留键名。 */
export const FeatureFlagsSchema = z.object({
	dynamic: z.boolean(),
	dynamicAtAll: z.boolean(),
	live: z.boolean(),
	liveAtAll: z.boolean(),
	liveEnd: z.boolean(),
	liveGuardBuy: z.boolean(),
	superchat: z.boolean(),
	wordcloud: z.boolean(),
	liveSummary: z.boolean(),
	specialDanmaku: z.boolean(),
	specialUserEnter: z.boolean(),
});
export type FeatureFlags = z.infer<typeof FeatureFlagsSchema>;

export const FeatureFlagsPartialSchema = FeatureFlagsSchema.partial();
export type FeatureFlagsPartial = z.infer<typeof FeatureFlagsPartialSchema>;

/** 一个时段范围，闭合区间 [start, end)，单位：小时（0–23）。 */
export const TimeRangeSchema = z
	.object({
		start: z.number().int().min(0).max(23),
		end: z.number().int().min(0).max(23),
	})
	.refine((r) => r.start !== r.end, "start must differ from end (use 0..24 to mean全天)");
export type TimeRange = z.infer<typeof TimeRangeSchema>;

/** B 站舰长等级语义沿用，1=总督 / 2=提督 / 3=舰长。 */
export const GuardLevelSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type GuardLevel = z.infer<typeof GuardLevelSchema>;

export const ContentFiltersSchema = z.object({
	blockForward: z.boolean(),
	blockArticle: z.boolean(),
	blockKeywords: z.array(z.string()),
	blockRegex: z.array(z.string()),
	whitelistKeywords: z.array(z.string()),
	whitelistRegex: z.array(z.string()),
	minScPrice: z.number().int().min(0),
	minGuardLevel: GuardLevelSchema,
});
export type ContentFilters = z.infer<typeof ContentFiltersSchema>;

export const ContentFiltersPartialSchema = ContentFiltersSchema.partial();
export type ContentFiltersPartial = z.infer<typeof ContentFiltersPartialSchema>;

export const ScheduleConfigSchema = z.object({
	pushTime: z.number().int().min(0).max(24),
	restartPush: z.boolean(),
	quietHours: z.array(TimeRangeSchema),
});
export type ScheduleConfig = z.infer<typeof ScheduleConfigSchema>;

export const ScheduleConfigPartialSchema = ScheduleConfigSchema.partial();
export type ScheduleConfigPartial = z.infer<typeof ScheduleConfigPartialSchema>;

export const GuardEntrySchema = z.object({
	imageUrl: z.string(),
	template: z.string(),
});
export type GuardEntry = z.infer<typeof GuardEntrySchema>;

export const GuardBundleSchema = z.object({
	captain: GuardEntrySchema,
	commander: GuardEntrySchema,
	governor: GuardEntrySchema,
});
export type GuardBundle = z.infer<typeof GuardBundleSchema>;

export const TemplateBundleSchema = z.object({
	liveStart: z.string(),
	liveOngoing: z.string(),
	liveEnd: z.string(),
	liveSummary: z.string(),
	specialDanmaku: z.string(),
	specialUserEnter: z.string(),
	guardBuy: GuardBundleSchema,
});
export type TemplateBundle = z.infer<typeof TemplateBundleSchema>;

export const TemplateBundlePartialSchema = TemplateBundleSchema.partial();
export type TemplateBundlePartial = z.infer<typeof TemplateBundlePartialSchema>;

export const AIPersonaSchema = z.object({
	name: z.string(),
	addressUser: z.string(),
	addressSelf: z.string(),
	traits: z.string(),
	catchphrase: z.string(),
});
export type AIPersona = z.infer<typeof AIPersonaSchema>;

/** AI 总配置（在 GlobalConfig.defaults.ai 出现）。 */
export const AISettingsSchema = z.object({
	enabled: z.boolean(),
	baseUrl: z.string().optional(),
	apiKey: z.string().optional(),
	model: z.string(),
	temperature: z.number().min(0).max(2),
	persona: AIPersonaSchema,
	dynamicPrompt: z.string(),
	liveSummaryPrompt: z.string(),
	/** 内置 preset 模板列表；per-UP overrides.ai.preset 可选 'inherit' | 'custom' | 任意 preset.id */
	presets: z.array(
		z.object({
			id: z.string(),
			label: z.string(),
			persona: AIPersonaSchema,
			dynamicPrompt: z.string().optional(),
			liveSummaryPrompt: z.string().optional(),
		}),
	),
});
export type AISettings = z.infer<typeof AISettingsSchema>;

export const CardStyleSchema = z.object({
	cardColorStart: z.string(),
	cardColorEnd: z.string(),
	cardBasePlateColor: z.string(),
	cardBasePlateBorder: z.string(),
});
export type CardStyle = z.infer<typeof CardStyleSchema>;

export const CardStylePartialSchema = CardStyleSchema.partial();
export type CardStylePartial = z.infer<typeof CardStylePartialSchema>;

/** 默认全局值；resolve() 在 per-UP overrides 缺失字段时回退到这里。 */
export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
	dynamic: true,
	dynamicAtAll: false,
	live: true,
	liveAtAll: false,
	liveEnd: false,
	liveGuardBuy: false,
	superchat: false,
	wordcloud: false,
	liveSummary: false,
	specialDanmaku: false,
	specialUserEnter: false,
};

export const DEFAULT_CONTENT_FILTERS: ContentFilters = {
	blockForward: false,
	blockArticle: false,
	blockKeywords: [],
	blockRegex: [],
	whitelistKeywords: [],
	whitelistRegex: [],
	minScPrice: 0,
	minGuardLevel: 3,
};

export const DEFAULT_SCHEDULE: ScheduleConfig = {
	pushTime: 0,
	restartPush: false,
	quietHours: [],
};
