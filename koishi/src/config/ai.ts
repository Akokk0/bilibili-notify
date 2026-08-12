import type { PersonaKey } from "@bilibili-notify/ai";
import {
	AI_PROVIDERS,
	type AIProviderId,
	DEFAULT_AI,
	type ThinkingLevel,
	type WebSearchBackendId,
} from "@bilibili-notify/internal";
import { Schema } from "koishi";
import { providerExtraFields } from "./provider-fields";

interface PersonaConfig {
	/** 基础人格预设 */
	preset: PersonaKey;
	/** AI 名字，留空则跟随预设默认值 */
	name?: string;
	/** 称呼用户的方式，如：主人、老爷、哥哥。留空则跟随预设 */
	addressUser?: string;
	/** AI 的自称，如：女仆、本大小姐、我。留空则跟随预设 */
	addressSelf?: string;
	/** 性格特点，逗号分隔，如：温柔,活泼,有点黏人。留空则跟随预设 */
	traits?: string;
	/** 口头禅，留空则跟随预设 */
	catchphrase?: string;
	/** preset 为 custom 时的基础描述，定义 AI 的核心角色 */
	customBase?: string;
	/** 追加到任何预设末尾的额外提示词（高级） */
	extraPrompt?: string;
}

/**
 * `apiKey`/`baseURL`/... 等字段只在 `enabled: true` 分支下由 Schema.union 强制填好,
 * 因此全部标为可选 —— 与 push.ts 里 `MasterConfig` 的 `platform?`/`masterAccount?`
 * 同一约定(条件必填字段在 TS interface 里统一放宽为 optional,真正的必填校验交给
 * Schema.union,不强行搭一套判别式联合类型)。
 */
export interface AIConfig {
	enabled: boolean;
	logLevel?: number;
	apiKey?: string;
	baseURL?: string;
	model?: string;

	/** 结构化人格配置 */
	persona?: PersonaConfig;

	/** 动态点评时追加到人格提示词之后的场景说明 */
	dynamicPrompt?: string;
	/** 直播总结时追加到人格提示词之后的场景说明 */
	liveSummaryPrompt?: string;

	/** 开启后，bili chat 指令将记忆对话历史 */
	enableConversation?: boolean;
	/** 多轮对话保留的最大历史轮次（每轮=一问一答） */
	maxHistory?: number;

	/**
	 * 服务商。决定「开思考」翻译成哪家的方言 —— 四家四种写法，没有通用解。
	 * **只认主人明确选的那一个，绝不按 baseURL 猜**：猜错等于替主人往别家发方言
	 * 参数，几乎必然 400，而且主人选了「自定义」却被地址悄悄改回去时无从下手。
	 * 留空落 `custom`（不发任何方言参数，等价于这套适配上线之前的行为）。
	 */
	provider?: AIProviderId;

	/** 开启模型的深度思考。具体发什么字段由 {@link provider} 决定。 */
	enableThinking?: boolean;

	/** 思考深度，统一三档，各家在适配层各自映射。 */
	thinkingLevel?: ThinkingLevel;

	/** 主人手写的一段 JSON，原样摊进请求体顶层。方言适配的兜底口。 */
	extraParams?: string;

	/** 开启多模态图片理解，动态点评及对话时将图片一并传给**主模型**（需主模型支持视觉能力） */
	enableVision?: boolean;

	/**
	 * 专门看图的副模型。填了 `model` 即启用，此后图一律先经它转成文字，主模型
	 * 全程只吃纯文本 —— 为的是 DeepSeek 这类根本没有视觉模型的主力。
	 * baseURL / apiKey 留空则继承主模型的。
	 */
	visionBaseURL?: string;
	visionApiKey?: string;
	visionModel?: string;

