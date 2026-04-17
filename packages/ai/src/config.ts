import { Schema } from "koishi";
import type { PersonaKey } from "./persona-presets";

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

export interface BilibiliNotifyAIConfig {
	logLevel: number;
	apiKey: string;
	baseURL: string;
	model: string;

	/** 结构化人格配置 */
	persona: PersonaConfig;

	/** 动态点评时追加到人格提示词之后的场景说明 */
	dynamicPrompt: string;
	/** 直播总结时追加到人格提示词之后的场景说明 */
	liveSummaryPrompt: string;

	/** 开启后，bili chat 指令将记忆对话历史 */
	enableConversation: boolean;
	/** 多轮对话保留的最大历史轮次（每轮=一问一答） */
	maxHistory: number;
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
				"基础人格预设：assistant（专业助理）、maid（温柔女仆）、tsundere（傲娇）、commentator（弹幕解说员）、critic（犀利评论家）、custom（完全自定义）",
			),
		name: Schema.string().description(
			"AI 的名字，留空则跟随预设默认值（如女仆预设默认名为「梦梦」）",
		),
		addressUser: Schema.string().description(
			"AI 称呼用户的方式，如：主人、老爷、哥哥。留空则跟随预设",
		),
		addressSelf: Schema.string().description("AI 的自称，如：女仆、本大小姐、我。留空则跟随预设"),
		traits: Schema.string().description(
			"性格特点，用逗号分隔，如：温柔,活泼,有点黏人。追加到预设特点之上或完全覆盖",
		),
		catchphrase: Schema.string().description("口头禅，如：才不是为了你呢！留空则跟随预设"),
		extraPrompt: Schema.string().description(
			"追加到系统提示词末尾的额外内容，可用于微调行为（高级）",
		),
	}).description("人格配置"),
	Schema.union([
		Schema.object({
			preset: Schema.const("custom").required(),
			customBase: Schema.string()
				.required()
				.description("完全自定义时的基础角色描述，替代预设的基础描述"),
		}),
		Schema.object({}),
	]),
]);

export const BilibiliNotifyAIConfigSchema: Schema<BilibiliNotifyAIConfig> = Schema.object({
	logLevel: Schema.number()
		.min(1)
		.max(3)
		.step(1)
		.default(1)
		.description("日志等级：1=仅错误，2=信息，3=调试详情"),

	apiKey: Schema.string()
		.role("secret")
		.required()
		.description("OpenAI 兼容 API 的访问密钥（API Key）"),

	baseURL: Schema.string()
		.default("https://api.siliconflow.cn/v1")
		.description("API 地址，支持任何 OpenAI 兼容接口"),

	model: Schema.string().default("Qwen/Qwen3-8B").description("使用的模型名称"),

	persona: PersonaConfigSchema,

	dynamicPrompt: Schema.string()
		.default("请根据以上动态内容，用简短幽默的语言写一句话点评，不超过两句")
		.description("点评动态时追加在人格提示词之后的场景说明"),

	liveSummaryPrompt: Schema.string()
		.default(
			"请根据以上弹幕数据，保持角色风格，生成一段有趣的直播总结，突出热词亮点和弹幕排行，控制在200字以内",
		)
		.description("生成直播总结时追加在人格提示词之后的场景说明"),

	enableConversation: Schema.boolean()
		.default(true)
		.description("开启后，bili chat 指令将记忆对话历史，实现多轮连续对话"),

	maxHistory: Schema.number()
		.min(1)
		.max(50)
		.step(1)
		.default(10)
		.description("多轮对话最多保留的历史轮次数（每轮包含一问一答）"),
});
