import { z } from "zod";
import { FEATURE_KEYS } from "../constants";
import { checkUserRegex } from "../util/regex-safety";

export type { FeatureKey } from "../constants";
// 值与类型的单一来源在 ../constants(零依赖,供前端经 /constants 子路径运行时消费);
// 这里重导出维持根入口的既有 API 面,后端消费者无感。
export { DEFAULT_FEATURE_FLAGS, FEATURE_KEYS } from "../constants";

/** blockRegex/whitelistRegex 的单元素校验:保存期即拦非法 / 超长 / 疑似 ReDoS 正则。 */
const UserRegexString = z.string().superRefine((src, ctx) => {
	const r = checkUserRegex(src);
	if (!r.ok) ctx.addIssue({ code: "custom", message: r.reason });
});

/** 全部可订阅的特性键(键列表本体在 ../constants)。 */
export const FeatureKeySchema = z.enum(FEATURE_KEYS);

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
	// blockDraw / blockAv 是后期新增字段。.default(false) 让旧 globals.json
	// 缺该字段时 zod parse 自动补 false,避免独立端启动 safeParse 失败 throw。
	blockDraw: z.boolean().default(false),
	blockAv: z.boolean().default(false),
	blockKeywords: z.array(z.string()),
	blockRegex: z.array(UserRegexString),
	whitelistKeywords: z.array(z.string()),
	whitelistRegex: z.array(UserRegexString),
	minScPrice: z.number().int().min(0),
	minGuardLevel: GuardLevelSchema,
});
export type ContentFilters = z.infer<typeof ContentFiltersSchema>;

// `.partial()` 只把字段变可选,**不剥离 `.default()`**(与 TemplateBundlePartialSchema 同源问题):
// per-UP 只覆盖直播阈值域(minScPrice/minGuardLevel)时,parse 会把带 default 的 blockDraw/blockAv
// 注入成 false,而这俩是「动态过滤」域字段 → 前端据「字段 !== undefined」误判该 UP 已覆盖动态过滤
// (isSectionCustomized / FilterOverrideBox 的 toggle),表现为「一开直播阈值就连带点亮动态过滤」。
// override 维度的 blockDraw/blockAv 必须是「无默认的纯可选」,与全局 ContentFiltersSchema(带
// .default 供 globals.json 缺字段回填)分开。
export const ContentFiltersPartialSchema = ContentFiltersSchema.partial().extend({
	blockDraw: z.boolean().optional(),
	blockAv: z.boolean().optional(),
});
export type ContentFiltersPartial = z.infer<typeof ContentFiltersPartialSchema>;

export const ScheduleConfigSchema = z.object({
	pushTime: z.number().int().min(0).max(24),
	restartPush: z.boolean(),
	quietHours: z.array(TimeRangeSchema),
	/**
	 * 断流接续:开启后,UP 下播不立刻通知,先等 `liveEndGraceMinutes` 分钟。期间若重新
	 * 开播,则判定为网络抖动 / 超管掐流,接续为同一场直播(不发下播、也不重发开播,弹幕 /
	 * 时长 / 粉丝变化全沿用第一次开播基线);等待超时仍未重开才判定真下播并推送。
	 * `.default(false)` 兼容缺该字段的老 globals.json。
	 */
	liveEndGrace: z.boolean().default(false),
	/** 断流接续等待时长(分钟,1–10,默认 2)。仅 `liveEndGrace=true` 时生效。 */
	liveEndGraceMinutes: z.number().int().min(1).max(10).default(2),
});
export type ScheduleConfig = z.infer<typeof ScheduleConfigSchema>;

// 同 ContentFiltersPartialSchema:`.partial()` 不剥 `.default()`,per-UP 只覆盖 pushTime 等
// 字段时会被注入 liveEndGrace:false / liveEndGraceMinutes:2。schedule 整段归「直播阈值」section
// 独占,注入默认值虽不跨 section 污染,但会让 override 落盘多出用户没设的字段、并在 resolve merge
// 时强制盖掉全局对应值。override 维度须为无默认纯可选,与全局 ScheduleConfigSchema 分开。
export const ScheduleConfigPartialSchema = ScheduleConfigSchema.partial().extend({
	liveEndGrace: z.boolean().optional(),
	liveEndGraceMinutes: z.number().int().min(1).max(10).optional(),
});
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
	liveSummary: z.string(),
	/**
	 * 动态推送文本模板(非视频动态)。变量:`{name}` UP 名、`{url}` 动态链接。
	 * `.default(...)` 让缺 dynamic 字段的老 globals.json(本字段加入前写入的)
	 * 仍能通过 schema 校验 —— 与下方 imageGroup 同源的老配置兜底策略。默认值须与
	 * `DEFAULT_TEMPLATES.dynamic` 保持一致。
	 */
	dynamic: z.string().default("{name}发布了一条动态：{url}"),
	/** 视频投稿推送文本模板。变量:`{name}` UP 名、`{url}` 视频链接 / BV。默认值须与 `DEFAULT_TEMPLATES.dynamicVideo` 一致。 */
	dynamicVideo: z.string().default("{name}发布了新视频：{url}"),
	/**
	 * 弹幕词云的额外停用词,英文逗号分隔,**追加**到内置中文停用词表后再分词。
	 * `.default("")` 让缺该字段的老 globals.json 仍能通过 schema 校验(与 dynamic /
	 * dynamicVideo 同源的老配置兜底)。per-UP override 经 merge 替换全局值,在该 UP
	 * 的词云生成时额外过滤(详见 packages/live room-session dispatch)。
	 */
	wordcloudStopWords: z.string().default(""),
	specialDanmaku: z.string(),
	specialUserEnter: z.string(),
	guardBuy: GuardBundleSchema,
});
export type TemplateBundle = z.infer<typeof TemplateBundleSchema>;

