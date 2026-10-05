import { z } from "zod";
import { DEFAULT_TEMPLATES, extrasRecord, FEATURE_KEYS, featuresRecord } from "../constants";
import { checkUserRegex } from "../util/regex-safety";

export type { ExtraKey, FeatureKey, PushExtras } from "../constants";

// 值与类型的单一来源在 ../constants(零依赖,供前端经 /constants 子路径运行时消费);
// 这里重导出维持根入口的既有 API 面,后端消费者无感。
import {
	AI_PROVIDER_IDS,
	API_FLAVOR_IDS,
	THINKING_LEVELS,
	WEB_SEARCH_BACKEND_IDS,
} from "../constants";

export { DEFAULT_FEATURE_FLAGS, EXTRA_KEYS, FEATURE_KEYS, PUSH_EXTRAS } from "../constants";

/** blockRegex/allowRegex 的单元素校验:保存期即拦非法 / 超长 / 疑似 ReDoS 正则。 */
const UserRegexString = z.string().superRefine((src, ctx) => {
	const r = checkUserRegex(src);
	if (!r.ok) ctx.addIssue({ code: "custom", message: r.reason });
});

/** 全部可订阅的特性键(键列表本体在 ../constants)。 */
export const FeatureKeySchema = z.enum(FEATURE_KEYS);

/**
 * 四把附加项的开关(ADR-0016)。键表与出厂值的本体在 `../constants` 的 `PUSH_EXTRAS` ——
 * 这里只把它翻成 schema,加一把附加项不用改这儿。
 *
 * 四把都必填:这是**全局**那一层。per-UP 覆盖用它的 `.partial()`(见下面的
 * `FeatureFlagsPartialSchema`)—— 那一层缺席才有「继承上一层」的意思,所以单键**不给
 * 默认值**:给了的话 `.partial()` 出来的覆盖会被填满,把全局值一并盖掉。
 */
export const PushExtrasSchema = z.object(extrasRecord(() => z.boolean()));

const FeatureFlagsObjectSchema = z.object({
	...featuresRecord(() => z.boolean()),
	extras: PushExtrasSchema,
});

/**
 * 每个特性的开关 + 四个附加项。使用显式 object 而非 z.record(boolean) 是为了让
 * inherit-merge 时类型保留键名。0.x 附加项的两代老形状由迁移器改写(`apps/server/src/migration/features.ts`)。
 */
export const FeatureFlagsSchema = FeatureFlagsObjectSchema;
export type FeatureFlags = z.infer<typeof FeatureFlagsObjectSchema>;

/**
 * per-UP 覆盖:七把开关各自可选,附加项是一个**内部也可选**的小对象 —— 只关词云不该顺手
 * 把总结也盖掉(resolve 对它做嵌套合并)。
 */
export const FeatureFlagsPartialSchema = FeatureFlagsObjectSchema.partial().extend({
	extras: PushExtrasSchema.partial().optional(),
});
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

export const ContentFiltersSchema = z.object({
	blockReposts: z.boolean(),
	blockArticles: z.boolean(),
	// blockImages / blockVideos 是后期新增字段。.default(false) 让旧 globals.json
	// 缺该字段时 zod parse 自动补 false,避免独立端启动 safeParse 失败 throw。
	blockImages: z.boolean().default(false),
	blockVideos: z.boolean().default(false),
	blockKeywords: z.array(z.string()),
	blockRegex: z.array(UserRegexString),
	allowKeywords: z.array(z.string()),
	allowRegex: z.array(UserRegexString),
});
export type ContentFilters = z.infer<typeof ContentFiltersSchema>;

