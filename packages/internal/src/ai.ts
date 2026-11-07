import { packageText } from "./texts/index";
/**
 * AI 服务商、思考档位、人格与锐评定时配置的零依赖词表和解析函数。
 *
 * 零依赖:只许 `import type`,值级 import 只能指向零依赖名单里的同伴。
 * 面板与 contract 经 `@bilibili-notify/internal/ai` 取值。
 */

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
	"bailian",
	"deepseek",
	"custom",
] as const;
export type AIProviderId = (typeof AI_PROVIDER_IDS)[number];

/** 配置面上统一的三档思考深度,各家在适配层各自映射。 */
export const THINKING_LEVELS = ["low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * 实例桶的「接口风味」—— 同一家服务商的两套 wire 协议。`chat` 在前作默认位:
 * 老配置零迁移,谁都不会被静默换协议。`responses` 是 OpenAI 2025 起的接任协议,
 * 思考在那边是一等公民(`reasoning.effort` 与三档天然对齐),不再走各家方言。
 */
export const API_FLAVOR_IDS = ["chat", "responses"] as const;
export type APIFlavorId = (typeof API_FLAVOR_IDS)[number];

/**
 * 联网搜索的后端。与 AI 服务商是**两个正交的选择**:搜索不走各家 LLM 的原生
 * 联网方言(分裂且 DeepSeek 官方压根没有),而是我们自己的 `web_search` 工具,
 * 由这里选定的后端真正执行 —— 所以任何支持 function calling 的服务商都能联网。
 */
export const WEB_SEARCH_BACKEND_IDS = ["bocha", "tavily"] as const;
export type WebSearchBackendId = (typeof WEB_SEARCH_BACKEND_IDS)[number];

export interface WebSearchBackendMeta {
	id: WebSearchBackendId;
	/** 配置面上的显示名。 */
	label: string;
	/** 申请 key 的入口,只作提示。 */
	keyUrl: string;
}

export const WEB_SEARCH_BACKENDS: readonly WebSearchBackendMeta[] = [
	// 博查在前:B 站语境下中文搜索质量是主场景。
	{
		id: "bocha",
		get label() {
			return packageText("internal.ai.1");
		},
		keyUrl: "https://open.bochaai.com",
	},
	{ id: "tavily", label: "Tavily", keyUrl: "https://app.tavily.com" },
];

/** 按 id 取搜索后端元数据。id 只可能来自 zod 校验过的配置,不做兜底。 */
export function webSearchBackendMeta(id: WebSearchBackendId): WebSearchBackendMeta {
	// biome-ignore lint/style/noNonNullAssertion: 枚举封闭,zod 已挡住未知 id
	return WEB_SEARCH_BACKENDS.find((b) => b.id === id)!;
}

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
	 * 这家有没有 **Responses API**(`/responses`,OpenAI 2025 起的接任协议)。
	 * 决定设置页「接口风味」选项露不露 —— 未确认支持的家不开放,免得选出
	 * 必然 404 的组合;日后他们支持了,这里改一行即可。2026-08 核实:
	 * DeepSeek 生产级、百炼 qwen3-max 系、OpenRouter beta;硅基/火山未见。
	 * custom 恒 true:能力未知时不替主人做减法(OpenAI 官方正是经此接入)。
	 */
	supportsResponses: boolean;
	/**
	 * 流式 chat completions 要**显式**发 `stream_options: { include_usage: true }`
	 * 才在末尾给一块 token 用量吗。只影响请求形状(用量日志靠它),不上设置页。
	 *
	 * 2026-09 按各家文档核实:百炼、火山方舟写明流式默认不带 usage、要这个参数开;
	 * DeepSeek 不开也给(挂在最后一个内容块上);OpenRouter 总是自动带,该参数已
	 * 标废弃;硅基流动文档里没有这个参数、也没写流式 usage,不发。custom 为 false ——
	 * 与看图那条「未知就当支持」方向相反:那边是少摆一个开关,这边是多发一个参数,
	 * 未知网关不认它就 400,白撞一次回落非流式。
	 */
	streamUsageNeedsOptIn: boolean;
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
		supportsResponses: true,
		streamUsageNeedsOptIn: false,
		baseUrlHint: "https://openrouter.ai/api/v1",
	},
	{
		id: "volcengine",
		get label() {
			return packageText("internal.ai.2");
		},
		supportsThinking: true,
		thinkingDefaultsOn: true,
		supportsVision: true,
		supportsResponses: false,
		streamUsageNeedsOptIn: true,
		baseUrlHint: "https://ark.cn-beijing.volces.com/api/v3",
	},
	{
		id: "siliconflow",
		get label() {
			return packageText("internal.ai.3");
		},
		supportsThinking: true,
		thinkingDefaultsOn: true,
		supportsVision: true,
		supportsResponses: false,
		streamUsageNeedsOptIn: false,
		baseUrlHint: "https://api.siliconflow.cn/v1",
	},
	{
		id: "bailian",
		get label() {
			return packageText("internal.ai.4");
		},
		supportsThinking: true,
		// 百炼的默认按**模型**分:qwen-plus / qwen-flash / qwen3-max 默认关,
		// qwen3.7+ 商业版与开源版默认开。填 true 让「关」位显式发 enable_thinking:false
		// —— 对默认开的模型这是唯一能关掉的路,对默认关的模型这个字段也合法无害。
		thinkingDefaultsOn: true,
		supportsVision: true,
		supportsResponses: true,
		streamUsageNeedsOptIn: true,
		baseUrlHint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
	},
	{
		id: "deepseek",
		label: "DeepSeek",
		supportsThinking: true,
		thinkingDefaultsOn: true,
		supportsVision: false,
		supportsResponses: true,
		streamUsageNeedsOptIn: false,
		baseUrlHint: "https://api.deepseek.com",
	},
	{
		id: "custom",
		get label() {
			return packageText("internal.ai.5");
		},
		supportsThinking: false,
		thinkingDefaultsOn: false,
		supportsVision: true,
		supportsResponses: true,
		streamUsageNeedsOptIn: false,
		get baseUrlHint() {
			return packageText("internal.ai.6");
		},
	},
];