	/**
	 * 联网搜索(`web_search` 工具)。与选哪家 AI 服务商**正交**:搜索由这里选定的
	 * 后端真正执行,任何支持 function calling 的服务商都能用上 —— 不走各家 LLM
	 * 的原生联网方言(分裂且 DeepSeek 官方压根没有)。
	 */
	webSearchBackend?: WebSearchBackendId;
	/** 博查的 API Key。两家各存一格,换后端不丢另一家的。 */
	webSearchBochaKey?: string;
	/** Tavily 的 API Key。 */
	webSearchTavilyKey?: string;
	/** 动态点评允许联网搜索。默认关 —— 搜索按次付费,自动路径必须主人亲手点亮。 */
	webSearchDynamic?: boolean;
	/** 直播总结允许联网搜索。默认关,理由同上。 */
	webSearchLive?: boolean;
}

/**
 * 深度思考那两项。做成工厂而不是共享常量 —— 同一个 Schema 实例摆进多条 union 分支
 * 是自找麻烦(描述/默认值的归属会含混),各分支各造一份最省心。
 */
const thinkingFields = () => ({
	enableThinking: Schema.boolean()
		.default(false)
		.description(
			"开启模型的深度思考模式～女仆会按上面选的服务商发对应的参数。要是那家网关不认，女仆会自动摘掉参数重试一次，不会报错的。两件事要知道：① DeepSeek、火山、硅基和百炼的思考模型**默认就是开着**的，关掉这个开关女仆才会显式让它别想那么久；② 部分服务商（如 DeepSeek）思考时会**忽略** temperature，那不是设置没存上哟 (｡･ω･｡)",
		),
	thinkingLevel: Schema.union([
		Schema.const("low" as const).description("低 — 快，够用就行"),
		Schema.const("medium" as const).description("中 — 默认"),
		Schema.const("high" as const).description("高 — 慢且贵，留给难题"),
	])
		.default("medium")
		.description(
			"想让女仆想多深呢？各家的档位不一样（OpenRouter 是 low/medium/high，DeepSeek 只有 high/max，火山、硅基和百炼是 token 预算），女仆会自动换算成那家的说法 (｡･ω･｡)ﾉ♡",
		),
});

/** 「主模型自己看得见图吗」。 */
const visionToggleField = () => ({
	enableVision: Schema.boolean()
		.default(false)
		.description(
			"**主模型自己看得见图吗**？这个开关是在回答这个问题，不是在选「把图发给谁」哟。看得见（gpt-4o、qwen-vl 这类）就打开，点评动态或聊天时女仆会把图直接交给它，省一次往返也不掉细节。注意：一旦填了下面的「看图专用模型」，就一律以它为准，这个开关不再起作用 (｡･ω･｡)",
		),
});

/**
 * 按服务商分支 —— **选了哪家就只显哪家真有的那几项**。
 *
 * 摆一个那家根本不支持的开关,主人调了没反应只会以为配置坏了:兜底档的思考开关是死的
 * (不发任何方言参数),DeepSeek 的「主模型看图」永远为否(官方接口无视觉模型)。
 * 分支内容由 `providerExtraFields` 说了算,那边有单测;这里只是把清单摊开。
 *
 * 末尾那条空分支是兜底:`enabled: false` 时 `provider` 根本没渲染、取值为 undefined,
 * 没有任何一条具名分支匹配得上,少了它整个 union 就无处可落。
 */
const ProviderBranchSchema = Schema.union([
	...AI_PROVIDERS.map((p) => {
		const fields = providerExtraFields(p.id);
		return Schema.object({
			provider: Schema.const(p.id).required(),
			...(fields.includes("thinking") ? thinkingFields() : {}),
			...(fields.includes("vision") ? visionToggleField() : {}),
		});
	}),
	Schema.object({}),
]);

