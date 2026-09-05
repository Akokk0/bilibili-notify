import { z } from "zod";
import { DEFAULT_TEMPLATES, FEATURE_KEYS, LIVE_END_EXTRA_KEYS } from "../constants";
import { checkUserRegex } from "../util/regex-safety";

export type { FeatureKey, LiveEndExtraKey, LiveEndExtras } from "../constants";

// 值与类型的单一来源在 ../constants(零依赖,供前端经 /constants 子路径运行时消费);
// 这里重导出维持根入口的既有 API 面,后端消费者无感。
import {
	AI_PROVIDER_IDS,
	API_FLAVOR_IDS,
	BUILTIN_AI_PRESETS,
	THINKING_LEVELS,
	WEB_SEARCH_BACKEND_IDS,
} from "../constants";

export { DEFAULT_FEATURE_FLAGS, FEATURE_KEYS, LIVE_END_EXTRA_KEYS } from "../constants";

/** blockRegex/whitelistRegex 的单元素校验:保存期即拦非法 / 超长 / 疑似 ReDoS 正则。 */
const UserRegexString = z.string().superRefine((src, ctx) => {
	const r = checkUserRegex(src);
	if (!r.ok) ctx.addIssue({ code: "custom", message: r.reason });
});

/** 全部可订阅的特性键(键列表本体在 ../constants)。 */
export const FeatureKeySchema = z.enum(FEATURE_KEYS);

/** 下播的两个附加项(词云 / AI 总结)。没有自己的路由,只跟着下播的开关与目标走。 */
export const LiveEndExtrasSchema = z.object({
	wordcloud: z.boolean(),
	liveSummary: z.boolean(),
});

/**
 * 老 features 的形状:词云 / 总结曾是两把独立的特性键(各有开关、各有路由),平铺在顶层。
 * 顶层还带着这两把键就是老数据 —— 新形状把它们收进 `liveEndExtras`,顶层不会再出现。
 */
function hasLegacyExtras(raw: object): raw is Record<string, unknown> {
	return LIVE_END_EXTRA_KEYS.some((k) => k in raw);
}

function pickExtras(raw: Record<string, unknown>): Record<string, unknown> {
	const extras: Record<string, unknown> = {};
	for (const k of LIVE_END_EXTRA_KEYS) if (k in raw) extras[k] = raw[k];
	return extras;
}

function stripLegacyExtras(raw: Record<string, unknown>): Record<string, unknown> {
	const { wordcloud: _w, liveSummary: _s, ...rest } = raw;
	return rest;
}

/**
 * 全局 features 的迁移:下播开关 = 旧下播 ∨ 词云 ∨ 总结,两个子项照旧值。
 *
 * 只开了词云 / 总结、没开下播的人,迁完会多收一张下播卡 —— 「宁可多收一张卡,不能少掉
 * 一条推送」,CHANGELOG 有 ⚠️ 说明。新形状(已有 `liveEndExtras`)一律不动:关掉下播、
 * 子项留着开,下次加载不会被翻回来。
 */
function migrateLegacyFeatureFlags(raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null || !hasLegacyExtras(raw)) return raw;
	const legacy = LIVE_END_EXTRA_KEYS.map((k) => raw[k]);
	return {
		...stripLegacyExtras(raw),
		liveEnd: raw.liveEnd === true || legacy.includes(true),
		liveEndExtras: pickExtras(raw),
	};
}

/**
 * per-UP 覆盖(partial)的迁移。覆盖是稀疏的,拿不到全局值,只能就地判:
 * - 三者有一个显式 true → `liveEnd: true`(不管全局怎样,这位 UP 以前一定收得到东西)
 * - 三者都显式 false → `liveEnd: false`(以前什么都收不到,现在也是)
 * - 其余(有的关、有的没写)→ 不写 liveEnd,继承全局。全局迁完只会更宽,顶多多收一张卡
 *
 * 单看一份 partial,只有 `{ liveEnd: false }` 分不出新老;整条订阅能看 routing 的形状,
 * 认出是老的就传 `force` 让这份覆盖也按老规矩迁(见 subscriptions.ts)。
 */