/** 查不到就落到兜底档,永远返回一个可用的 meta。 */
export function providerMeta(id: AIProviderId): AIProviderMeta {
	return AI_PROVIDERS.find((p) => p.id === id) ?? AI_PROVIDERS[AI_PROVIDERS.length - 1];
}

/**
 * 这份实例能不能开「深度思考」—— chat 风味看这家有没有适配过的方言
 * (`supportsThinking`),responses 风味一律解禁:那套协议里思考是标准字段
 * (`reasoning.effort`),不再是「方言未知不敢发」。
 *
 * **谓词只能有这一份。**它曾在三处各手抄一遍(聊天胶囊 / 实例编辑器 /
 * 「AI 聊天」设置块),第三处漏掉 responses 解锁 —— 胶囊点得亮、服务端真在
 * 发思考参数,设置页却藏起档位还宣称「不会发」。
 */
export function canProfileThink(p: { provider: AIProviderId; apiFlavor?: APIFlavorId }): boolean {
	return providerMeta(p.provider).supportsThinking || (p.apiFlavor ?? "chat") === "responses";
}

/**
 * 一家服务商的整套配置(与 `schema/common.ts#AiProviderProfileSchema` 同形)。
 * 类型声明在这里而不是 schema 里,是为了让**零依赖**的 {@link resolveAIProfile}
 * 也能用上 —— 设置页经 `@bilibili-notify/internal/ai` 子路径运行时消费它,不能把 zod 拖进前端 bundle。
 */
export interface AiProviderProfileShape<S = string> {
	/**
	 * 这桶配置属于哪家服务商 —— 决定「开思考」翻译成哪家方言。桶键只是**实例 id**
	 * (同一家可以有多份实例),方言归属必须写在桶里,不能再从键名推。
	 */
	provider: AIProviderId;
	/** 实例的显示名。空串 = 用注册表里那家的名字(避免把家名抄进配置,改名会过期)。 */
	label: string;
	/** 密钥格的类型 `S`:后端是明文 `string`,面板读到的是遮挡(`SecretCellView`),见 contract。 */
	apiKey: S;
	baseUrl: string;
	model: string;
	/** 这桶走哪套 wire 协议。默认 `chat`;能否选 `responses` 见 {@link AIProviderMeta.supportsResponses}。 */
	apiFlavor: APIFlavorId;
	enableThinking: boolean;
	thinkingLevel: ThinkingLevel;
	extraParams: string;
	enableVision: boolean;
	vision: { baseUrl: string; apiKey: S; model: string };
}