// `.partial()` 只把顶层字段变可选,**不剥离内层 `.default()`** —— 直接 partial 会让
// per-UP override 解析 `{ templates: { liveSummary } }` 时把 dynamic/dynamicVideo
// 注入成默认值,被下游(buildDynamicSubViewSingle / isSectionCustomized)误当成真有
// per-UP 动态模板覆盖:该 UP 停止跟随全局动态模板热更、面板误标「已定制」、保存时
// 把注入字段落盘。override 维度的 dynamic/dynamicVideo 必须是「无默认的纯可选」,
// 与全局 TemplateBundleSchema(带 .default 供 globals.json 缺字段回填)分开。
export const TemplateBundlePartialSchema = TemplateBundleSchema.partial().extend({
	dynamic: z.string().optional(),
	dynamicVideo: z.string().optional(),
	wordcloudStopWords: z.string().optional(),
});
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

const CardStyleObjectSchema = z.object({
	/**
	 * 卡片图片渲染功能总开关。关闭后,push 流程会跳过图片生成,仅发送文本回退。
	 * 默认 true 以兼容老数据文件;独立端的 puppeteer 适配器仍按 `bootstrap.chromePath`
	 * 是否注入决定能不能渲染,这个 flag 是 *用户意图* 层。
	 */
	enabled: z.boolean().default(true),
	cardColorStart: z.string(),
	cardColorEnd: z.string(),
	/**
	 * CSS font-family。`packages/image/styles.cssReset` 在用户值后面追加
	 * `"Microsoft YaHei","Source Han Sans","Noto Sans CJK",sans-serif` 兜底链,
	 * 缺字体不会渲染崩。`.default(...)` 让缺该字段的老 globals.json 加载时自动补全。
	 */
	font: z.string().default("PingFang SC, sans-serif"),
	/**
	 * 直播卡「数据区」各项显示开关(仅直播卡用;其它卡类型忽略)。数据区由原 `stats`(人气·
	 * 点赞 + 分区)与 `follower`(粉丝数据)两块合并而来,这三个开关控制其内部具体显示哪几项。
	 * 默认全开 = 复刻现状。简介(desc)显隐已交由版式 desc 块的 visible,故移除旧 `hideDesc`。
	 */
	/** 数据区:显示人气 / 点赞(直播中=人气,下播=点赞)。 */
	showPopularity: z.boolean().default(true),
	/** 数据区:显示分区。 */
	showArea: z.boolean().default(true),
	/** 数据区:显示粉丝数据(直播中=当前粉丝数,下播=累计观看人数,下播态=粉丝数变化)。 */
	showFans: z.boolean().default(true),
	/**
	 * 自定义卡片背景图资产 id **列表**。空列表(默认)= 沿用 `cardColorStart→cardColorEnd`
	 * 渐变;长度 1 = 固定单张;长度 >1 = 每次推送顺序轮换(游标在服务端持久)。渲染期由
	 * 服务端从列表里挑一张解析成 data URL 内联(packages/image 仍只认单图)。旧的单值
	 * `backgroundImage` 经下方 preprocess 自动迁移成本列表。
	 */
	backgroundImages: z.array(z.string()).default([]),
	/**
	 * 直播卡自定义封面图资产 id **列表**(独立端专属,复用卡片背景同一图廊)。空列表
	 * (默认)= 沿用 B 站房间封面 / 关键帧;长度 1 = 固定单张;长度 >1 = 每次推送顺序
	 * 轮换(游标与背景图同一 rotator,key 维度独立)。仅对 live 卡有意义,其余卡忽略。
	 */
	liveCoverImages: z.array(z.string()).default([]),
	/**
	 * 玻璃片(卡片内容层)透明度,0..1。**可选**:未设(默认)时各卡沿用各自内置基线
	 * (live/dynamic 0.82、sc/guard 0.75),保证「默认复刻现状」;设了值才统一覆盖所有卡。
	 * 0 = 透明但仍带磨砂模糊;「完全透明无模糊」走 `glassClear`(与本字段二选一)。
	 */
	glassOpacity: z.number().min(0).max(1).optional(),
	/**
	 * 完全透明:内容层透明 + **去掉毛玻璃模糊**,底图完全清晰透出。与 `glassOpacity` 二选一
	 * (UI 互斥);为 true 时优先,glassOpacity 被忽略。默认 false(复刻现状)。
	 */
	glassClear: z.boolean().default(false),
});