export function migrateLegacyFeatureFlagsPartial(raw: unknown, force = false): unknown {
	if (typeof raw !== "object" || raw === null) return raw;
	if (!force && !hasLegacyExtras(raw)) return raw;
	const r = raw as Record<string, unknown>;
	const trio = [r.liveEnd, ...LIVE_END_EXTRA_KEYS.map((k) => r[k])];
	const { liveEnd: _l, ...rest } = stripLegacyExtras(r);
	const out: Record<string, unknown> = { ...rest, liveEndExtras: pickExtras(r) };
	if (trio.includes(true)) out.liveEnd = true;
	else if (trio.every((v) => v === false)) out.liveEnd = false;
	return out;
}

const FeatureFlagsObjectSchema = z.object({
	dynamic: z.boolean(),
	live: z.boolean(),
	liveEnd: z.boolean(),
	liveGuardBuy: z.boolean(),
	superchat: z.boolean(),
	specialDanmaku: z.boolean(),
	specialUserEnter: z.boolean(),
	liveEndExtras: LiveEndExtrasSchema,
});

/**
 * 每个特性的开关 + 下播的两个附加项。使用显式 object 而非 z.record(boolean) 是为了让
 * inherit-merge 时类型保留键名。老形状(词云 / 总结平铺在顶层)在这里就地迁成新形状。
 */
export const FeatureFlagsSchema = z.preprocess(migrateLegacyFeatureFlags, FeatureFlagsObjectSchema);
export type FeatureFlags = z.infer<typeof FeatureFlagsObjectSchema>;

/**
 * per-UP 覆盖:七把开关各自可选,附加项是一个**内部也可选**的小对象 —— 只关词云不该顺手
 * 把总结也盖掉(resolve 对它做嵌套合并)。
 */
export const FeatureFlagsPartialSchema = z.preprocess(
	// 包一层:zod 给 preprocess 传的第二个参数是 ctx,直接传函数会把它当成 `force`。
	(raw) => migrateLegacyFeatureFlagsPartial(raw),
	FeatureFlagsObjectSchema.partial().extend({
		liveEndExtras: LiveEndExtrasSchema.partial().optional(),
	}),
);
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
	 * 动态推送文本模板(非视频动态)。变量:`{name}` UP 名;链接是消息版式的独立部件,
	 * 不是模板变量。`.default(...)` 让缺 dynamic 字段的老 globals.json
	 * (本字段加入前写入的)仍能通过 schema 校验 —— 与下方 imageGroup 同源的老配置兜底策略;
	 * 默认值直接取 `DEFAULT_TEMPLATES`,不另抄一份(抄的那份 2026-08 漂过一次)。
	 */
	dynamic: z.string().default(DEFAULT_TEMPLATES.dynamic),
	/** 视频投稿推送文本模板。变量:`{name}` UP 名;链接同上。 */
	dynamicVideo: z.string().default(DEFAULT_TEMPLATES.dynamicVideo),
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

/**
 * **一份服务商实例的整套配置。**
 *
 * 按**实例**各存一份(见 {@link AISettingsSchema} 的 `providers`),同一家服务商
 * 可以有多份实例(两个 DeepSeek 号、一个测试用的百炼)。换来换去不必把 key 重敲
 * 一遍,也不会出现「地址还是上一份的、模型名已经换了」这种半截状态。
 *
 * 除 `provider` 外全部字段带默认值:设置页新添一份时塞 `{ provider }` 即可,
 * 余下由 schema 补齐。`provider` 刻意**无默认**:桶键只是实例 id,方言归属认不出
 * 又没写明时(手改坏的数据)宁可拒收,也不猜一个、更不悄悄吞掉。
 */
