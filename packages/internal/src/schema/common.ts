import { z } from "zod";
import { checkUserRegex } from "../util/regex-safety";

/** blockRegex/whitelistRegex 的单元素校验:保存期即拦非法 / 超长 / 疑似 ReDoS 正则。 */
const UserRegexString = z.string().superRefine((src, ctx) => {
	const r = checkUserRegex(src);
	if (!r.ok) ctx.addIssue({ code: "custom", message: r.reason });
});

/** 全部可订阅的特性键。新增或删除会扩散到 FeatureFlags、SubscriptionRouting、Subscription.overrides。 */
export const FeatureKeySchema = z.enum([
	"dynamic",
	"live",
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
	live: z.boolean(),
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

/**
 * 一个时段范围，半开区间 `[start, end)`，单位：小时。
 * `start` ∈ 0..23；`end` ∈ 0..24（`end=24` 表示到次日 0 点）。
 * `{start:0, end:24}` 即「全天免打扰」——此前 `end.max(23)` 与 refine 报错文案
 * 自相矛盾(文案说用 0..24,schema 却不收 24),全天语义根本无法表达。
 */
export const TimeRangeSchema = z
	.object({
		start: z.number().int().min(0).max(23),
		end: z.number().int().min(0).max(24),
	})
	.refine((r) => r.start !== r.end, "start must differ from end (use {start:0,end:24} 表示全天)");
export type TimeRange = z.infer<typeof TimeRangeSchema>;

/** B 站舰长等级语义沿用，1=总督 / 2=提督 / 3=舰长。 */
export const GuardLevelSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type GuardLevel = z.infer<typeof GuardLevelSchema>;

export const ContentFiltersSchema = z.object({
	blockForward: z.boolean(),
	blockArticle: z.boolean(),
	blockKeywords: z.array(z.string()),
	blockRegex: z.array(UserRegexString),
	whitelistKeywords: z.array(z.string()),
	whitelistRegex: z.array(UserRegexString),
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
	/**
	 * 是否启用自定义上舰文案/图片。`false` 时引擎走 builtin 路径(默认上舰图 + 简单提示)。
	 * `true` 时使用 captain/commander/governor 三档的自定义 template + imageUrl。默认 false。
	 */
	enable: z.boolean().default(false),
	captain: GuardEntrySchema,
	commander: GuardEntrySchema,
	governor: GuardEntrySchema,
});
export type GuardBundle = z.infer<typeof GuardBundleSchema>;

export const TemplateBundleSchema = z.object({
	liveStart: z.string(),
	liveOngoing: z.string(),
	liveEnd: z.string(),
	/**
	 * 是否启用自定义直播消息模板(开播/直播中/下播)。`false` 时走 builtin 简短文案。
	 * `true` 时使用 liveStart / liveOngoing / liveEnd 三段。默认 false。
	 */
	liveMsgEnabled: z.boolean().default(false),
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
	/** 基础角色描述,用于 system prompt 起手段。默认空(老数据迁移友好)。 */
	baseRole: z.string().default(""),
	/** 追加到 system prompt 末尾的额外指令,用于微调 AI 行为(指代偏好、安全约束等)。 */
	extraSystemPrompt: z.string().default(""),
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
	/**
	 * 卡片图片渲染功能总开关。关闭后,push 流程会跳过图片生成,仅发送文本回退。
	 * 默认 true 以兼容老数据文件;独立端的 puppeteer 适配器仍按 `bootstrap.chromePath`
	 * 是否注入决定能不能渲染,这个 flag 是 *用户意图* 层。
	 */
	enabled: z.boolean().default(true),
	cardColorStart: z.string(),
	cardColorEnd: z.string(),
});
export type CardStyle = z.infer<typeof CardStyleSchema>;

export const CardStylePartialSchema = CardStyleSchema.partial();
export type CardStylePartial = z.infer<typeof CardStylePartialSchema>;

/** 默认全局值；resolve() 在 per-UP overrides 缺失字段时回退到这里。 */
export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
	dynamic: true,
	live: true,
	liveEnd: true,
	liveGuardBuy: false,
	superchat: false,
	wordcloud: true,
	liveSummary: true,
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

/**
 * DYNAMIC_TYPE_DRAW 图集图片推送行为。`enable` 决定是否在文本/卡片之后附加一组
 * 原图;`forward` 在 `enable=true` 时决定走「合并转发卡片」还是「普通多图」(单图
 * 永远不走合并转发)。两个字段都可 per-UP 覆盖。`forward=true` 在 NapCat 等 OneBot
 * 实现走长消息通道(SsoSendLongMsg),部分部署不稳。
 */
export const ImageGroupSettingsSchema = z.object({
	enable: z.boolean(),
	forward: z.boolean(),
});
export type ImageGroupSettings = z.infer<typeof ImageGroupSettingsSchema>;

export const ImageGroupSettingsPartialSchema = ImageGroupSettingsSchema.partial();
export type ImageGroupSettingsPartial = z.infer<typeof ImageGroupSettingsPartialSchema>;

export const DEFAULT_IMAGE_GROUP: ImageGroupSettings = {
	enable: true,
	forward: false,
};