const PersonaConfigSchema: Schema<PersonaConfig> = Schema.intersect([
	Schema.object({
		preset: Schema.union([
			"assistant",
			"maid",
			"tsundere",
			"commentator",
			"critic",
			"custom",
		] as const)
			.default("maid")
			.description(
				"主人想让 AI 扮演什么角色呢？assistant（专业助理）、maid（温柔女仆，女仆自己就是这个哟～）、tsundere（傲娇）、commentator（弹幕解说员）、critic（犀利评论家）、custom（完全自定义，想怎么捏都可以）(๑•̀ㅂ•́)و✧",
			),
		name: Schema.string().description(
			"给 AI 起个专属的名字吧～留空的话就跟随预设默认值咯（比如女仆预设默认名叫「梦梦」）(〃´-`〃)♡",
		),
		addressUser: Schema.string().description(
			"AI 要怎么称呼主人呢？比如主人、老爷、哥哥都可以～留空就乖乖跟随预设啦",
		),
		addressSelf: Schema.string().description(
			"AI 要怎么称呼自己呢？女仆、本大小姐、我……都随主人喜欢～留空则跟随预设哒",
		),
		traits: Schema.string().description(
			"性格特点，用逗号隔开就好，比如：温柔,活泼,有点黏人～会追加在预设特点上或者直接覆盖掉哦 (〃ﾉωﾉ)",
		),
		catchphrase: Schema.string().description(
			"口头禅～比如「才不是为了你呢！」这种～留空的话就乖乖跟随预设啦",
		),
		extraPrompt: Schema.string().description(
			"偷偷追加在系统提示词最后面的小纸条，可以用来微调 AI 的行为哦（进阶功能，不太熟悉的话先别乱动～）",
		),
	}).description("人格配置"),
	Schema.union([
		Schema.object({
			preset: Schema.const("custom").required(),
			customBase: Schema.string()
				.required()
				.description(
					"完全自定义时的基础角色描述，会替换掉预设自带的那份哦～写清楚点，AI 才知道该怎么演呢 (｀・ω・´)b",
				),
		}),
		Schema.object({}),
	]),
]);