export const AIProviderProfileSchema = z.object({
	/**
	 * 这桶配置属于哪家服务商 —— 决定「开思考」翻译成哪家的方言。上一代配置
	 * 以服务商名当桶键,迁移时按键名盖章(见 {@link AISettingsSchema} 的 preprocess)。
	 */
	provider: z.enum(AI_PROVIDER_IDS),
	/** 实例的显示名。空串 = 用注册表里那家的名字(不把家名抄进配置,免得改名过期)。 */
	label: z.string().default(""),
	apiKey: z.string().default(""),
	baseUrl: z.string().default(""),
	model: z.string().default(""),
	/**
	 * 这桶走哪套 wire 协议:`chat`(chat completions,现状)或 `responses`
	 * (OpenAI 2025 起的接任协议)。默认 `chat`,老配置零迁移;哪些家能选
	 * `responses` 由 providerMeta 的 `supportsResponses` 把门(设置页不露选项),
	 * schema 这层不掺和 —— 手改配置选了未确认的家,后果(404)自负且可逆。
	 */
	apiFlavor: z.enum(API_FLAVOR_IDS).default("chat"),
	/** chat.completions 的 temperature(0–2)。 */
	temperature: z.number().min(0).max(2).default(0.7),
	/**
	 * 开启模型的深度思考。具体发什么字段由**这个桶属于哪家**决定 ——
	 * 四家四种写法,没有通用解(见 `@bilibili-notify/ai#buildProviderParams`)。
	 *
	 * 注意:这个开关在修好 `extra_body` 那个 bug 之前**从未真正生效过**,
	 * 所以对老配置而言它是「第一次开始花钱」,别顺手改默认值。
	 */
	enableThinking: z.boolean().default(false),
	/**
	 * 思考深度,统一三档。等级枚举派(OpenRouter / DeepSeek)与 token 预算派
	 * (火山 / 硅基)各自映射 —— 统一档位是为了让这个设置在换家时不作废。
	 */
	thinkingLevel: z.enum(THINKING_LEVELS).default("medium"),
	/**
	 * 主人手写的一段 JSON,原样摊进**请求体顶层**。方言适配的兜底口:适配之外的
	 * 服务商、以及联网搜索这种分裂到没法统一的能力(OpenRouter 填 `plugins`、
	 * 硅基填 `enable_search`)都走这里。
	 *
	 * 这里只存字符串、不在 schema 里校验 JSON —— 设置页保存到一半的半截 JSON
	 * 不该让整份配置存不下去。真正的解析与危险键过滤在
	 * `@bilibili-notify/ai#parseExtraParams`,写错只影响这一次请求。
	 */
	extraParams: z.string().default(""),
	/**
	 * 把图**直接下挂给主模型**。它声明的是「这家的主模型自己看不看得见图」,
	 * 不是「把图发给谁」 —— 所以按家存:gpt-4o 是,DeepSeek 永远否。
	 *
	 * 与下面的 {@link vision} 是两条独立的路:配了副模型就走副模型(它优先),
	 * 两条都没开时发图会被明确拒绝,而不是静默丢掉。
	 */
	enableVision: z.boolean().default(false),
	/**
	 * 专门看图的副模型。填了 `model` 即启用:此后动态里的图先经它转成文字,
	 * 主模型全程只吃纯文本。
	 *
	 * 为的是 DeepSeek 这类**根本没有视觉模型**的主力(官方 API 里一个都没有),
	 * 所以副模型必然可能在另一家 —— baseUrl / apiKey 才要单独开口。两者留空
	 * 则继承同桶主模型的。默认全空 = 不启用。
	 */
	vision: z
		.object({
			baseUrl: z.string().default(""),
			apiKey: z.string().default(""),
			model: z.string().default(""),
		})
		.default({ baseUrl: "", apiKey: "", model: "" }),
});
export type AIProviderProfile = z.infer<typeof AIProviderProfileSchema>;