// `.partial()` 只把字段变可选,**不剥离 `.default()`**(与 TemplateBundlePartialSchema 同源问题):
// per-UP 只覆盖一两个别的字段(早先是直播阈值域的 minScPrice/minGuardLevel,㉓d 起它们搬去了 superchat / membership
// 两段)时,parse 会把带 default 的 blockImages/blockVideos 注入成 false → 前端据「字段 !== undefined」误判该 UP
// 已覆盖动态过滤(isSectionCustomized / FilterOverrideBox 的 toggle)。
// override 维度的 blockImages/blockVideos 必须是「无默认的纯可选」,与全局 ContentFiltersSchema(带
// .default 供 globals.json 缺字段回填)分开。
export const ContentFiltersPartialSchema = ContentFiltersSchema.partial().extend({
	blockImages: z.boolean().optional(),
	blockVideos: z.boolean().optional(),
});
export type ContentFiltersPartial = z.infer<typeof ContentFiltersPartialSchema>;

export const ScheduleConfigSchema = z.object({
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

// 同 ContentFiltersPartialSchema:`.partial()` 不剥 `.default()`,per-UP 只覆盖 quietHours 等
// 字段时会被注入 liveEndGrace:false / liveEndGraceMinutes:2。schedule 整段归「直播阈值」section
// 独占,注入默认值虽不跨 section 污染,但会让 override 落盘多出用户没设的字段、并在 resolve merge
// 时强制盖掉全局对应值。override 维度须为无默认纯可选,与全局 ScheduleConfigSchema 分开。
export const ScheduleConfigPartialSchema = ScheduleConfigSchema.partial().extend({
	liveEndGrace: z.boolean().optional(),
	liveEndGraceMinutes: z.number().int().min(1).max(10).optional(),
});
export type ScheduleConfigPartial = z.infer<typeof ScheduleConfigPartialSchema>;

/**
 * 开播推送的设置(⑬d 起自成一段,原先在 `schedule` 里)。`catchUpOnBoot`:启动时发现正在播,补报一次开播 ——
 * 走 `liveStart` 的路由、历史记成开播、**不 @全体**,文字与卡仍用「正在直播」那一套。只有 `liveStart` 开着才补。
 */
export const LiveStartSettingsSchema = z.object({
	catchUpOnBoot: z.boolean(),
});
export type LiveStartSettings = z.infer<typeof LiveStartSettingsSchema>;

// per-UP 那份是「无默认的纯可选」(同 ScheduleConfigPartialSchema 的理由):这一段今天没有 `.default()`,
// `.partial()` 就够;将来谁给全局那份某一格补了 `.default()`,partial 不会剥它 —— 到时照 schedule 的写法
// 在这里 `.extend` 成纯可选,别让 per-UP 落盘多出没设的字段、再在 resolve 里盖掉全局。
export const LiveStartSettingsPartialSchema = LiveStartSettingsSchema.partial();
export type LiveStartSettingsPartial = z.infer<typeof LiveStartSettingsPartialSchema>;

/**
 * 周期「正在直播」的设置(⑬d 起自成一段,原先在 `schedule` 里)。开关是 `features.liveStreaming`、目标是
 * `routing.liveStreaming`;这里只有间隔:整数小时,1–24。旧的「0 = 关」交给开关。
 */
export const LiveStreamingSettingsSchema = z.object({
	streamingIntervalHours: z.number().int().min(1).max(24),
});
export type LiveStreamingSettings = z.infer<typeof LiveStreamingSettingsSchema>;

// 同 LiveStartSettingsPartialSchema:per-UP 那份无默认的纯可选。
export const LiveStreamingSettingsPartialSchema = LiveStreamingSettingsSchema.partial();
export type LiveStreamingSettingsPartial = z.infer<typeof LiveStreamingSettingsPartialSchema>;

/**
 * 醒目留言的设置(㉓d 起自成一段,原先是 `filters.minScPrice`)。`minAmount`:低于它不推,按人民币元算,别的币种放行
 * (见 `packages/live` 的 `superchatPassesMinAmount`);没配 = 不设门槛,0 与没配是一回事。
 */
export const SuperchatSettingsSchema = z.object({
	minAmount: z.number().min(0).optional(),
});
export type SuperchatSettings = z.infer<typeof SuperchatSettingsSchema>;

// per-UP 那份:这一段没有 `.default()`,`.partial()` 就是它本身(同 LiveStartSettingsPartialSchema 的写法)。覆盖里写 0 的意思
// 是「这个订阅不设门槛」,全局可能不是 0,所以 0 要原样存。
export const SuperchatSettingsPartialSchema = SuperchatSettingsSchema.partial();
export type SuperchatSettingsPartial = z.infer<typeof SuperchatSettingsPartialSchema>;

/**
 * 会员的设置(㉓d 起自成一段,原先是 `filters.minGuardLevel`)。`minRank`:按体系 id 记一个最低档,事件的档(`tier.rank`,
 * 从 1 起、1 最低)低于它就不推。**某个体系没写 = 那个体系全推**。B 站的体系 id 是 `guard`:`{ guard: 2 }` = 提督以上。
 * 没有 rank 的体系(档位由主播自定)没有门槛可配,只能开或关(特性开关)。
 */
export const MembershipSettingsSchema = z.object({
	minRank: z.record(z.string(), z.number().int().min(1)).optional(),
});
export type MembershipSettings = z.infer<typeof MembershipSettingsSchema>;

// per-UP 那份:同上无默认;`minRank` 在 resolve 里**按体系逐键合并**,订阅只改了 `guard` 不会把别的体系的门槛冲掉。
export const MembershipSettingsPartialSchema = MembershipSettingsSchema.partial();
export type MembershipSettingsPartial = z.infer<typeof MembershipSettingsPartialSchema>;

/** 一条会员文案:文字加图片(两格都是整串,图片是地址)。体系默认用满两格;某一档只写改过的那一格。 */
export const MembershipTemplateEntrySchema = z.object({
	template: z.string(),
	imageUrl: z.string(),
});
export type MembershipTemplateEntry = z.infer<typeof MembershipTemplateEntrySchema>;

/**
 * 一个会员体系的文案(㉓d,原先 B 站专属的 `guardBuy`)。`templates.membership` 是体系 id → 这一份。
 *
 * - `enabled`:用不用自定义文案与图片。`false` 时引擎走内置那条路(官方图 / 出卡),推不推由特性开关管。默认 false。
 * - `default`:体系默认。每一档没单独配的格都用它;图片也空时回落该档自己的徽章。
 * - `tiers`:按档的 key 存只改过的那几档与那几格(取法见 `membershipTemplateOf`)。`custom` 体系(档位由主播自定)也存在这里,
 *   key 就是档名。
 */
export const MembershipTemplateBundleSchema = z.object({
	enabled: z.boolean().default(false),
	default: MembershipTemplateEntrySchema,
	tiers: z.record(z.string(), MembershipTemplateEntrySchema.partial()).default({}),
});
export type MembershipTemplateBundle = z.infer<typeof MembershipTemplateBundleSchema>;

export const TemplateBundleSchema = z.object({
	liveStart: z.string(),
	liveStreaming: z.string(),
	liveEnd: z.string(),
	liveSummary: z.string(),
	/**
	 * 作品推送文本模板(非视频作品)。变量:`{name}` UP 名;链接是消息版式的独立部件,
	 * 不是模板变量。`.default(...)` 让缺 post 字段的老 globals.json
	 * (本字段加入前写入的)仍能通过 schema 校验 —— 与下方 imageGroup 同源的老配置兜底策略;
	 * 默认值直接取 `DEFAULT_TEMPLATES`,不另抄一份(抄的那份 2026-08 漂过一次)。
	 */
	post: z.string().default(DEFAULT_TEMPLATES.post),
	/** 视频投稿推送文本模板。变量:`{name}` UP 名;链接同上。 */
	postVideo: z.string().default(DEFAULT_TEMPLATES.postVideo),
	/**
	 * 弹幕词云的额外停用词,英文逗号分隔,**追加**到内置中文停用词表后再分词。
	 * `.default("")` 让缺该字段的老 globals.json 仍能通过 schema 校验(与 post /
	 * postVideo 同源的老配置兜底)。per-UP override 经 merge 替换全局值,在该 UP
	 * 的词云生成时额外过滤(详见 packages/live room-session dispatch)。
	 */
	wordcloudStopWords: z.string().default(""),
	specialDanmaku: z.string(),
	specialUserEnter: z.string(),
	/** 会员文案,按体系 id 存(B 站的体系叫 `guard`)。形状见 {@link MembershipTemplateBundleSchema}。 */
	membership: z.record(z.string(), MembershipTemplateBundleSchema),
});
export type TemplateBundle = z.infer<typeof TemplateBundleSchema>;

// `.partial()` 只把顶层字段变可选,**不剥离内层 `.default()`** —— 直接 partial 会让
// per-UP override 解析 `{ templates: { liveSummary } }` 时把 post/postVideo
// 注入成默认值,被下游(buildDynamicSubViewSingle / isSectionCustomized)误当成真有
// per-UP 作品模板覆盖:该 UP 停止跟随全局作品模板热更、面板误标「已定制」、保存时
// 把注入字段落盘。override 维度的 post/postVideo 必须是「无默认的纯可选」,
// 与全局 TemplateBundleSchema(带 .default 供 globals.json 缺字段回填)分开。
export const TemplateBundlePartialSchema = TemplateBundleSchema.partial().extend({
	post: z.string().optional(),
	postVideo: z.string().optional(),
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
	 * 以服务商名当桶键,开新代时由迁移器按键名盖章(`apps/server/src/migration/ai.ts`)。
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
	// 这里曾有一格 `temperature`(默认 0.7),已整个退役:请求里一律不发、走服务商默认
	// —— 推理模型收到它直接 400。老桶里残留的值被本 schema 剥掉(裸 z.object,未知键
	// strip,不会整份拒收);想调的主人写进下面的 extraParams。
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
		.default(() => ({
			backend: "bocha" as const,
			keys: { bocha: "", tavily: "" },
			engines: { dynamic: false, live: false, roast: false },
		})),
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
	 * 备着的人格清单。**按约定恒非空** —— 出厂默认就是内置那几份,0.x 预设上线前的 `presets: []` 由迁移器
	 * 补齐(`apps/server/src/migration/ai.ts`),设置页又删不掉最后一份,所以设置页不必为「一份都没有」留分支。
	 * schema 自己不拦空数组:手改配置写得进来,那时 `resolveActivePersona` 回落 `ai.persona`。
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

/**
 * AI 设置。0.x 的老形状(扁平连接字段、「一家一桶」、手改的人格、预设上线前的 `presets: []`)由迁移器
 * 改写(`apps/server/src/migration/ai.ts`),这里只认新形状。
 */
export const AISettingsSchema = AISettingsObjectSchema;
export type AISettings = z.infer<typeof AISettingsSchema>;

const CardStyleObjectSchema = z.object({
	/**
	 * 卡片图片渲染功能总开关。关闭后,push 流程会跳过图片生成,仅发送文本回退。
	 * 默认 true 以兼容老数据文件;独立端的 puppeteer 适配器仍按 `bootstrap.chromePath`
	 * 是否注入决定能不能渲染,这个 flag 是 *用户意图* 层。
	 */
	enabled: z.boolean().default(true),
	/**
	 * **退役字段**(2026-09-14 主人拍板,同玻璃那次):字体归**皮肤自己的旋钮**。
	 * 理由是它在皮肤底下多半不生效 —— 皮肤只要写一句 `font-family` 就盖掉了它,而面板
	 * 照样让人选(赛博朋克那套正是如此)。本来说好由开机迁移把它搬进 `cardSkinKnobs`,
	 * 那个迁移已于 2026-09-18 整个退役(ADR-0014 决策 17 的 🔗):没人再搬它,存量值
	 * 按定案直接作废 —— 升级上来的一律用出厂默认皮肤,想换字体请拧那套皮肤的字体旋钮。
	 * ⛔ 新代码不许读它。保持 `.optional()`、不补回 `.default(...)`:退役字段不该由我们
	 * 往新配置里写回去。
	 *
	 * 字体家族名。`packages/image` 的 `renderCard` 在它后面追加
	 * `"Microsoft YaHei","Source Han Sans","Noto Sans CJK",sans-serif` 兜底链,
	 * 缺字体不会渲染崩。`.default(...)` 让缺该字段的老 globals.json 加载时自动补全。
	 *
	 * 独立端的设置页已改成**字体选择器**,交出来的是单个家族名(空串 = 只走兜底链);
	 * 逗号列表只会来自老配置与「手填(高级)」那一档,`cssFontFamily` 会逐项处理。
	 * 想用主人自己的字体文件走下面的 `fontAsset`,它优先。
	 */
	font: z.string().optional(),
	/**
	 * **退役字段**(同上面的 `font`):搬进字体旋钮时写成 `upload:<id>`。⛔ 新代码不许读它。
	 *
	 * 主人上传的字体文件资产 id(与卡片背景图同一套「落盘 + id 引用 +
	 * 渲染期解析成 data URL」形态)。
	 *
	 * 设了就**优先于 `font`**:渲染期由服务端读盘拼成 `@font-face` 内联给模版。指向一个
	 * 已被删掉的资产时静静回落 `font` —— 与背景图同一条纪律,不让一次删除把出图弄崩。
	 */
	fontAsset: z.string().optional(),
	// 🪦 `backgroundImages`(以及更老的单值 `backgroundImage`)2026-09-20 整条链**删干净**。
	// 背景图 2026-09-14 退役成皮肤自己的 `image` 旋钮(值走 `--bn-knob-wallpaper`),
	// 2026-09-19 起全仓零条 CSS 再读 `--bn-card-bg-image` —— 字段留着只是喂一条谁都不读的
	// 入参链。本 schema **不是 `.strict()`**,存量 globals.json / 订阅覆盖里的这两个键
	// 解析时静静剥掉,不会像皮肤清单那样整份拒收。⛔ 别把它加回来。
	/**
	 * 直播卡自定义封面图资产 id **列表**(独立端专属,复用卡片背景同一图廊)。空列表
	 * (默认)= 沿用 B 站房间封面 / 关键帧;长度 1 = 固定单张;长度 >1 = 每次推送顺序
	 * 轮换(游标与背景图同一 rotator,key 维度独立)。仅对 live 卡有意义,其余卡忽略。
	 */
	liveCoverImages: z.array(z.string()).default([]),
	/**
	 * **退役字段**(ADR-0014 决策 16 的 🔗,2026-09-14 主人拍板):玻璃片归**皮肤自己的旋钮**
	 * (默认皮肤声明 `glass-opacity` / `glass-blur` 两枚),不再是用户配置项。本来说好由
	 * 开机迁移把值搬进 `globals.defaults.cardSkinKnobs`,那个迁移已于 2026-09-18 整个退役
	 * (ADR-0014 决策 17 的 🔗):没人再搬它,存量值按定案直接作废,升级上来的一律用出厂
	 * 默认皮肤。
	 *
	 * 于是当初认下的代价还要再大一档:玻璃从前能按卡种 / 按 UP 分别覆盖,如今连全局那一份
	 * 都不搬了。想调玻璃就调皮肤的旋钮 —— 给某位 UP 单独调的话,在卡片页切到他、拧他那一侧的
	 * 旋钮(per-UP 旋钮覆盖 `overrides.cardSkinKnobs`,ADR-0014 决策 17 的 🔗,2026-09-24;在那
	 * 之前只能复制一套皮肤挂给他)。按卡种分开调仍然归皮肤作者:多声明一枚旋钮。
	 *
	 * ⛔ 新代码不许读这两个字段。出图的玻璃在皮肤的块 CSS 里。
	 */
	glassOpacity: z.number().min(0).max(1).optional(),
	/**
	 * 退役字段,见上面 `glassOpacity`。`.optional()` 而不是从前的 `.default(false)`:当初
	 * 是为了让开机迁移判得出「搬过没有」,迁移 2026-09-18 退役(ADR-0014 决策 17 的 🔗)
	 * 之后理由换成更简单的一条 —— 退役字段不该由我们往新配置里写回去。
	 */
	glassClear: z.boolean().optional(),
});

/**
 * 卡片样式。0.x 退役的 `hideDesc` / `hideFollower` 不用专门处理:本 schema 不是 `.strict()`,存量值读的时候
 * 自己剥掉(守卫在 `card-style.test.ts`)。
 */
export const CardStyleSchema = CardStyleObjectSchema;
export type CardStyle = z.infer<typeof CardStyleSchema>;

// `.partial()` 只把字段变可选,**不剥离内层 `.default()`**(与 ContentFilters /
// ScheduleConfig / TemplateBundle 三个 PartialSchema 同源问题):CardStyleObjectSchema
// 有带 default 的字段,per-UP 只覆盖一个字段(如 glassOpacity)时,partial 会把
// `enabled:true` / `liveCoverImages:[]` 一并注入。resolve() 的
// merge(defaults.cardStyle, ov.cardStyle) 视其为「已覆盖」而盖掉全局自定义值 ——
// 最严重:全局 enabled=false(关图片渲染)被注入的 true 悄悄翻开。故它们在 override
// 维度必须是「无默认的纯可选」,与全局 CardStyleObjectSchema(带 .default 供
// globals.json 缺字段回填)分开。
//
// 下面 `.extend()` 的单子从前是 7 个,今天**只有 enabled 与 liveCoverImages 两条是承重的**
// ——`font` 自己已经是 optional(留着是照着全局那张表逐条对,少一条就是下一个洞),
// `showPopularity` / `showArea` / `showFans` 随旧版式整个退役(ADR-0014 决策 17 的
// 2026-09-18 🔗),`glassClear` 是 2026-09-14 那次退役的,`backgroundImages` 2026-09-20
// 整条链删掉。
export const CardStylePartialSchema = CardStyleObjectSchema.partial().extend({
	enabled: z.boolean().optional(),
	font: z.string().optional(),
	liveCoverImages: z.array(z.string()).optional(),
});
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
	blockReposts: false,
	blockArticles: false,
	blockImages: false,
	blockVideos: false,
	blockKeywords: [],
	blockRegex: [],
	allowKeywords: [],
	allowRegex: [],
};

export const DEFAULT_SCHEDULE: ScheduleConfig = {
	quietHours: [],
	liveEndGrace: false,
	liveEndGraceMinutes: 2,
};

/** 出厂:启动时不补报(与拆键前的出厂行为一致)。 */
export const DEFAULT_LIVE_START: LiveStartSettings = { catchUpOnBoot: false };

/** 出厂:每小时一次(旧的「间隔 0 = 关」换成开关 `features.liveStreaming`,出厂关;间隔填 1)。 */
export const DEFAULT_LIVE_STREAMING: LiveStreamingSettings = { streamingIntervalHours: 1 };

/** 出厂:醒目留言不设门槛(没配 = 全推)。 */
export const DEFAULT_SUPERCHAT_SETTINGS: SuperchatSettings = {};

/** 出厂:每个会员体系都不设门槛(某体系没写 = 那个体系全推)。 */
export const DEFAULT_MEMBERSHIP_SETTINGS: MembershipSettings = {};

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
