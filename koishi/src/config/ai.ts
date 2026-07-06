import type { PersonaKey } from "@bilibili-notify/ai";
import { DEFAULT_AI } from "@bilibili-notify/internal";
import { Schema } from "koishi";

export interface PersonaConfig {
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

	/** 开启模型的思考模式（仅 Qwen3 等支持 enable_thinking 的模型有效） */
	enableThinking?: boolean;

	/** 开启模型内置的联网搜索（仅 SiliconFlow 等支持 enable_search 的提供商有效） */
	enableSearch?: boolean;

	/** 开启多模态图片理解，动态点评及对话时将图片一并传给模型（需模型支持视觉能力） */
	enableVision?: boolean;
}

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

			enableThinking: Schema.boolean()
				.default(false)
				.description(
					"开启模型的深度思考模式～不过要模型支持 enable_thinking 参数才行（比如 Qwen3），不支持的话女仆会自动降级，不会报错的 (๑•̀ㅂ•́)و✧",
				),

			enableSearch: Schema.boolean()
				.default(false)
				.description(
					"开启模型自带的联网搜索功能～不过要提供商支持 enable_search 参数才行哦（比如 SiliconFlow）",
				),

			enableVision: Schema.boolean()
				.default(false)
				.description(
					"开启多模态图片理解～点评动态或聊天时，女仆会把图片也一起交给模型看看（前提是模型自己要支持视觉能力哟）",
				),
		}),
		Schema.object({}),
	]),
]);
