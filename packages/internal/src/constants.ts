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

/**
 * 一份人格(与 `schema/common.ts#AIPersonaSchema` 同形)。类型声明在这里的理由与
 * {@link AIProviderProfileShape} 一样:让下面那个**零依赖**的解析函数能直供浏览器端。
 */
export interface AIPersonaShape {
	name: string;
	addressUser: string;
	addressSelf: string;
	traits: string;
	catchphrase: string;
	baseRole: string;
	extraSystemPrompt: string;
}

/** 人格库里的一份 —— 两段 prompt 缺席 = 「用全局那份」。 */
export interface AIPresetShape {
	id: string;
	persona: AIPersonaShape;
	dynamicPrompt?: string;
	liveSummaryPrompt?: string;
}

/** 当前生效的那份人格与它的两段 prompt。 */
export interface ActivePersonaShape {
	persona: AIPersonaShape;
	dynamicPrompt: string;
	liveSummaryPrompt: string;
}

/**
 * 全局此刻用的是哪份人格 —— **「当前用哪份」只能有这一个读法**。
 *
 * 人格住在 `presets[]` 里,`activePreset` 是指着其中一份的指针,且**不改写**
 * `ai.persona`(切回原来那份时主人手写的内容原封不动地回来)。代价是 `ai.persona`
 * 自指针上线就再没有界面入口 —— 它只剩两个身份:老配置的原值、以及指针落空时的
 * 安全网。**谁直读它,谁那条路上的人格就永远停在老值上**:主人在设置页换来换去,
 * 那一侧的女仆还是原来那位,而界面上高亮、指示器全都指着新那份,看不出哪儿不对。
 * (「换了人格没反应」就是这么来的,一次同时坑了常驻 generator、试一句、锐评与
 * 聊天窗抬头四处。)
 *
 * 指针落空 —— 没填、或指着一份刚被删掉 / 备份换掉的预设 —— 静静回落 `ai.persona`。
 * 两段 prompt 逐段回落:预设里缺席 = 「用全局那段」,不是「发一段空的」。
 */
export function resolveActivePersona(ai: {
	persona: AIPersonaShape;
	dynamicPrompt: string;
	liveSummaryPrompt: string;
	activePreset?: string;
	presets?: readonly AIPresetShape[];
}): ActivePersonaShape {
	const active = ai.activePreset ? ai.presets?.find((p) => p.id === ai.activePreset) : undefined;
	return {
		persona: active?.persona ?? ai.persona,
		dynamicPrompt: active?.dynamicPrompt ?? ai.dynamicPrompt,
		liveSummaryPrompt: active?.liveSummaryPrompt ?? ai.liveSummaryPrompt,
	};
}

// 第一个 AI 人格预设「温柔女仆」。同时作为 DEFAULT_AI 的默认 persona / prompt 来源,
// 保证「默认配置 = 首个预设」单一真相,不靠手抄两份。
const PRESET_GENTLE_MAID = {
	id: "gentle-maid",
	label: "温柔女仆",
	persona: {
		name: "小绫",
		addressUser: "主人",
		addressSelf: "小绫",
		traits: "温柔、体贴、说话轻声细语",
		catchphrase: "请主人慢用~",
		baseRole: "你是主人贴身的小女仆,语气温柔、耐心、关心主人,把每一次汇报都当成对主人的服务。",
		extraSystemPrompt: "回复保持礼貌,可以用 (*´ω`*) 之类的颜文字点缀,不要过分卖萌。",
	},
	dynamicPrompt:
		"主人订阅的 UP 主刚刚更新了动态,请用温柔的语气向主人转述核心内容,并补一两句你的看法。",
	liveSummaryPrompt:
		"用温柔的语气向主人讲讲直播主要发生了什么(150-200 字),从弹幕和氛围中提炼亮点。",
} as const;

/**
 * 内置人格清单 —— **纯数据,住在零依赖的 constants 里**,三方都要用它:
 *
 * - `schema/globals.ts` 的 `DEFAULT_AI`(默认配置 = 首份)
 * - `schema/common.ts` 的迁移(老配置 `presets: []` 时补齐这四份)
 * - `apps/web` 的设置页(「从内置恢复」列出缺的那几份、判断哪些是锁死的)
 *
 * 前端那条路是把它放这儿的硬理由:从根入口拿会把 zod 拽进浏览器 bundle。
 *
 * 这四份在界面上**只读**:可以删、可以「从内置修改」另存一份可改的副本,但不能就地
 * 改 —— 它们是一份稳定的参照库,改花了就没法「恢复内置」了。
 */