/**
 * 一套「什么都没配」的档案。**必须与 `AiProviderProfileSchema` 的各字段默认值逐一
 * 一致** —— 那边有一条测试拿 `parse({})` 与这里比深等,写歪了会当场红。
 */
export const EMPTY_AI_PROVIDER_PROFILE: AiProviderProfileShape = {
	provider: "custom",
	label: "",
	apiKey: "",
	baseUrl: "",
	model: "",
	apiFlavor: "chat",
	enableThinking: false,
	thinkingLevel: "medium",
	extraParams: "",
	enableVision: false,
	vision: { baseUrl: "", apiKey: "", model: "" },
};

/**
 * 取当前生效的那一套配置。
 *
 * `activeProfile` 指向的实例可能不存在(主人刚把它删掉、配置是手改的、或者这就是
 * 一份全新配置),这时返回一套**空默认值**而不是 undefined:调用方拿到空 `model` 会按
 * 既有规矩判定「还没配齐」并停用 AI —— 那是它们本来就处理得了的情形;返回
 * undefined 则会在各处炸出读属性的 TypeError。
 *
 * 对残缺入参也不炸(`providers` 整个缺席时同样兜空档案) —— 它同时服务于前端的
 * 局部状态与后端的完整配置,前者在数据还没到齐时就会渲染。
 */
export function resolveAIProfile<S = string>(ai: {
	activeProfile?: string;
	providers?: Record<string, AiProviderProfileShape<S> | undefined>;
}): AiProviderProfileShape<S | string> {
	return aiProfileAt(ai.providers, ai.activeProfile ?? "") ?? EMPTY_AI_PROVIDER_PROFILE;
}

/**
 * 按实例 id 取 AI 实例表里**自己的**那一家;表里没有(或表整个缺席)回 `undefined`。
 *
 * id 来自指针或请求体时一律经它取,别下标直读:id 写成 `constructor` 这类原型名时,直读会取到原型上的
 * 函数,一个根本没有的实例就被当成「有」。
 */
export function aiProfileAt<P>(
	providers: Record<string, P | undefined> | undefined,
	id: string,
): P | undefined {
	return providers && Object.hasOwn(providers, id) ? providers[id] : undefined;
}

/**
 * AI 聊天此刻用的思考**等级**。
 *
 * `ai.chat` 与实例桶里的那两格是**分了家的**:桶里的管自动生成(点评 / 总结 / 锐评),
 * `ai.chat` 管聊天页。chat 里没写等级就跟随当前实例(「初始默认值从女仆读取」),
 * 写过就压过实例、从此互不牵动。方言翻译仍按当前实例的 `provider` 走。
 *
 * 只剩**等级**没有开关:聊天的思考开关是**会话级**的(输入框旁那颗胶囊,默认关、
 * 手动开、不落盘),按消息走请求体 —— 配置里没有它的位置。
 */
export function resolveChatThinkingLevel<S = string>(ai: {
	activeProfile?: string;
	providers?: Record<string, AiProviderProfileShape<S> | undefined>;
	chat?: { thinkingLevel?: ThinkingLevel };
}): ThinkingLevel {
	return ai.chat?.thinkingLevel ?? resolveAIProfile(ai).thinkingLevel;
}

/**
 * 一份人格(与 `schema/common.ts#AiPersonaSettingsSchema` 同形)。类型声明在这里的理由与
 * {@link AiProviderProfileShape} 一样:让下面那个**零依赖**的解析函数能直供浏览器端。
 */
export interface AiPersonaSettingsShape {
	name: string;
	addressUser: string;
	addressSelf: string;
	traits: string;
	catchphrase: string;
	baseRole: string;
	extraSystemPrompt: string;
}

/** 人格库里的一份 —— 两段 prompt 缺席 = 「用内置首份的那段」。 */
export interface AIPresetShape {
	id: string;
	persona: AiPersonaSettingsShape;
	dynamicPrompt?: string;
	liveSummaryPrompt?: string;
}

/** 当前生效的那份人格与它的两段 prompt。 */
export interface ActivePersonaShape {
	persona: AiPersonaSettingsShape;
	dynamicPrompt: string;
	liveSummaryPrompt: string;
}

/** 内置人格的形状:两段提示词齐全、带名字。`texts/builtin/index.ts` 的 `BuiltinPreset` 与它同形。 */
export interface AIBuiltinPresetShape extends AIPresetShape {
	label: string;
	dynamicPrompt: string;
	liveSummaryPrompt: string;
}

