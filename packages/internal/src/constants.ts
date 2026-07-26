/**
 * 纯常量模块 —— 必须保持**零 import、零副作用**:它经 `@bilibili-notify/internal/constants`
 * 子路径直供浏览器端(apps/web / astrbot/page)运行时消费,不能把 zod 或任何 schema
 * 模块拽进前端 bundle。schema/common.ts 反向引用这里(`z.enum(FEATURE_KEYS)`)并从根
 * 入口重导出,后端消费者(koishi / sidecar / server)照旧从根入口拿 —— 两条路径同一份值。
 */

/** 全部可订阅的特性键。新增或删除会扩散到 FeatureFlags、SubscriptionRouting、Subscription.overrides。 */
export const FEATURE_KEYS = [
	"dynamic",
	"live",
	"liveEnd",
	"liveGuardBuy",
	"superchat",
	"wordcloud",
	"liveSummary",
	"specialDanmaku",
	"specialUserEnter",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

/** 默认全局值；resolve() 在 per-UP overrides 缺失字段时回退到这里。 */
export const DEFAULT_FEATURE_FLAGS: Record<FeatureKey, boolean> = {
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

// ---------------------------------------------------------------------------
// AI 服务商注册表
// ---------------------------------------------------------------------------

/**
 * 已适配方言的服务商;`custom` 是兜底,不发任何方言参数,只认主人手写的额外参数。
 *
 * 这份注册表两端共享:服务端据它把「开思考」翻译成各家写法(见
 * `@bilibili-notify/ai#buildProviderParams`),前端据 `supportsThinking` 决定要不要
 * 显示思考开关。放在这里而不是 packages/ai,是因为 apps/web 只依赖 internal。
 */
export const AI_PROVIDER_IDS = [
	"openrouter",
	"volcengine",
	"siliconflow",
	"deepseek",
	"custom",
] as const;
export type AIProviderId = (typeof AI_PROVIDER_IDS)[number];

/** 配置面上统一的三档思考深度,各家在适配层各自映射。 */
export const THINKING_LEVELS = ["low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface AIProviderMeta {
	id: AIProviderId;
	/** 配置面上的显示名。 */
	label: string;
	/** 这家是否吃我们适配过的思考参数。custom 为 false —— 它只走额外参数。 */
	supportsThinking: boolean;
	/**
	 * 这家**默认就开着思考**吗。决定了开关的「关」位要不要显式发一条禁用 ——
	 * 默认关的家发了纯属多余风险,默认开的家不发则等于这个开关根本关不掉。
	 */
	thinkingDefaultsOn: boolean;
	/**
	 * 这家的接口里有没有**能看图的模型**。
	 *
	 * DeepSeek 官方 API 一个都没有 —— 那边「主模型支持看图」是个永远为否的问题,
	 * 不该摆出来让人勾。这不只是少显示一个开关:发图守卫也据此判断,否则勾着它
	 * 发图会一路走到模型那儿才被拒,白烧一次请求。
	 *
	 * 兜底档一律 `true`:能力未知时不替主人做减法。
	 */
	supportsVision: boolean;
	/**
	 * 开思考时这家会**静默忽略** temperature(以及 top_p / presence_penalty /
	 * frequency_penalty)。DeepSeek 官方文档明说不报错也不生效 —— 摆着让人调,
	 * 只会让主人以为设置没存上。
	 */
	temperatureIgnoredWhenThinking: boolean;
	/** 配置面上的参考地址,只作提示,不自动填。 */
	baseUrlHint: string;
}

export const AI_PROVIDERS: readonly AIProviderMeta[] = [
	{
		id: "openrouter",
		label: "OpenRouter",
		supportsThinking: true,
		thinkingDefaultsOn: false,
		supportsVision: true,
		temperatureIgnoredWhenThinking: false,
		baseUrlHint: "https://openrouter.ai/api/v1",
	},
	{
		id: "volcengine",
		label: "火山方舟",
		supportsThinking: true,
		thinkingDefaultsOn: true,
		supportsVision: true,
		temperatureIgnoredWhenThinking: false,
		baseUrlHint: "https://ark.cn-beijing.volces.com/api/v3",
	},
	{
		id: "siliconflow",
		label: "硅基流动",
		supportsThinking: true,
		thinkingDefaultsOn: true,
		supportsVision: true,
		temperatureIgnoredWhenThinking: false,
		baseUrlHint: "https://api.siliconflow.cn/v1",
	},
	{
		id: "deepseek",
		label: "DeepSeek",
		supportsThinking: true,
		thinkingDefaultsOn: true,
		supportsVision: false,
		temperatureIgnoredWhenThinking: true,
		baseUrlHint: "https://api.deepseek.com",
	},
	{
		id: "custom",
		label: "自定义",
		supportsThinking: false,
		thinkingDefaultsOn: false,
		supportsVision: true,
		temperatureIgnoredWhenThinking: false,
		baseUrlHint: "任何 OpenAI 兼容地址",
	},
];

/** 查不到就落到兜底档,永远返回一个可用的 meta。 */
export function providerMeta(id: AIProviderId): AIProviderMeta {
	return AI_PROVIDERS.find((p) => p.id === id) ?? AI_PROVIDERS[AI_PROVIDERS.length - 1];
}

/**
 * 一家服务商的整套配置(与 `schema/common.ts#AIProviderProfileSchema` 同形)。
 * 类型声明在这里而不是 schema 里,是为了让**零依赖**的 {@link resolveAIProfile}
 * 也能用上 —— 设置页经 `/constants` 子路径运行时消费它,不能把 zod 拖进前端 bundle。
 */
export interface AIProviderProfileShape {
	apiKey: string;
	baseUrl: string;
	model: string;
	temperature: number;
	enableThinking: boolean;
	thinkingLevel: ThinkingLevel;
	extraParams: string;
	enableVision: boolean;
	vision: { baseUrl: string; apiKey: string; model: string };
}

/**
 * 一套「什么都没配」的档案。**必须与 `AIProviderProfileSchema` 的各字段默认值逐一
 * 一致** —— 那边有一条测试拿 `parse({})` 与这里比深等,写歪了会当场红。
 */
export const EMPTY_AI_PROVIDER_PROFILE: AIProviderProfileShape = {
	apiKey: "",
	baseUrl: "",
	model: "",
	temperature: 0.7,
	enableThinking: false,
	thinkingLevel: "medium",
	extraParams: "",
	enableVision: false,
	vision: { baseUrl: "", apiKey: "", model: "" },
};

/**
 * 取当前生效的那一套配置。
 *
 * `provider` 指向的桶可能不存在(主人刚把它删掉、配置是手改的、或者这就是一份
 * 全新配置),这时返回一套**空默认值**而不是 undefined:调用方拿到空 `model` 会按
 * 既有规矩判定「还没配齐」并停用 AI —— 那是它们本来就处理得了的情形;返回
 * undefined 则会在各处炸出读属性的 TypeError。
 *
 * 对残缺入参也不炸(`providers` 整个缺席时同样兜空档案) —— 它同时服务于前端的
 * 局部状态与后端的完整配置,前者在数据还没到齐时就会渲染。
 */
export function resolveAIProfile(ai: {
	provider?: AIProviderId;
	providers?: Partial<Record<AIProviderId, AIProviderProfileShape>>;
}): AIProviderProfileShape {
	const id = ai.provider ?? "custom";
	return ai.providers?.[id] ?? EMPTY_AI_PROVIDER_PROFILE;
}