export const AIConfigSchema: Schema<AIConfig> = Schema.intersect([
	Schema.object({
		enabled: Schema.boolean()
			.default(false)
			.description(
				"要不要让女仆帮忙生成 AI 点评 / 直播总结呢？开启前记得先把下面的 API Key 填好哦～需要 OpenAI 兼容接口 (๑•̀ㅂ•́)و✧",
			),
	}).description("AI 点评 / 总结"),
	Schema.union([
		Schema.object({
			enabled: Schema.const(true).required(),

			logLevel: Schema.number()
				.min(1)
				.max(3)
				.step(1)
				.default(1)
				.description(
					"这里可以设置日志等级喔～3 是最详细的调试信息，1 是只显示错误信息。主人可以根据需要选择合适的等级，让女仆更好地为您服务 (๑•̀ㅂ•́)و✧",
				),

			apiKey: Schema.string()
				.role("secret")
				.required()
				.description("OpenAI 兼容 API 的访问密钥～这个要保管好哦，不能随便给别人看到的 (๑•ᴗ•๑)"),

			baseURL: Schema.string()
				.default("https://api.siliconflow.cn/v1")
				.description("API 地址～只要是 OpenAI 兼容接口，随便哪一家女仆都能试着连连看 (๑•̀ㅂ•́)و✧"),

			model: Schema.string()
				.default("Qwen/Qwen3-8B")
				.description("要用哪个模型呢？把名字告诉女仆就好啦～"),

			persona: PersonaConfigSchema,

			dynamicPrompt: Schema.string()
				.default(DEFAULT_AI.dynamicPrompt)
				.description(
					"点评动态的时候，女仆会把这段说明追加在人格提示词后面，让点评更贴合场景 (｀・ω・´)b",
				),

			liveSummaryPrompt: Schema.string()
				.default(DEFAULT_AI.liveSummaryPrompt)
				.description("生成直播总结的时候，同样会追加在人格提示词后面哦，场景交给女仆来补充～"),

			enableConversation: Schema.boolean()
				.default(true)
				.description(
					"开启后 `bili chat` 就能记住之前聊过的内容啦～可以愉快地多轮连续对话咯 (｡･ω･｡)ﾉ♡",
				),

			maxHistory: Schema.number()
				.min(1)
				.max(50)
				.step(1)
				.default(10)
				.description(
					"多轮对话最多帮主人记住几轮呢？（一轮 = 一问一答）记太多女仆会脑袋不够用的 (＞﹏＜)",
				),

			provider: Schema.union(AI_PROVIDERS.map((p) => Schema.const(p.id).description(p.label)))
				.default("custom")
				.description(
					"你用的是哪家服务商呀？「开思考」这件事各家写法完全不一样（OpenRouter 用 reasoning、火山和 DeepSeek 用 thinking、硅基和百炼用 enable_thinking），女仆得知道是哪家才翻译得对哟 (๑•̀ㅂ•́)و✧ 选「自定义」的话女仆不会自作主张发任何参数，需要什么请写到下面的「额外请求参数」里",
				),

			extraParams: Schema.string()
				.role("textarea", { rows: [3, 8] })
				.default("")
				.description(
					'额外请求参数～一段 JSON，女仆会原样摊进请求体里。适配之外的服务商专属参数写这里，比如百炼的 `{"enable_search": true}`（阿里自家的联网）或 OpenRouter 的 `{"plugins": [{"id": "web"}]}`。要联网搜索的话建议直接用下面的「联网搜索」配置（各家通用），别两头都开——那等于每次都搜两遍。跟女仆自己发的参数撞了以你为准；写错了也不要紧，那一次就当没填（日志里会说一声）。model / messages / tools 这几个是请求的骨架，改了会让对话或工具失灵，女仆会挡掉',
				),

			visionModel: Schema.string().description(
				"看图专用模型～有些主力模型压根没有视觉能力（DeepSeek 官方接口里一个视觉模型都没有呢），填上这里之后，图片会先交给它转成文字描述，再把描述交给主模型，主模型全程只看文字就够啦 (๑•̀ㅂ•́)و✧ 留空则不启用，图片按上面那个开关的老规矩走",
			),

			visionBaseURL: Schema.string().description(
				"看图专用模型的 API 地址～留空就跟着主模型的用（硅基流动、OpenRouter 这类聚合网关上主模型和视觉模型同一个地址，那就不用填哦）",
			),

			visionApiKey: Schema.string()
				.role("secret")
				.description("看图专用模型的密钥～留空同样跟着主模型的用，只有换了一家服务商才需要单独填"),

			webSearchBackend: Schema.union([
				Schema.const("bocha" as const).description("博查 — 中文搜索质量好"),
				Schema.const("tavily" as const).description("Tavily — 有免费额度"),
			])
				.default("bocha")
				.description(
					"联网搜索的执行后端～女仆的 web_search 工具由这家真正执行，跟上面选哪家 AI 服务商没有关系，DeepSeek 官方也能联网哦。博查在 open.bochaai.com 申请，Tavily 在 app.tavily.com（每月有免费额度）(๑•̀ㅂ•́)و✧",
				),

			webSearchBochaKey: Schema.string()
				.role("secret")
				.description("博查的 API Key～留空 = 不用博查。两家的 key 各存一格，换来换去不会丢"),

			webSearchTavilyKey: Schema.string()
				.role("secret")
				.description("Tavily 的 API Key～留空 = 不用 Tavily"),

			webSearchDynamic: Schema.boolean()
				.default(false)
				.description(
					"动态点评时允许女仆联网搜索～碰到不认识的事件或梗她会先搜一两次再点评。**按次计费**且每条点评可能多几秒延迟，所以默认是关着的，主人想清楚再开哦",
				),

			webSearchLive: Schema.boolean()
				.default(false)
				.description("直播总结时允许女仆联网搜索～注意事项同上，默认关"),
		}),
		Schema.object({}),
	]),
	// 按服务商分支的那一层。摆在 intersect 最后 —— `enabled: false` 时 provider 取值
	// 为 undefined,没有任何具名分支匹配,整层落到那条空兜底,于是一项都不多显。
	ProviderBranchSchema,
]);