/**
 * 人格左栏 / 候选清单 —— 内置没被删的 + 主人自己的(ADR-0037 决策 11)。
 *
 * 设置里只记「删了哪几份内置」(`removedBuiltinPresets`,缺 = 一份没删)与主人自己建的(`presets`);
 * 内置的内容**每次按当前语言取**,由调用方把当前语言的 `builtins` 传进来(它们的顺序就是内置的顺序)。
 * `presets` 里若混进内置 id 的条目(只有老代的盘会有,迁移会拆掉),以内置为准、那一份不进列表;
 * `removedBuiltinPresets` 里认不得的 id 直接忽略。
 */
export function presetsOf<B extends AIBuiltinPresetShape, P extends AIPresetShape>(
	ai: { removedBuiltinPresets?: readonly string[]; presets?: readonly P[] },
	builtins: readonly B[],
): (B | P)[] {
	const removed = new Set(ai.removedBuiltinPresets ?? []);
	const builtinIds = new Set(builtins.map((b) => b.id));
	return [
		...builtins.filter((b) => !removed.has(b.id)),
		...(ai.presets ?? []).filter((p) => !builtinIds.has(p.id)),
	];
}

/**
 * 全局此刻用的是哪份人格 —— **「当前用哪份」只能有这一个读法**。
 *
 * `activePreset` 是指着 {@link presetsOf} 清单里某一份的指针。谁绕开这个函数自己去翻 `presets`,
 * 谁那条路上就看不见内置那几份(它们不在设置里),也不会跟着语言变 —— 常驻 generator、试一句、锐评与聊天窗
 * 抬头四处都经它。
 *
 * 指针落空 —— 没填、或指着一份刚被删掉 / 备份换掉的 —— 静静回落清单第一份;清单空了(内置全删光、
 * 主人也没建)回落内置首份。两段 prompt 逐段回落:这份里缺席 = 「用内置首份的那段」,不是「发一段空的」。
 * @param builtins 当前语言的内置人格,至少一份。
 */
export function resolveActivePersona(
	ai: {
		activePreset?: string;
		removedBuiltinPresets?: readonly string[];
		presets?: readonly AIPresetShape[];
	},
	builtins: readonly AIBuiltinPresetShape[],
): ActivePersonaShape {
	const list = presetsOf(ai, builtins);
	const first = builtins[0] as AIBuiltinPresetShape;
	const active =
		(ai.activePreset ? list.find((p) => p.id === ai.activePreset) : undefined) ?? list[0] ?? first;
	return {
		persona: active.persona,
		dynamicPrompt: active.dynamicPrompt ?? first.dynamicPrompt,
		liveSummaryPrompt: active.liveSummaryPrompt ?? first.liveSummaryPrompt,
	};
}

// ── 锐评定时推送 ──────────────────────────────────────────────────────────────
// 住在这里而不是 `schema/roast-schedule.ts`:配置页要拿它们做输入提示,而
// `apps/web` 不能把 zod 拉进浏览器 bundle —— 从那个文件 import 就会。

/** 锐评统计窗口下界。schema 校验与 `apps/server` 的取数共用,别在两处各定一份。 */
export const ROAST_MIN_DAYS = 1;
/** 锐评统计窗口上界。取数与 AI prompt 都按这个上界设计。 */
export const ROAST_MAX_DAYS = 90;
/** 定时锐评的默认 cron —— 每周一早九点,「周报」最符合直觉的那档,用户可改。 */
export const DEFAULT_ROAST_CRON = "0 9 * * 1";
/** 默认统计窗口,与默认 cron 的一周间隔对齐。周期与窗口本身是解耦的两个字段。 */
export const DEFAULT_ROAST_DAYS = 7;

/**
 * 一条**关着**的定时锐评配置。
 *
 * 住在这里而不是 schema 文件:`apps/web` 造空订阅时要用它,而那个文件 import 了
 * zod —— 从那儿取一份默认值就把 zod 拉进浏览器 bundle 了。schema 侧拿它当
 * `.default()`,两边同一份。
 *
 * `enabled: false` 是硬要求:存量用户升级上来,不该有任何东西开始自己往群里发帖。
 */
export const DEFAULT_ROAST_SCHEDULE = {
	enabled: false,
	cron: DEFAULT_ROAST_CRON,
	days: DEFAULT_ROAST_DAYS,
	targets: [] as string[],
	approval: false,
	notifyOnError: true,
} as const;