/**
 * 前向迁移 CardStyle:
 * 1. 旧单值 `backgroundImage`(string)→ 新 `backgroundImages`(string[]):仅当未显式提供
 *    列表时生效,空串→空列表(渐变),非空→单元素列表;显式列表永远优先。
 * 2. 旧 `hideFollower=true`(隐藏粉丝数据)→ 新 `showFans=false`:仅当未显式提供 `showFans`
 *    时生效,保留老用户「已隐藏粉丝数据」的意图。
 * 3. 丢弃废弃的 `hideDesc` / `hideFollower`:简介显隐改由版式 desc 块的 visible 控制,
 *    粉丝数据并入数据区 `showFans` 开关。
 */
function migrateCardStyle(raw: unknown): unknown {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
	const o: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
	if ("backgroundImage" in o) {
		const legacy = o.backgroundImage;
		delete o.backgroundImage;
		if (o.backgroundImages === undefined) {
			o.backgroundImages = typeof legacy === "string" && legacy ? [legacy] : [];
		}
	}
	if (o.hideFollower === true && o.showFans === undefined) o.showFans = false;
	delete o.hideDesc;
	delete o.hideFollower;
	return o;
}

export const CardStyleSchema = z.preprocess(migrateCardStyle, CardStyleObjectSchema);
export type CardStyle = z.infer<typeof CardStyleSchema>;

// `.partial()` 只把字段变可选,**不剥离内层 `.default()`**(与 ContentFilters /
// ScheduleConfig / TemplateBundle 三个 PartialSchema 同源问题):CardStyleObjectSchema
// 有 8 个带 default 的字段,per-UP 只覆盖一个字段(如 cardColorStart)时,partial 会把
// enabled:true / font / showPopularity / showArea / showFans / backgroundImages:[] /
// liveCoverImages:[] / glassClear:false 一并注入。resolve() 的 merge(defaults.cardStyle, ov.cardStyle) 视其
// 为「已覆盖」而盖掉全局自定义值 —— 最严重:全局 enabled=false(关图片渲染)被注入的
// true 悄悄翻开。故这 7 个在 override 维度必须是「无默认的纯可选」,与全局
// CardStyleObjectSchema(带 .default 供 globals.json 缺字段回填)分开。
export const CardStylePartialSchema = z.preprocess(
	migrateCardStyle,
	CardStyleObjectSchema.partial().extend({
		enabled: z.boolean().optional(),
		font: z.string().optional(),
		showPopularity: z.boolean().optional(),
		showArea: z.boolean().optional(),
		showFans: z.boolean().optional(),
		backgroundImages: z.array(z.string()).optional(),
		liveCoverImages: z.array(z.string()).optional(),
		glassClear: z.boolean().optional(),
	}),
);
export type CardStylePartial = z.infer<typeof CardStylePartialSchema>;

/** 卡片类型 —— 按类型分别配置样式 / 背景;键对齐 CardLayout 的 live/dynamic/sc/guard。 */
export const CardKindSchema = z.enum(["live", "dynamic", "sc", "guard"]);
export type CardKind = z.infer<typeof CardKindSchema>;

/**
 * 按卡片类型的样式覆盖:每个类型一份可选 `CardStylePartial`,叠在基准 `cardStyle` 之上
 * (字段级 merge)。缺某类型 = 该类型跟随基准。全局默认与 per-UP 覆盖各持一份,生效优先级
 * 由高到低:UP·类型 > UP·基准 > 全局·类型 > 全局·基准(见 `resolveCardStyleForKind`)。
 */
export const CardStyleByKindSchema = z.object({
	live: CardStylePartialSchema.optional(),
	dynamic: CardStylePartialSchema.optional(),
	sc: CardStylePartialSchema.optional(),
	guard: CardStylePartialSchema.optional(),
});
export type CardStyleByKind = z.infer<typeof CardStyleByKindSchema>;

export const DEFAULT_CONTENT_FILTERS: ContentFilters = {
	blockForward: false,
	blockArticle: false,
	blockDraw: false,
	blockAv: false,
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
	liveEndGrace: false,
	liveEndGraceMinutes: 2,
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