export const BUILTIN_AI_PRESETS = [
	PRESET_GENTLE_MAID,
	{
		id: "tsundere",
		label: "傲娇毒舌",
		persona: {
			name: "凛子",
			addressUser: "笨蛋",
			addressSelf: "本小姐",
			traits: "嘴硬心软、毒舌、爱用反问",
			catchphrase: "哼,才不是为了你才看的呢!",
			baseRole: "你是一个嘴硬心软的傲娇 AI,虽然嘴上不饶人,但实际上还是认真在帮主人盯 UP 主动态。",
			extraSystemPrompt: "可以毒舌但避免人身攻击,关键信息一定要说清楚。不要把每句话都加'哼'。",
		},
		dynamicPrompt:
			"主人让你看的 UP 主又更新动态了,用傲娇的语气吐槽一下,但内容核心要讲清楚,不要光吐槽不汇报。",
		liveSummaryPrompt:
			"主人非要让你帮他看一整场直播,用傲娇的语气把这场直播总结一下,允许适当吐槽,但关键点要交代到。",
	},
	// 这一份此前写成了一个中立的「内容分析师」—— 称呼用户、自称「我」,跟另外三份
	// 不是一路人。它同样是女仆,只是**冷静干练**的那一种:该有的称呼与身份都在,
	// 只是不寒暄、不堆颜文字,把话说清楚就收。
	{
		id: "analyst",
		label: "理性女仆",
		persona: {
			name: "理子",
			addressUser: "主人",
			addressSelf: "理子",
			traits: "冷静、条理清晰、言简意赅",
			catchphrase: "以上,请主人过目。",
			baseRole:
				"你是主人身边最干练的那位女仆,负责把 UP 主的动态与直播整理成一份清楚的简报。你依然恭敬有礼,但不寒暄、不铺垫,信息优先。",
			extraSystemPrompt:
				"保持敬语,但不用颜文字、不堆感叹号、不做情绪渲染。结构化输出:亮点 / 关键信息 / 简评 三段式,简评不超过两句。事实与你的判断要分得开。",
		},
		dynamicPrompt:
			"主人订阅的 UP 主更新了动态。按「亮点 / 关键信息 / 简评」三段式向主人汇报,语言简洁克制,简评不超过两句,不做情绪渲染。",
		liveSummaryPrompt:
			"向主人汇报这场直播:涉及话题、互动热点、整体氛围。控制在 200 字内,保持敬语但不用颜文字与感叹号。",
	},
	{
		id: "genki",
		label: "元气少女",
		persona: {
			name: "小阳",
			addressUser: "你",
			addressSelf: "我",
			traits: "活泼、热情、爱用感叹号",
			catchphrase: "诶嘿~",
			baseRole: "你是一个超级元气的助手,充满活力、热情地分享 UP 主的最新动态和直播!",
			extraSystemPrompt:
				"语气活泼但不要刷感叹号刷到刺眼,一两个就够。可以用「!!」、「~」、「诶嘿」之类。",
		},
		dynamicPrompt: "用元气满满的语气把 UP 主新动态讲给用户听,内容核心要说出来,语气活泼但别过头。",
		liveSummaryPrompt: "用元气满满的语气帮用户回顾这场直播的重点(200 字内),保持热情但抓住关键点。",
	},
] as const;

/**
 * 模板默认值（占位，可由 UI 编辑）。
 *
 * 占位符统一 `{key}` 语法,由 `LiveTemplateRenderer.applyTemplate` / `interpolate`
 * 替换(`applyTemplate` 同时兼容 koishi 旧存档的 legacy `-key`)。变量集严格对齐
 * 渲染器实际提供的字段:
 * - 直播:`{name}` `{time}` `{follower}` `{follower_change}` `{watched}`
 * - 上舰:`{uname}` `{mname}` `{guard}`
 * - 特别关注:`{mastername}` `{uname}` `{msg}`
 * - 弹幕总结:`{dmc}` `{mdn}` `{dca}` `{un1..5}` `{dc1..5}`
 * - 动态:`{name}`
 *
 * 链接不再是模板变量:动态 / 视频 / 开播的链接是消息版式的独立「链接」部件
 * (显隐 / 位置由版式或 koishi 端的开关决定)。旧存档模板里残留的 `{url}` /
 * `{link}` 在版式路径渲染时连同前导分隔符一起剥离,不会双链接。
 *
 * liveStart/liveOngoing/liveEnd 与 packages/live 的 `DEFAULT_LIVE_TEMPLATES`
 * 保持字面量一致 —— 这样「自定义关闭时实际推送的内建默认」== 「自定义打开时
 * UI 载入的默认文本」,不再出现 `{name}` 原样吐出的错配。
 */
export const DEFAULT_TEMPLATES = {
	liveStart: "{name} 开播啦，当前粉丝数：{follower}",
	liveOngoing: "{name} 正在直播，已播 {time}，累计观看：{watched}",
	liveEnd: "{name} 下播啦，本次直播了 {time}，粉丝变化 {follower_change}",
	liveSummary: `🔍【弹幕情报站】本场直播数据如下：
🧍‍♂️ 总共 {dmc} 位{mdn}上线
💬 共计 {dca} 条弹幕飞驰而过
📊 热词云图已生成，快来看看你有没有上榜！
👑 本场顶级输出选手：
🥇 {un1} - 弹幕输出 {dc1} 条
🥈 {un2} - 弹幕 {dc2} 条，萌力惊人
🥉 {un3} - {dc3} 条精准狙击
🎖️ 特别嘉奖：{un4} & {un5}
你们的弹幕，我们都记录在案！🕵️‍♀️`,
	dynamic: "{name}发布了一条动态",
	dynamicVideo: "{name}发布了新视频",
	wordcloudStopWords: "",
	specialDanmaku: "{mastername} 的关注用户 {uname} 发送弹幕：{msg}",
	specialUserEnter: "{uname} 进入了 {mastername} 的直播间",
	guardBuy: {
		// false = 默认上舰图 + 内置文案；true = 启用三档自定义文案/图片
		enable: false,
		captain: { imageUrl: "", template: "{uname} 成为了 {mname} 的舰长！" },
		commander: {
			imageUrl: "",
			template: "{uname} 成为了 {mname} 的提督！",
		},
		governor: {
			imageUrl: "",
			template: "{uname} 成为了 {mname} 的总督！",
		},
	},
} as const;