/** AI 总配置（在 GlobalConfig.defaults.ai 出现）。 */
const AISettingsObjectSchema = z.object({
	enabled: z.boolean(),
	persona: AIPersonaSchema,
	dynamicPrompt: z.string(),
	liveSummaryPrompt: z.string(),
	/**
	 * 当前用哪份实例(指向 {@link providers} 的键)。**只认主人明确选过的那一份,
	 * 绝不按 baseUrl 猜** —— 猜错就是替主人往别家发方言参数(几乎必然 400)。
	 * 与人格的 `activePreset` 同一套指针语义;上一代的 `provider` 字段迁移时改名至此。
	 */
	activeProfile: z.string().default(""),
	/**
	 * 各实例各一套配置,键是**实例 id**(同一家服务商可以有多份)。**稀疏** ——
	 * 键存在 = 主人添加过这份,不存在 = 还没添加。设置页左栏据此只列已添加的那几块。
	 *
	 * 上一代「一家一桶」的配置,桶键就是服务商名;迁移时**键名原样保留**(密钥
	 * 加密袋的袋键 = 桶键,搬键名等于重启后密钥对不上号),只按键名往桶里盖
	 * `provider` 章。
	 *
	 * {@link activeProfile} 指向的桶**可能不存在**(比如刚被删掉),取值一律经
	 * {@link resolveAIProfile},它会兜一套空默认值回来。
	 */
	providers: z.record(z.string(), AIProviderProfileSchema).default({}),
	/**
	 * AI 聊天页自己的思考**等级**,独立于实例桶里的那两格 —— 那两格是引擎的
	 * (动态点评 / 直播总结 / 锐评),聊天页曾经直接改它,于是在对话里拨一下,
	 * 整个女仆的点评行为跟着变。
	 *
	 * 字段是 optional 的「没写 = 跟随当前实例」:调过一次就写实,此后两边互不
	 * 牵动。取值一律经 `resolveChatThinkingLevel`。
	 *
	 * 这里**没有开关**:聊天的思考开关是会话级的(输入框旁那颗胶囊,默认关、
	 * 手动开、不落盘),按消息走请求体。曾经有过一格 `enableThinking`,未发版
	 * 即删 —— 老数据里若残留,zod 会静默剥掉。
	 */
	chat: z
		.object({
			thinkingLevel: z.enum(THINKING_LEVELS).optional(),
		})
		.default({}),
	/**
	 * 联网搜索(`web_search` 工具)的配置。与选哪家 AI 服务商**正交**:搜索不走
	 * 各家 LLM 的原生联网方言,由这里选定的后端真正执行,所以任何支持 function
	 * calling 的服务商都能联网。
	 *
	 * key 按后端**各存一格**:换后端不丢另一家的 key(对齐实例桶「换来换去不必
	 * 重敲 key」的纪律)。落盘前会被抠进加密袋,袋键 `search:<backend>`,见
	 * `apps/server/src/config/ai-secrets.ts`。
	 *
	 * `engines` 三个开关**默认全关**:搜索按次付费,自动路径(点评/总结)一旦
	 * 开了,每条推送都可能烧额度,必须主人亲手点亮。聊天页不在此列 —— 那颗
	 * 胶囊是会话级的,不落盘。
	 */
	search: z
		.object({
			backend: z.enum(WEB_SEARCH_BACKEND_IDS).default("bocha"),
			keys: z
				.object({
					bocha: z.string().default(""),
					tavily: z.string().default(""),
				})
				.default({ bocha: "", tavily: "" }),
			engines: z
				.object({
					dynamic: z.boolean().default(false),
					live: z.boolean().default(false),
					roast: z.boolean().default(false),
				})
				.default({ dynamic: false, live: false, roast: false }),
		})
		.default({
			backend: "bocha",
			keys: { bocha: "", tavily: "" },
			engines: { dynamic: false, live: false, roast: false },
		}),
	/**
	 * 全局此刻启用哪一份人格。**不填 = 用 `persona`**(老配置一字不变,无需迁移);
	 * 填了就用 `presets` 里那一份。
	 *
	 * 它是个**指针**而不是「把预设复制进 `persona`」—— 后者一下就把主人手写的那份
	 * 覆盖了且换不回来,而且想显示「现在选的是哪份」还得拿 persona 去逐字段比对猜。
	 * 指向一份已不存在的预设时(刚删掉 / 备份换了一批)静静回落 `persona`。
	 *
	 * per-UP 的 `overrides.ai.preset` 语义**完全不受影响**:它照旧压过全局,
	 * 而没设 per-UP 覆盖时继承的就是这里指定的那一份。
	 */
	activePreset: z.string().optional(),
	/**
	 * 备着的人格清单。**恒非空** —— 空数组会被补齐成内置那几份
	 * (见 `ai-persona-pointer.test.ts`),所以设置页不必为「一份都没有」留分支。
	 *
	 * per-UP 的 `overrides.ai.preset` 指的就是这里的 `id`(详见 `AIOverrideSchema`)。
	 */
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

/** 上一版的扁平连接字段。读老配置时整份搬进 `providers.custom`。 */
const LEGACY_FLAT_KEYS = [
	"apiKey",
	"baseUrl",
	"model",
	"temperature",
	"enableThinking",
	"thinkingLevel",
	"extraParams",
	"enableVision",
	"vision",
] as const;

/**
 * 老配置迁移:一套扁平的连接字段 → `providers.custom`,并选中 `custom`。
 *
 * 落 `custom` 而不是按 baseUrl 认出那一家,是刻意的:兜底档不发任何方言参数,
 * 等价于分家这套东西上线之前的行为 —— **升级零行为变化**,也不必替主人猜。
 * 想用上思考功能的主人,自己去设置页添加那一家。
 *
 * 判据是「有没有 `providers` 键」而不是「有没有 apiKey」:后者会把一份还没填过
 * key 的新配置也当成老配置,平白造出一个空的 custom 桶,左栏就凭空多一块。
 */
export const AISettingsSchema = z.preprocess((raw) => {
	if (raw === null || typeof raw !== "object") return raw;
	return migratePersonaPointer(
		migrateProviderInstances(migrateFlatProviderFields(raw as Record<string, unknown>)),
	);
}, AISettingsObjectSchema);

function migrateFlatProviderFields(o: Record<string, unknown>): Record<string, unknown> {
	if (o.providers !== undefined) return o;

	const legacy: Record<string, unknown> = {};
	const rest: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(o)) {
		if ((LEGACY_FLAT_KEYS as readonly string[]).includes(k)) legacy[k] = v;
		else rest[k] = v;
	}
	// 一个字段都没有的话不造桶 —— 那是一份全新配置,左栏该是空的。
	if (Object.keys(legacy).length === 0) return { ...rest, providers: {} };
	return { ...rest, provider: "custom", providers: { custom: legacy } };
}

/**
 * 上一代「一家一桶」→ 当代「实例桶」:
 *
 * - 指针改名:`provider` → `activeProfile`(值原样 —— 老指针指的服务商名恰好
 *   就是迁移后那只桶的实例 id)。
 * - 桶盖章:键是认得的服务商名、桶里又没写 `provider` 的,按键名补上。键名
 *   **原样保留**:密钥加密袋的袋键就是桶键,搬键名等于重启后密钥对不上号。
 *
 * 认不出的键(不是服务商名、桶里也没写 provider)**不盖章**,留给 schema 拒收
 * —— 那是手改坏的数据,猜一个方言归属比报错更糟。
 */
function migrateProviderInstances(o: Record<string, unknown>): Record<string, unknown> {
	const out = { ...o };
	if (out.activeProfile === undefined && typeof out.provider === "string") {
		out.activeProfile = out.provider;
	}
	delete out.provider;

	const providers = out.providers;
	if (providers !== null && typeof providers === "object" && !Array.isArray(providers)) {
		const next: Record<string, unknown> = { ...(providers as Record<string, unknown>) };
		for (const [key, bucket] of Object.entries(next)) {
			if (
				bucket !== null &&
				typeof bucket === "object" &&
				!Array.isArray(bucket) &&
				(bucket as Record<string, unknown>).provider === undefined &&
				(AI_PROVIDER_IDS as readonly string[]).includes(key)
			) {
				next[key] = { ...bucket, provider: key };
			}
		}
		out.providers = next;
	}
	return out;
}

/** 结构比较用。schema 全是纯数据,键序由 zod 定死,`JSON.stringify` 足够可靠。 */
function sameShape(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 人格只住在 `presets[]` 里,`activePreset` 指着当前那一份。
 *
 * `DEFAULT_AI.persona` 与 `presets[0]`「温柔女仆」本就是同一份(见 globals.ts 那句
 * 「默认配置 = 首个预设,单一真相」),所以设置页里再摆一个「默认」项是**重复** ——
 * 同一份东西两个入口,还得解释哪个才算数。删掉它之后就必须回答:**手改过
 * `ai.persona` 的老配置怎么办?** 不管的话那份人格数据还在盘上、界面上却再也点不到。
 *
 *   ① 已经有指针 → 不动(迁移只跑一次)
 *   ② `persona` 与某份预设逐字段相同 → 指向它,不造重复项
 *   ③ `persona` 是手改过的 → 造一份预设装着它并指过去,一个字都不丢
 *
 * 顺带守住一条不变量:`presets` 恒非空、`activePreset` 恒指向真实存在的项 ——
 * 「当前这份人格」永远有着落,消费方不必各自兜底。
 *
 * `ai.persona` 本身留着不删:它是 `resolve()` 在指针万一落空时的安全网,也让老版本
 * 读同一份配置文件时行为不变。界面上不再有任何入口编辑它。
 */
function migratePersonaPointer(o: Record<string, unknown>): Record<string, unknown> {
	const stored = Array.isArray(o.presets) ? (o.presets as Record<string, unknown>[]) : [];
	// `presets: []` 是预设功能上线**之前**写的 globals.json。这里补齐内置四份 ——
	// 而不是只拿 persona 派生一份出来:那样老用户会平白少掉三份内置人格。
	// (此前这件事由 ConfigStore 在加载后做,条件是 `presets.length === 0`;
	// 现在这道迁移必然把列表填成非空,那个条件再也不成立,所以责任移到这里。)
	const presets: Record<string, unknown>[] =
		stored.length > 0
			? [...stored]
			: (BUILTIN_AI_PRESETS as readonly unknown[]).map((p) => ({ ...(p as object) }));
	const persona = o.persona;

	if (typeof o.activePreset === "string") {
		// 指针已在。只兜一种坏情况:它指着一份不存在的预设(手改配置 / 备份换了一批)。
		if (presets.some((p) => p?.id === o.activePreset)) return o;
		if (presets.length > 0) return { ...o, activePreset: presets[0]?.id };
	}

	const matched = presets.find((p) => sameShape(p?.persona, persona));
	if (matched) return { ...o, presets, activePreset: matched.id };

	// 走到这里:persona 是手改过的(或 presets 干脆是空的)。给它造一份带得走的家。
	const name = (persona as { name?: unknown } | undefined)?.name;
	const label = typeof name === "string" && name.trim() ? name.trim() : "我的性格";
	const taken = new Set(presets.map((p) => p?.id));
	let id = "custom-persona";
	for (let n = 2; taken.has(id); n += 1) id = `custom-persona-${n}`;
	const mine: Record<string, unknown> = { id, label, persona };
	if (typeof o.dynamicPrompt === "string" && o.dynamicPrompt) mine.dynamicPrompt = o.dynamicPrompt;
	if (typeof o.liveSummaryPrompt === "string" && o.liveSummaryPrompt) {
		mine.liveSummaryPrompt = o.liveSummaryPrompt;
	}
	return { ...o, presets: [...presets, mine], activePreset: id };
}
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
	 * 字体家族名。`packages/image` 的 `renderCard` 在它后面追加
	 * `"Microsoft YaHei","Source Han Sans","Noto Sans CJK",sans-serif` 兜底链,
	 * 缺字体不会渲染崩。`.default(...)` 让缺该字段的老 globals.json 加载时自动补全。
	 *
	 * 独立端的设置页已改成**字体选择器**,交出来的是单个家族名(空串 = 只走兜底链);
	 * 逗号列表只会来自老配置与「手填(高级)」那一档,`cssFontFamily` 会逐项处理。
	 * 想用主人自己的字体文件走下面的 `fontAsset`,它优先。
	 */
	font: z.string().default("PingFang SC, sans-serif"),
	/**
	 * 主人上传的字体文件资产 id(与卡片背景图同一套「落盘 + id 引用 +
	 * 渲染期解析成 data URL」形态)。
	 *
	 * 设了就**优先于 `font`**:渲染期由服务端读盘拼成 `@font-face` 内联给模版。指向一个
	 * 已被删掉的资产时静静回落 `font` —— 与背景图同一条纪律,不让一次删除把出图弄崩。
	 */
	fontAsset: z.string().optional(),
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
